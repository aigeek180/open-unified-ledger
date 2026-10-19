// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Bond} from "../src/Bond.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {RepoFixture} from "./RepoFixture.sol";

/// @notice Repo on the shared ledger (SPEC.md §5.7–§5.10): open, margin, substitution, close and the manufactured
/// payment, each one instruction through the settlement engine, all its legs or none. Collateral is an ERC-3643
/// bond, so it reaches the lender only while the lender's identity verifies, whoever submits; once there, only the
/// lender's approval moves it back, and no one moves it outside an instruction.
contract RepoTest is RepoFixture {
    uint256 internal constant CASH = 10_000_000_00; // $10,000,000.00 lent
    uint256 internal constant UNITS = 10_300; // marked at $1,000.00 with a 2% haircut: $10,094,000.00

    /// @dev Open the standard repo: 10,300 units of the first bond against $10,000,000.
    function _opened() internal {
        SettlementEngine.Instruction memory open = _open(bond, UNITS, CASH);
        _submit(bankB, open, _approvals(open, true, false));
    }

    function test_openMovesTheCollateralAndTheCashTogether() public {
        uint256 cashA = wcad.balanceOf(bankA);
        uint256 cashB = wcad.balanceOf(bankB);
        _opened();
        assertEq(
            bond.balanceOf(bankA), A_HOLDS_1 + UNITS, "the lender holds its own units and the collateral"
        );
        assertEq(bond.balanceOf(bankB), B_HOLDS_1 - UNITS);
        assertEq(wcad.balanceOf(bankA), cashA - CASH);
        assertEq(wcad.balanceOf(bankB), cashB + CASH);
    }

    function test_openNeedsTheLendersApprovalForItsCash() public {
        SettlementEngine.Instruction memory open = _open(bond, UNITS, CASH);
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 1, BANK_A));
        engine.settle(open, _none());
    }

    function test_openWithoutEnoughUnitsMovesNoCashEither() public {
        uint256 cashA = wcad.balanceOf(bankA);
        SettlementEngine.Instruction memory open = _open(bond, B_HOLDS_1 + 1, CASH);
        SettlementEngine.Approval[] memory byA = _approvals(open, true, false);
        vm.prank(bankB);
        vm.expectRevert();
        engine.settle(open, byA);
        assertEq(wcad.balanceOf(bankA), cashA, "no cash moved");
        assertEq(bond.balanceOf(bankB), B_HOLDS_1, "no units moved");
    }

    function test_collateralReachesTheLenderOnlyWhileItsIdentityVerifies() public {
        // The central bank revokes its KYC claim on Bank A's identity: Bank A can receive no collateral.
        bytes memory claim = _claimSignature(cbKey, bankAId, KYC, "KYC verified");
        vm.prank(cb);
        cbIssuer.revokeClaimBySignature(claim);
        assertFalse(identities.isVerified(bankA));
        SettlementEngine.Instruction memory open = _open(bond, UNITS, CASH);
        SettlementEngine.Approval[] memory byA = _approvals(open, true, false);
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(Bond.ReceiverNotVerified.selector, bankA));
        engine.settle(open, byA);
        assertEq(bond.balanceOf(bankB), B_HOLDS_1);
    }

    function test_onlyTheLendersApprovalMovesTheCollateralBack() public {
        _opened();
        // The borrower cannot take its units back without the lender, even repaying in full.
        SettlementEngine.Instruction memory close = _close(UNITS, 0, CASH + _interest(CASH, 27_500, 7));
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_A));
        engine.settle(close, _none());
        // Nor can anyone move it outside an instruction: a direct transfer is not compliant.
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(Bond.TransferNotCompliant.selector, bankA, bankB, UNITS));
        bond.transfer(bankB, UNITS);
    }

    function test_marginIsOneLegCoSignedByTheLender() public {
        _opened();
        // At $990.00 the collateral is short: Bank B delivers 10 more units, Bank A co-signs to agree to the mark.
        SettlementEngine.Instruction memory call = _instruction(_move(bond, bankB, bankA, 10));
        _submit(bankB, call, _approvals(call, true, false));
        assertEq(bond.balanceOf(bankA), A_HOLDS_1 + UNITS + 10);
        // Later the mark rises: Bank A returns the excess, Bank B co-signs.
        SettlementEngine.Instruction memory back = _instruction(_move(bond, bankA, bankB, 194));
        _submit(bankA, back, _approvals(back, false, true));
        assertEq(bond.balanceOf(bankA), A_HOLDS_1 + UNITS + 10 - 194);
    }

    function test_substitutionSwapsBothBondsOrNeither() public {
        _opened();
        // Bank B asks for more of the second bond than it holds: the old units stay with Bank A.
        SettlementEngine.Instruction memory tooMuch = _substitution(bond, UNITS, bond2, B_HOLDS_2 + 1);
        SettlementEngine.Approval[] memory byA = _approvals(tooMuch, true, false);
        vm.prank(bankB);
        vm.expectRevert();
        engine.settle(tooMuch, byA);
        assertEq(bond.balanceOf(bankA), A_HOLDS_1 + UNITS, "the lender was never left without collateral");

        SettlementEngine.Instruction memory swap = _substitution(bond, UNITS, bond2, 10_449);
        _submit(bankB, swap, _approvals(swap, true, false));
        assertEq(bond.balanceOf(bankA), A_HOLDS_1);
        assertEq(bond2.balanceOf(bankA), 10_449);
        assertEq(bond.balanceOf(bankB), B_HOLDS_1);
        assertEq(bond2.balanceOf(bankB), B_HOLDS_2 - 10_449);
    }

    function test_closeReturnsEveryUnitAndRepaysPrincipalPlusInterest() public {
        _opened();
        SettlementEngine.Instruction memory call = _instruction(_move(bond2, bankB, bankA, 40));
        _submit(bankB, call, _approvals(call, true, false));
        uint256 cashA = wcad.balanceOf(bankA);
        uint256 repay = CASH + _interest(CASH, 27_500, 7);
        assertEq(repay, 10_005_273_97, "$10,000,000 at 2.75% for 7 days, ACT/365F, rounded once half-even");
        SettlementEngine.Instruction memory close = _close(UNITS, 40, repay);
        _submit(bankB, close, _approvals(close, true, false));
        assertEq(bond.balanceOf(bankA), A_HOLDS_1, "the lender keeps only what it owns");
        assertEq(bond2.balanceOf(bankA), 0);
        assertEq(bond.balanceOf(bankB), B_HOLDS_1);
        assertEq(bond2.balanceOf(bankB), B_HOLDS_2);
        assertEq(wcad.balanceOf(bankA), cashA + repay);
    }

    function test_aCouponOnCollateralIsPaidToTheLenderAndManufacturedOnToTheBorrower() public {
        _opened();
        // The agent pays the holders of record: Bank A for its own units and the collateral, Bank B for the rest.
        uint256 perUnit = 16_25; // illustrative coupon per unit
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(wcad, bankC, bankA, (A_HOLDS_1 + UNITS) * perUnit);
        legs[1] = _move(wcad, bankC, bankB, (B_HOLDS_1 - UNITS) * perUnit);
        SettlementEngine.Instruction memory coupon = _instruction(legs);
        _submit(bankC, coupon, _approvals(coupon, true, true));
        uint256 cashB = wcad.balanceOf(bankB);
        // Bank A owes Bank B the coupon on the collateral: one wholesale leg.
        SettlementEngine.Instruction memory manufactured =
            _instruction(_move(wcad, bankA, bankB, UNITS * perUnit));
        _submit(bankA, manufactured, _approvals(manufactured, false, true));
        assertEq(wcad.balanceOf(bankB), cashB + UNITS * perUnit, "Bank B has the coupon on all its units");
    }

    function test_interestRoundsOnceHalfEven() public pure {
        // 3.65 × 50% × 1 / 365 = 0.005: a tie, to the even cent (0); 10.95 × 50% / 365 = 0.015 → 0.02.
        assertEq(_interest(365, 500_000, 1), 0);
        assertEq(_interest(1095, 500_000, 1), 2);
        assertEq(_interest(1094, 500_000, 1), 1);
    }
}
