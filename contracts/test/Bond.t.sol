// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Bond} from "../src/Bond.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {BondFixture} from "./BondFixture.sol";

/// @notice SPEC.md §5.4–§5.6 on chain: a bond issued through Bank C as agent, bought by Banks A and B against
/// wholesale tokens, traded, paid and redeemed, each step one atomic instruction.
contract BondTest is BondFixture {
    // ---------------------------------------------------------------- §5.4 issuance

    function test_issuanceDeliversUnitsAgainstPayment() public {
        _issue();
        assertEq(bond.balanceOf(bankA), 600);
        assertEq(bond.balanceOf(bankB), 400);
        assertEq(bond.totalSupply(), 1000);
        assertEq(wcad.balanceOf(bankC), 1000 * FACE);
        assertEq(bond.decimals(), 0);
    }

    function test_issuanceNeedsEveryBuyersApproval() public {
        SettlementEngine.Instruction memory i = _issuance();
        SettlementEngine.Approval[] memory approvals = _approvals(i, true, false);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 3, BANK_B));
        _submit(bankC, i, approvals);
        assertEq(bond.totalSupply(), 0);
        assertEq(wcad.balanceOf(bankA), 1_000_000_000_00);
    }

    function test_onlyTheAgentMints() public {
        SettlementEngine.Instruction memory i = _instruction(_mint(bond, bankA, 1));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_C));
        _submit(bankA, i, _none());
    }

    // ---------------------------------------------------------------- §5.5 secondary DvP

    function test_aTradeMovesUnitsAndCashTogether() public {
        _issue();
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(bond, bankA, bankB, 100);
        legs[1] = _move(wcad, bankB, bankA, 100 * 1001_50); // at 100.15
        SettlementEngine.Instruction memory i = _instruction(legs);
        _submit(bankA, i, _approvals(i, false, true));
        assertEq(bond.balanceOf(bankA), 500);
        assertEq(bond.balanceOf(bankB), 500);
        assertEq(wcad.balanceOf(bankA), 1_000_000_000_00 - 600 * FACE + 100 * 1001_50);
    }

    function test_aTradeTheBuyerCannotPayForDeliversNothing() public {
        _issue();
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(bond, bankA, bankB, 100);
        legs[1] = _move(wcad, bankB, bankA, 2_000_000_000_00);
        SettlementEngine.Instruction memory i = _instruction(legs);
        SettlementEngine.Approval[] memory approvals = _approvals(i, false, true);
        vm.expectRevert();
        _submit(bankA, i, approvals);
        assertEq(bond.balanceOf(bankA), 600);
        assertEq(bond.balanceOf(bankB), 400);
    }

    function test_onlyAVerifiedIdentityHoldsTheBond() public {
        _issue();
        SettlementEngine.Instruction memory i = _instruction(_move(bond, bankA, alice, 1));
        vm.expectRevert(abi.encodeWithSelector(Bond.ReceiverNotVerified.selector, alice));
        _submit(bankA, i, _none());
    }

    // ---------------------------------------------------------------- record dates

    function test_theRegisterAtAPastBlockIsReadable() public {
        _issue();
        uint256 recordBlock = vm.getBlockNumber();
        vm.roll(vm.getBlockNumber() + 1);

        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(bond, bankA, bankB, 250);
        legs[1] = _move(wcad, bankB, bankA, 250 * FACE);
        SettlementEngine.Instruction memory i = _instruction(legs);
        _submit(bankA, i, _approvals(i, false, true));
        vm.roll(vm.getBlockNumber() + 1);

        assertEq(bond.balanceOfAt(bankA, recordBlock), 600);
        assertEq(bond.balanceOfAt(bankA, vm.getBlockNumber() - 1), 350);
        assertEq(bond.totalSupplyAt(recordBlock), 1000);
        assertEq(bond.balanceOfAt(bankA, recordBlock - 1), 0);
        vm.expectRevert(
            abi.encodeWithSelector(Bond.FutureLookup.selector, vm.getBlockNumber(), vm.getBlockNumber())
        );
        bond.balanceOfAt(bankA, vm.getBlockNumber());
    }

    // ---------------------------------------------------------------- §5.6 coupons and redemption

    function test_theAgentPaysCouponsInWholesale() public {
        _issue();
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(wcad, bankC, bankA, 9_669_86);
        legs[1] = _move(wcad, bankC, bankB, 6_446_58);
        SettlementEngine.Instruction memory i = _instruction(legs);
        _submit(bankC, i, _approvals(i, true, true));
        assertEq(wcad.balanceOf(bankC), 1000 * FACE - 9_669_86 - 6_446_58);
    }

    function test_redemptionCancelsUnitsAndRepaysFace() public {
        _issue();
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](4);
        legs[0] = _burn(bond, bankA, 600);
        legs[1] = _burn(bond, bankB, 400);
        legs[2] = _move(wcad, bankC, bankA, 600 * FACE);
        legs[3] = _move(wcad, bankC, bankB, 400 * FACE);
        SettlementEngine.Instruction memory i = _instruction(legs);

        // The holders' units are cancelled only with their approval.
        SettlementEngine.Approval[] memory onlyA = _approvals(i, true, false);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 1, BANK_B));
        _submit(bankC, i, onlyA);

        _submit(bankC, i, _approvals(i, true, true));
        assertEq(bond.totalSupply(), 0);
        assertEq(wcad.balanceOf(bankC), 0);
        assertEq(wcad.balanceOf(bankA), 1_000_000_000_00);
    }

    // ---------------------------------------------------------------- terms

    function test_termsAreFixedAndTheAgentMustBeABank() public {
        Bond.Terms memory t = bond.terms();
        assertEq(t.faceValue, FACE);
        assertEq(t.couponRate, 0.0325e18);
        assertEq(t.maturityDate, 20311102);
        assertEq(bond.issuerName(), "Issuer");
        assertEq(bond.issuer(), BANK_C);

        Bond.Regulation memory regulation = Bond.Regulation(identities, compliance, address(0));
        vm.expectRevert(abi.encodeWithSelector(Bond.AgentNotABank.selector, CB));
        new Bond("x", "X", registry, CB, "x", t, regulation);

        t.couponRate = 1e18;
        vm.expectRevert(Bond.InvalidTerms.selector);
        new Bond("x", "X", registry, BANK_C, "x", t, regulation);
    }
}
