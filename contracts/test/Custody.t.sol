// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Bond} from "../src/Bond.sol";
import {IIdentity} from "../src/erc3643/interfaces/IIdentity.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {BondFixture} from "./BondFixture.sol";

/// @notice Client custody on chain (SPEC.md §15): Bank A holds bonds for its clients at an omnibus address, a
/// holding address bound to Bank A in the participant registry and registered with Bank A's identity in the
/// bond's identity registry. Only Bank A's approval moves what it holds there, whoever submits; and when the
/// omnibus wallet is lost the agent recovers its units to a new wallet bound the same way.
contract CustodyTest is BondFixture {
    address internal omnibus = makeAddr("bank-a/custody/1");

    function setUp() public override {
        super.setUp();
        vm.prank(cb);
        registry.bindHoldingAddress(BANK_A, omnibus);
        vm.prank(bankC);
        identities.registerIdentity(omnibus, IIdentity(address(bankAId)), CANADA);
        // Issue 600 units to Bank A's own book and 300 to its clients' omnibus, 100 to Bank B.
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](5);
        legs[0] = _mint(bond, bankA, 600);
        legs[1] = _mint(bond, omnibus, 300);
        legs[2] = _mint(bond, bankB, 100);
        legs[3] = _move(wcad, bankA, bankC, 900 * FACE);
        legs[4] = _move(wcad, bankB, bankC, 100 * FACE);
        SettlementEngine.Instruction memory i = _instruction(legs);
        _submit(bankC, i, _approvals(i, true, true));
    }

    function test_theOmnibusHoldsForItsBankAndOnlyItsBanksApprovalMovesIt() public {
        assertEq(bond.balanceOf(omnibus), 300);
        assertTrue(identities.isVerified(omnibus));
        assertEq(registry.signerOf(omnibus), bytes32(0));

        // A client sells to Bank B: the omnibus leg needs Bank A, not the bond's agent, not the omnibus itself.
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(bond, omnibus, bankB, 50);
        legs[1] = _move(wcad, bankB, bankA, 50 * FACE);
        SettlementEngine.Instruction memory sale = _instruction(legs);
        SettlementEngine.Approval[] memory onlyB = _approvals(sale, false, true);
        vm.prank(bankC);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_A));
        engine.settle(sale, onlyB);
        _submit(bankA, sale, _approvals(sale, false, true));
        assertEq(bond.balanceOf(omnibus), 250);
    }

    function test_recoversALostOmnibusWalletWithItsUnits() public {
        address replacement = makeAddr("bank-a/custody/2");
        vm.prank(bankC);
        vm.expectRevert(abi.encodeWithSelector(Bond.RecoveryNotAuthorized.selector, replacement));
        bond.recoveryAddress(omnibus, replacement, address(bankAId));

        // Bank A names the new wallet on its identity, the registry's operator binds it to Bank A, the agent recovers.
        vm.prank(bankA);
        bankAId.addKey(keccak256(abi.encode(replacement)), 1, 1);
        vm.prank(cb);
        registry.bindHoldingAddress(BANK_A, replacement);
        vm.prank(bankC);
        bond.recoveryAddress(omnibus, replacement, address(bankAId));
        assertEq(bond.balanceOf(omnibus), 0);
        assertEq(bond.balanceOf(replacement), 300);
        assertFalse(identities.contains(omnibus));
        assertTrue(identities.isVerified(replacement));

        // Its units stay Bank A's: only Bank A's approval moves them on.
        SettlementEngine.Instruction memory redeem = _instruction(_burn(bond, replacement, 300));
        vm.prank(bankC);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_A));
        engine.settle(redeem, _none());
        _submit(bankC, redeem, _approvals(redeem, true, false));
        assertEq(bond.balanceOf(replacement), 0);
    }
}
