// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Bond} from "../src/Bond.sol";
import {ClaimIssuer} from "../src/erc3643/ClaimIssuer.sol";
import {Identity} from "../src/erc3643/Identity.sol";
import {ParticipantRoles} from "../src/erc3643/ParticipantRoles.sol";
import {IdentityRegistryStorage} from "../src/erc3643/IdentityRegistryStorage.sol";
import {IClaimIssuer, IIdentity} from "../src/erc3643/interfaces/IIdentity.sol";
import {
    IAgentRole,
    IClaimTopicsRegistry,
    ICompliance,
    IERC3643,
    IIdentityRegistry,
    IIdentityRegistryStorage,
    ITrustedIssuersRegistry
} from "../src/erc3643/interfaces/IERC3643.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {BondFixture} from "./BondFixture.sol";

/// @notice The bond as an ERC-3643 token (SPEC.md §4.2, §15): it implements the standard's interfaces,
/// refuses a holder without a verified identity, a direct transfer, an agent's mint outside an instruction and
/// a movement to a holder whose claim was revoked, without touching what that holder holds; a bank attests its
/// own customers; and a lost wallet is recovered to a new address with its units.
contract ERC3643Test is BondFixture {
    function setUp() public override {
        super.setUp();
        _issue();
    }

    function _trade(address seller, address buyer, uint256 units)
        internal
        returns (SettlementEngine.Instruction memory i)
    {
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(bond, seller, buyer, units);
        legs[1] = _move(wcad, buyer, seller, units * FACE);
        i = _instruction(legs);
    }

    // ---------------------------------------------------------------- the standard's interfaces

    function test_implementsTheStandardsInterfaces() public view {
        assertTrue(bond.supportsInterface(type(IERC3643).interfaceId));
        IERC3643 token = IERC3643(address(bond));
        assertEq(address(token.identityRegistry()), address(identities));
        assertEq(address(token.compliance()), address(compliance));
        assertEq(token.version(), "1.0.0");
        assertFalse(token.paused());
        assertFalse(token.isFrozen(bankA));
        assertEq(token.getFrozenTokens(bankA), 0);
        assertTrue(token.onchainID() != address(0));
        IIdentityRegistry registry_ = IIdentityRegistry(address(identities));
        assertEq(address(registry_.identityStorage()), address(identityStorage));
        assertEq(address(registry_.topicsRegistry()), address(topics));
        assertEq(address(registry_.issuersRegistry()), address(issuers));
        assertEq(IClaimTopicsRegistry(address(topics)).getClaimTopics()[0], KYC);
        assertEq(ITrustedIssuersRegistry(address(issuers)).getTrustedIssuersForClaimTopic(KYC).length, 3);
        assertEq(
            IIdentityRegistryStorage(address(identityStorage)).linkedIdentityRegistries()[0],
            address(identities)
        );
        assertEq(ICompliance(address(compliance)).getTokenBound(), address(bond));
        assertTrue(IAgentRole(address(identities)).isAgent(bankC));
        assertTrue(bond.isAgent(bankC));
        assertEq(registry_.investorCountry(bankA), CANADA);
    }

    // ---------------------------------------------------------------- refusals

    function test_refusesAHolderWithoutAVerifiedIdentity() public {
        Identity unattested = _identityOf(bankA);
        vm.prank(bankC);
        identities.registerIdentity(alice, IIdentity(address(unattested)), CANADA);
        assertTrue(identities.contains(alice));
        assertFalse(identities.isVerified(alice));
        vm.expectRevert(abi.encodeWithSelector(Bond.ReceiverNotVerified.selector, alice));
        _submit(bankA, _instruction(_move(bond, bankA, alice, 1)), _none());
    }

    function test_refusesADirectTransferAsNotCompliant() public {
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(Bond.TransferNotCompliant.selector, bankA, bankB, 1));
        bond.transfer(bankB, 1);
        vm.prank(bankA);
        bond.approve(bankC, 1);
        vm.prank(bankC);
        vm.expectRevert(abi.encodeWithSelector(Bond.TransferNotCompliant.selector, bankA, bankB, 1));
        bond.transferFrom(bankA, bankB, 1);
        assertEq(bond.balanceOf(bankA), 600);
    }

    function test_refusesAnAgentsMintOrBurnOutsideAnInstruction() public {
        vm.startPrank(bankC);
        vm.expectRevert(abi.encodeWithSelector(Bond.TransferNotCompliant.selector, address(0), bankA, 1));
        bond.mint(bankA, 1);
        vm.expectRevert(abi.encodeWithSelector(Bond.TransferNotCompliant.selector, bankA, address(0), 1));
        bond.burn(bankA, 1);
        vm.stopPrank();
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(Bond.NotAnAgent.selector, bankA));
        bond.mint(bankA, 1);
    }

    function test_aRevokedClaimStopsTheHolderReceivingWithoutTouchingWhatItHolds() public {
        (,,, bytes memory signature,,) = bankBId.getClaim(keccak256(abi.encode(address(cbIssuer), KYC)));
        vm.prank(cb);
        cbIssuer.revokeClaimBySignature(signature);
        assertTrue(cbIssuer.isClaimRevoked(signature));
        assertFalse(identities.isVerified(bankB));

        // Bank B receives no more units...
        SettlementEngine.Instruction memory buy = _trade(bankA, bankB, 100);
        SettlementEngine.Approval[] memory approvals = _approvals(buy, false, true);
        vm.expectRevert(abi.encodeWithSelector(Bond.ReceiverNotVerified.selector, bankB));
        _submit(bankA, buy, approvals);
        // ...but keeps what it holds, sells it, and has it redeemed.
        assertEq(bond.balanceOf(bankB), 400);
        SettlementEngine.Instruction memory sell = _trade(bankB, bankA, 100);
        _submit(bankB, sell, _approvals(sell, true, false));
        assertEq(bond.balanceOf(bankB), 300);
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _burn(bond, bankB, 300);
        legs[1] = _move(wcad, bankC, bankB, 300 * FACE);
        SettlementEngine.Instruction memory redeem = _instruction(legs);
        _submit(bankC, redeem, _approvals(redeem, false, true));
        assertEq(bond.balanceOf(bankB), 0);
    }

    function test_onlyATrustedIssuerForTheTopicVouches() public {
        // Bank A attests a customer: valid, since Bank A is trusted for KYC.
        Identity customer = _identityOf(bankA);
        _attest(bankA, bankAKey, bankAIssuer, customer, bankA);
        vm.prank(bankC);
        identities.registerIdentity(alice, IIdentity(address(customer)), CANADA);
        assertTrue(identities.isVerified(alice));

        // Struck from the trusted issuers, Bank A's word no longer counts.
        vm.prank(bankC);
        issuers.removeTrustedIssuer(IClaimIssuer(address(bankAIssuer)));
        assertFalse(identities.isVerified(alice));

        // A claim another issuer signed cannot be passed off as Bank A's.
        Identity other = _identityOf(bankB);
        bytes memory forged = _claimSignature(bankBKey, other, KYC, "KYC verified");
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(Identity.InvalidClaim.selector, address(cbIssuer), KYC));
        other.addClaim(KYC, 1, address(cbIssuer), forged, "KYC verified", "");
    }

    function test_onlyAnIdentitysManagerManagesIt() public {
        bytes memory signature = _claimSignature(cbKey, bankAId, KYC, "again");
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(Identity.NotAKey.selector, bankB, 3));
        bankAId.addClaim(KYC, 1, address(cbIssuer), signature, "again", "");
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(Identity.NotAKey.selector, bankB, 1));
        bankAId.addKey(keccak256(abi.encode(bankB)), 1, 1);
        // Only a bound identity registry writes the storage, and only an agent registers.
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRoles.NotAnAgent.selector, bankA));
        identities.registerIdentity(mallory, IIdentity(address(bankAId)), CANADA);
        vm.prank(bankC);
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistryStorage.NotABoundRegistry.selector, bankC));
        identityStorage.addIdentityToStorage(mallory, IIdentity(address(bankAId)), CANADA);
    }

    // ---------------------------------------------------------------- the agent's controls

    function test_theAgentFreezesAddressesAndUnits() public {
        vm.startPrank(bankC);
        bond.freezePartialTokens(bankA, 550);
        vm.stopPrank();
        SettlementEngine.Instruction memory tooMuch = _trade(bankA, bankB, 100);
        SettlementEngine.Approval[] memory approvals = _approvals(tooMuch, false, true);
        vm.expectRevert();
        _submit(bankA, tooMuch, approvals);
        SettlementEngine.Instruction memory enough = _trade(bankA, bankB, 50);
        _submit(bankA, enough, _approvals(enough, false, true));

        vm.prank(bankC);
        bond.setAddressFrozen(bankB, true);
        assertTrue(bond.isFrozen(bankB));
        assertFalse(identities.isVerified(bankB) && bond.canReceive(bankB));
        SettlementEngine.Instruction memory toFrozen = _trade(bankA, bankB, 10);
        approvals = _approvals(toFrozen, false, true);
        vm.expectRevert();
        _submit(bankA, toFrozen, approvals);
    }

    function test_aForcedTransferStillNeedsAVerifiedReceiver() public {
        vm.startPrank(bankC);
        vm.expectRevert();
        bond.forcedTransfer(bankA, alice, 1);
        bond.forcedTransfer(bankA, bankB, 10);
        vm.stopPrank();
        assertEq(bond.balanceOf(bankB), 410);
    }

    // ---------------------------------------------------------------- recovery

    function test_recoversALostWalletToANewAddressWithItsUnits() public {
        address replacement = makeAddr("bank-b/replacement");
        vm.prank(bankC);
        bond.freezePartialTokens(bankB, 40);

        // The holder's identity must name the new wallet as a management key first.
        vm.prank(bankC);
        vm.expectRevert(abi.encodeWithSelector(Bond.RecoveryNotAuthorized.selector, replacement));
        bond.recoveryAddress(bankB, replacement, address(bankBId));
        vm.prank(bankB);
        bankBId.addKey(keccak256(abi.encode(replacement)), 1, 1);

        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(Bond.NotAnAgent.selector, bankA));
        bond.recoveryAddress(bankB, replacement, address(bankBId));
        vm.prank(bankC);
        vm.expectRevert(abi.encodeWithSelector(Bond.NotTheHoldersIdentity.selector, bankB, address(bankAId)));
        bond.recoveryAddress(bankB, replacement, address(bankAId));

        vm.prank(bankC);
        bond.recoveryAddress(bankB, replacement, address(bankBId));
        assertEq(bond.balanceOf(bankB), 0);
        assertEq(bond.balanceOf(replacement), 400);
        assertEq(bond.getFrozenTokens(replacement), 40);
        assertEq(address(identities.identity(replacement)), address(bankBId));
        assertFalse(identities.contains(bankB));
        assertTrue(identities.isVerified(replacement));
    }

    // ---------------------------------------------------------------- key rotation

    function test_aRotationMovesIdentityManagementAndKeepsPastClaimsValid() public {
        (address cb2, uint256 cb2Key) = makeAddrAndKey("central-bank/key-2");
        bytes32 hash = registry.rotationDigest(CB, cb, cb2);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(cbKey, hash);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(cb2Key, hash);
        vm.prank(cb);
        registry.rotateKey(CB, cb, cb2, abi.encodePacked(r1, s1, v1), abi.encodePacked(r2, s2, v2));

        // The banks' claims, signed by the retired key, still verify; the retired key signs no new one.
        assertTrue(identities.isVerified(bankA));
        Identity customer = _identityOf(bankA);
        bytes memory late = _claimSignature(cbKey, customer, KYC, "late");
        assertTrue(cbIssuer.isClaimValid(customer, KYC, late, "late"));
        vm.prank(cb);
        vm.expectRevert(abi.encodeWithSelector(Identity.NotAKey.selector, cb, 1));
        cbIssuer.revokeClaimBySignature(late);
        vm.prank(cb2);
        cbIssuer.revokeClaimBySignature(late);
        assertFalse(cbIssuer.isClaimValid(customer, KYC, late, "late"));
    }
}
