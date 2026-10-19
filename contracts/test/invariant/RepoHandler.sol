// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Bond} from "../../src/Bond.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {SettlementToken} from "../../src/SettlementToken.sol";
import {WholesaleToken} from "../../src/WholesaleToken.sol";

/// @notice Drives repos between a lender and a borrower at random (SPEC.md §5.7–§5.10): opens, margin deliveries
/// and returns, substitutions between two bonds, closes, and attempts that must be refused whole. It keeps the
/// repo's record (cash lent, collateral per bond) as both banks' books would, and moves it only when the engine
/// settled the instruction; a refused attempt must leave every balance as it was.
contract RepoHandler is CommonBase, StdUtils {
    struct Party {
        address account;
        uint256 key;
    }

    /// @notice The repo rate in millionths (2.75%).
    uint256 public constant RATE = 27_500;

    SettlementEngine public immutable engine;
    WholesaleToken public immutable wcad;
    Bond[2] public bonds;
    Party internal lender;
    Party internal borrower;

    /// @notice The units each bank owns of each bond, which no repo flow changes.
    mapping(address bond => uint256) public lenderOwns;
    mapping(address bond => uint256) public borrowerOwns;
    /// @notice The open repo's record: whether one is open, the cash lent and the collateral per bond.
    bool public open;
    uint256 public cash;
    mapping(address bond => uint256) public collateral;
    /// @notice Cash each bank should hold, moved only by settled repo flows.
    uint256 public lenderCash;
    uint256 public borrowerCash;

    bool public refusedButMoved;
    uint256 public opened;
    uint256 public closed;
    uint256 public margins;
    uint256 public substitutions;
    uint256 public refusals;
    uint256 private _nonce;

    constructor(
        SettlementEngine engine_,
        WholesaleToken wcad_,
        Bond[2] memory bonds_,
        Party memory lender_,
        Party memory borrower_
    ) {
        engine = engine_;
        wcad = wcad_;
        bonds = bonds_;
        lender = lender_;
        borrower = borrower_;
        for (uint256 b; b < 2; ++b) {
            lenderOwns[address(bonds_[b])] = bonds_[b].balanceOf(lender_.account);
            borrowerOwns[address(bonds_[b])] = bonds_[b].balanceOf(borrower_.account);
        }
        lenderCash = wcad_.balanceOf(lender_.account);
        borrowerCash = wcad_.balanceOf(borrower_.account);
    }

    // ---------------------------------------------------------------- flows

    /// @notice §5.7: the borrower delivers units of one bond, the lender pays the cash; the borrower submits.
    function openRepo(uint256 which, uint256 units, uint256 cashSeed) external {
        if (open) return;
        Bond bond = bonds[which % 2];
        units = bound(units, 1, borrowerOwns[address(bond)]);
        uint256 amount = bound(cashSeed, 1, lenderCash < 1e12 ? lenderCash : 1e12);
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _leg(bond, borrower.account, lender.account, units);
        legs[1] = _leg(wcad, lender.account, borrower.account, amount);
        if (_settle(borrower, legs, lender)) {
            open = true;
            cash = amount;
            collateral[address(bond)] = units;
            lenderCash -= amount;
            borrowerCash += amount;
            opened++;
        }
    }

    /// @notice §5.8: the borrower delivers more units, or the lender returns some; the other side co-signs.
    function margin(uint256 which, uint256 units, bool deliver) external {
        if (!open) return;
        Bond bond = bonds[which % 2];
        address key = address(bond);
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](1);
        if (deliver) {
            uint256 free = borrowerOwns[key] - collateral[key];
            if (free == 0) return;
            units = bound(units, 1, free);
            legs[0] = _leg(bond, borrower.account, lender.account, units);
            if (_settle(borrower, legs, lender)) {
                collateral[key] += units;
                margins++;
            }
        } else {
            if (collateral[key] == 0) return;
            units = bound(units, 1, collateral[key]);
            legs[0] = _leg(bond, lender.account, borrower.account, units);
            if (_settle(lender, legs, borrower)) {
                collateral[key] -= units;
                margins++;
            }
        }
    }

    /// @notice §5.9: every unit of one bond back to the borrower and units of the other to the lender, at once.
    function substitute(uint256 which, uint256 units) external {
        if (!open) return;
        (Bond out, Bond incoming) = (bonds[which % 2], bonds[1 - which % 2]);
        uint256 outUnits = collateral[address(out)];
        uint256 free = borrowerOwns[address(incoming)] - collateral[address(incoming)];
        if (outUnits == 0 || free == 0) return;
        units = bound(units, 1, free);
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _leg(out, lender.account, borrower.account, outUnits);
        legs[1] = _leg(incoming, borrower.account, lender.account, units);
        if (_settle(borrower, legs, lender)) {
            collateral[address(out)] = 0;
            collateral[address(incoming)] += units;
            substitutions++;
        }
    }

    /// @notice §5.10: every collateral unit back, and the purchase price plus interest for the days held.
    function close(uint256 days_) external {
        if (!open) return;
        days_ = bound(days_, 1, 366);
        uint256 repay = cash + interest(cash, days_);
        if (repay > borrowerCash) return;
        uint256 n = 1;
        for (uint256 b; b < 2; ++b) {
            if (collateral[address(bonds[b])] > 0) n++;
        }
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](n);
        uint256 k;
        for (uint256 b; b < 2; ++b) {
            uint256 units = collateral[address(bonds[b])];
            if (units > 0) legs[k++] = _leg(bonds[b], lender.account, borrower.account, units);
        }
        legs[k] = _leg(wcad, borrower.account, lender.account, repay);
        if (_settle(borrower, legs, lender)) {
            for (uint256 b; b < 2; ++b) {
                collateral[address(bonds[b])] = 0;
            }
            lenderCash += repay;
            borrowerCash -= repay;
            open = false;
            cash = 0;
            closed++;
        }
    }

    /// @notice Attempts the engine must refuse whole: collateral taken back without the lender, more units than
    /// the borrower holds, a repayment without the borrower's cash approval. Nothing may move.
    function refused(uint256 kind, uint256 units) external {
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        Bond bond = bonds[units % 2];
        kind = kind % 3;
        if (kind == 0) {
            // The borrower takes collateral back, paying, without the lender's signature.
            legs[0] = _leg(bond, lender.account, borrower.account, 1);
            legs[1] = _leg(wcad, borrower.account, lender.account, 1);
            _expectRefused(borrower, legs, Party(address(0), 0));
        } else if (kind == 1) {
            // More units than the borrower holds at all.
            legs[0] = _leg(bond, borrower.account, lender.account, bond.balanceOf(borrower.account) + 1);
            legs[1] = _leg(wcad, lender.account, borrower.account, 1);
            _expectRefused(borrower, legs, lender);
        } else {
            // The lender moves the borrower's cash to itself.
            legs[0] = _leg(bond, lender.account, borrower.account, 1);
            legs[1] = _leg(wcad, borrower.account, lender.account, bound(units, 1, 1e9));
            _expectRefused(lender, legs, Party(address(0), 0));
        }
    }

    /// @notice Repo interest: cash × rate × days / 365, rounded once, half-even, in minor units.
    function interest(uint256 amount, uint256 days_) public pure returns (uint256) {
        uint256 numerator = amount * RATE * days_;
        uint256 denominator = 1_000_000 * 365;
        uint256 quotient = numerator / denominator;
        uint256 twice = (numerator % denominator) * 2;
        if (twice > denominator || (twice == denominator && quotient % 2 == 1)) return quotient + 1;
        return quotient;
    }

    function lenderAccount() external view returns (address) {
        return lender.account;
    }

    function borrowerAccount() external view returns (address) {
        return borrower.account;
    }

    // ---------------------------------------------------------------- internals

    function _leg(SettlementToken token, address from, address to, uint256 amount)
        internal
        pure
        returns (SettlementEngine.Leg memory)
    {
        return SettlementEngine.Leg(SettlementEngine.LegKind.Transfer, address(token), from, to, amount);
    }

    function _instruction(SettlementEngine.Leg[] memory legs)
        internal
        returns (SettlementEngine.Instruction memory i)
    {
        i.id = keccak256(abi.encode("repo", ++_nonce));
        i.legs = legs;
        i.deadline = uint64(block.timestamp + 1 hours);
    }

    function _approvals(SettlementEngine.Instruction memory i, Party memory cosigner)
        internal
        view
        returns (SettlementEngine.Approval[] memory list)
    {
        if (cosigner.account == address(0)) return new SettlementEngine.Approval[](0);
        list = new SettlementEngine.Approval[](1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(cosigner.key, engine.digest(i));
        list[0] = SettlementEngine.Approval(cosigner.account, abi.encodePacked(r, s, v));
    }

    /// @dev Submit; on a refusal, nothing may have moved.
    function _settle(Party memory submitter, SettlementEngine.Leg[] memory legs, Party memory cosigner)
        internal
        returns (bool)
    {
        SettlementEngine.Instruction memory i = _instruction(legs);
        SettlementEngine.Approval[] memory approvals = _approvals(i, cosigner);
        bytes32 before = _snapshot();
        vm.prank(submitter.account);
        try engine.settle(i, approvals) {
            return true;
        } catch {
            if (_snapshot() != before) refusedButMoved = true;
            return false;
        }
    }

    function _expectRefused(Party memory submitter, SettlementEngine.Leg[] memory legs, Party memory cosigner)
        internal
    {
        if (_settle(submitter, legs, cosigner)) refusedButMoved = true;
        else refusals++;
    }

    function _snapshot() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                wcad.balanceOf(lender.account),
                wcad.balanceOf(borrower.account),
                bonds[0].balanceOf(lender.account),
                bonds[0].balanceOf(borrower.account),
                bonds[1].balanceOf(lender.account),
                bonds[1].balanceOf(borrower.account)
            )
        );
    }
}
