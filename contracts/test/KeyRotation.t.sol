// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {Fixture} from "./Fixture.sol";

/// @notice SPEC.md §15 key rotation: a participant moves to a new signing key in one registry change. The new
/// key is admitted under the same participant and the old one retired to a holding address, which keeps what it
/// holds for the participant but signs nothing; every role the participant held, in the registry and on every
/// token, moves with it, because roles follow the participant's active signing keys.
contract KeyRotationTest is Fixture {
    address internal bankA2;
    uint256 internal bankA2Key;

    function setUp() public override {
        super.setUp();
        (bankA2, bankA2Key) = makeAddrAndKey("bank-a/key-2");
        _fund(bankA, 1_000_00);
    }

    function _signDigest(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function _rotate(bytes32 id, address oldKey, uint256 oldPk, address newKey, uint256 newPk) internal {
        bytes32 hash = registry.rotationDigest(id, oldKey, newKey);
        vm.prank(cb);
        registry.rotateKey(id, oldKey, newKey, _signDigest(oldPk, hash), _signDigest(newPk, hash));
    }

    function test_theNewKeySignsAndTheOldOneHoldsWhatItHeld() public {
        _rotate(BANK_A, bankA, bankAKey, bankA2, bankA2Key);
        assertEq(registry.signerOf(bankA2), BANK_A);
        assertEq(registry.signerOf(bankA), bytes32(0));
        // The retired key still belongs to Bank A: its balance is Bank A's, moved only with Bank A's approval.
        assertEq(registry.participantOf(bankA), BANK_A);
        assertEq(registry.rotations(BANK_A), 1);
        assertTrue(wcad.canSend(bankA));

        // The old key can neither submit nor approve.
        SettlementEngine.Instruction memory pay = _instruction(_move(wcad, bankA, bankB, 10_00));
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotASubmitter.selector, bankA));
        engine.settle(pay, _none());
        SettlementEngine.Approval[] memory byOld = _one(_sign(bankA, bankAKey, pay));
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidApproval.selector, bankA));
        engine.settle(pay, byOld);

        // The new key moves the old address's balance for Bank A, as its submitter or by its signature.
        _submit(bankA2, pay, _none());
        assertEq(wcad.balanceOf(bankA), 990_00);
        SettlementEngine.Instruction memory more = _instruction(_move(wcad, bankA, bankB, 5_00));
        _submit(bankB, more, _one(_sign(bankA2, bankA2Key, more)));
        assertEq(wcad.balanceOf(bankB), 15_00);
    }

    function test_everyRoleMovesWithTheKeyInOneChange() public {
        assertTrue(dcadA.hasRole(dcadA.ALLOWLIST_ROLE(), bankA));
        _rotate(BANK_A, bankA, bankAKey, bankA2, bankA2Key);
        bytes32[4] memory roles =
            [dcadA.DEFAULT_ADMIN_ROLE(), dcadA.FREEZER_ROLE(), dcadA.ENFORCER_ROLE(), dcadA.ALLOWLIST_ROLE()];
        for (uint256 i; i < roles.length; ++i) {
            assertFalse(dcadA.hasRole(roles[i], bankA));
            assertTrue(dcadA.hasRole(roles[i], bankA2));
        }
        bytes32 allowlist = dcadA.ALLOWLIST_ROLE();
        vm.prank(bankA);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, bankA, allowlist)
        );
        dcadA.allowHolder(mallory);
        vm.prank(bankA2);
        dcadA.allowHolder(mallory);
        assertTrue(dcadA.canReceive(mallory));
    }

    function test_theRegistrarRotatesItsOwnKeyAndTheRegistrarRoleMovesWithIt() public {
        (address cb2, uint256 cb2Key) = makeAddrAndKey("central-bank/key-2");
        _rotate(CB, cb, cbKey, cb2, cb2Key);
        assertFalse(registry.hasRole(registry.REGISTRAR_ROLE(), cb));
        assertTrue(registry.hasRole(registry.REGISTRAR_ROLE(), cb2));
        assertTrue(wcad.hasRole(wcad.ACCOUNTS_ROLE(), cb2));
        vm.prank(cb);
        vm.expectRevert();
        registry.suspend(BANK_A);
        vm.prank(cb2);
        registry.suspend(BANK_A);
        assertFalse(registry.isActive(BANK_A));
    }

    function test_refusesARotationWithoutBothKeysOrFromAnyoneButTheRegistrar() public {
        bytes32 hash = registry.rotationDigest(BANK_A, bankA, bankA2);
        bytes memory consent = _signDigest(bankAKey, hash);
        bytes memory proof = _signDigest(bankA2Key, hash);

        vm.prank(bankA);
        vm.expectRevert();
        registry.rotateKey(BANK_A, bankA, bankA2, consent, proof);

        vm.startPrank(cb);
        // The new key must prove itself, and the old key consent.
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidRotationSignature.selector, bankA2));
        registry.rotateKey(BANK_A, bankA, bankA2, consent, _signDigest(bankBKey, hash));
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.InvalidRotationSignature.selector, bankA));
        registry.rotateKey(BANK_A, bankA, bankA2, _signDigest(bankA2Key, hash), proof);
        // Only an active signing key of the participant can be rotated away from.
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.NotASigningKey.selector, bankB, BANK_A));
        registry.rotateKey(BANK_A, bankB, bankA2, consent, proof);

        registry.rotateKey(BANK_A, bankA, bankA2, consent, proof);
        // The signatures cannot be used again: the nonce moved, and the old key no longer signs.
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.NotASigningKey.selector, bankA, BANK_A));
        registry.rotateKey(BANK_A, bankA, bankA2, consent, proof);
        vm.stopPrank();
    }

    function test_aHoldingAddressHoldsForItsParticipantAndSignsNothing() public {
        address custody = makeAddr("bank-a/custody");
        vm.prank(cb);
        registry.bindHoldingAddress(BANK_A, custody);
        assertEq(registry.participantOf(custody), BANK_A);
        assertEq(registry.signerOf(custody), bytes32(0));
        assertFalse(dcadA.hasRole(dcadA.FREEZER_ROLE(), custody));

        // Bank A moves wholesale to it and back with its own key; the holding address cannot submit.
        _submit(bankA, _instruction(_move(wcad, bankA, custody, 100_00)), _none());
        SettlementEngine.Instruction memory back = _instruction(_move(wcad, custody, bankA, 100_00));
        vm.prank(custody);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotASubmitter.selector, custody));
        engine.settle(back, _none());
        // Bank B cannot move it: the leg needs Bank A's approval, not the holder's own signature.
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_A));
        engine.settle(back, _none());
        _submit(bankA, back, _none());
        assertEq(wcad.balanceOf(custody), 0);
    }

    function test_aParticipantAddressNeverHoldsTheSettlementRole() public {
        bytes32 settlement = dcadA.SETTLEMENT_ROLE();
        vm.prank(bankA);
        dcadA.grantRole(settlement, bankA);
        assertFalse(dcadA.hasRole(dcadA.SETTLEMENT_ROLE(), bankA));
        assertTrue(dcadA.hasRole(dcadA.SETTLEMENT_ROLE(), address(engine)));
        vm.prank(bankA);
        vm.expectRevert();
        dcadA.settleMint(alice, 1);
    }
}
