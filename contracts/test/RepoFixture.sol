// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Bond} from "../src/Bond.sol";
import {Identity} from "../src/erc3643/Identity.sol";
import {ModularCompliance} from "../src/erc3643/ModularCompliance.sol";
import {ICompliance, IIdentityRegistry} from "../src/erc3643/interfaces/IERC3643.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {BondFixture} from "./BondFixture.sol";

/// @notice The ca-repo network in miniature (SPEC.md §5.7–§5.10): two bonds by the same agent, Bank C, under one
/// identity registry, each with its own compliance and settlement-only module; Bank B holding both, Bank A some of
/// the first. Bank A lends wholesale CAD to Bank B against units of either. Every repo flow is one instruction
/// through the engine: no repo contract, as bonds needed none.
abstract contract RepoFixture is BondFixture {
    Bond internal bond2;

    uint256 internal constant B_HOLDS_1 = 30_000;
    uint256 internal constant B_HOLDS_2 = 20_000;
    uint256 internal constant A_HOLDS_1 = 5_000;

    function setUp() public virtual override {
        super.setUp();
        vm.startPrank(bankC);
        ModularCompliance compliance2 = new ModularCompliance(registry, bankC);
        compliance2.addModule(address(settlementOnly));
        Identity bond2Id = new Identity(registry, bankC);
        bond2 = new Bond(
            "Issuer 2.80% 2029",
            "BOND-ISSUER-2029",
            registry,
            BANK_C,
            "Issuer",
            _terms(),
            Bond.Regulation(
                IIdentityRegistry(address(identities)), ICompliance(address(compliance2)), address(bond2Id)
            )
        );
        compliance2.bindToken(address(bond2));
        bond2.grantRole(bond2.SETTLEMENT_ROLE(), address(engine));
        vm.stopPrank();
        vm.prank(cb);
        registry.listToken(address(bond2));

        // Issue both bonds at par: Bank B takes most of each, Bank A some of the first.
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](5);
        legs[0] = _mint(bond, bankB, B_HOLDS_1);
        legs[1] = _mint(bond2, bankB, B_HOLDS_2);
        legs[2] = _mint(bond, bankA, A_HOLDS_1);
        legs[3] = _move(wcad, bankB, bankC, (B_HOLDS_1 + B_HOLDS_2) * FACE);
        legs[4] = _move(wcad, bankA, bankC, A_HOLDS_1 * FACE);
        SettlementEngine.Instruction memory issue = _instruction(legs);
        _submit(bankC, issue, _approvals(issue, true, true));
    }

    /// @dev §5.7 open: the borrower delivers `units` of `which` to the lender, the lender pays `cash`.
    function _open(Bond which, uint256 units, uint256 cash)
        internal
        returns (SettlementEngine.Instruction memory)
    {
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(which, bankB, bankA, units);
        legs[1] = _move(wcad, bankA, bankB, cash);
        return _instruction(legs);
    }

    /// @dev §5.9 substitution: the lender returns `outUnits` of `out`, the borrower delivers `inUnits` of `incoming`.
    function _substitution(Bond out, uint256 outUnits, Bond incoming, uint256 inUnits)
        internal
        returns (SettlementEngine.Instruction memory)
    {
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _move(out, bankA, bankB, outUnits);
        legs[1] = _move(incoming, bankB, bankA, inUnits);
        return _instruction(legs);
    }

    /// @dev §5.10 close: the lender returns every unit it holds as collateral, the borrower repays `repay`.
    function _close(uint256 units1, uint256 units2, uint256 repay)
        internal
        returns (SettlementEngine.Instruction memory)
    {
        uint256 n = (units1 > 0 ? 1 : 0) + (units2 > 0 ? 1 : 0) + 1;
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](n);
        uint256 k;
        if (units1 > 0) legs[k++] = _move(bond, bankA, bankB, units1);
        if (units2 > 0) legs[k++] = _move(bond2, bankA, bankB, units2);
        legs[k] = _move(wcad, bankB, bankA, repay);
        return _instruction(legs);
    }

    /// @dev Repo interest, ACT/365F: cash × rate (in millionths) × days / 365, rounded once, half-even.
    function _interest(uint256 cash, uint256 rateMillionths, uint256 days_) internal pure returns (uint256) {
        uint256 numerator = cash * rateMillionths * days_;
        uint256 denominator = 1_000_000 * 365;
        uint256 quotient = numerator / denominator;
        uint256 twice = (numerator % denominator) * 2;
        if (twice > denominator || (twice == denominator && quotient % 2 == 1)) return quotient + 1;
        return quotient;
    }
}
