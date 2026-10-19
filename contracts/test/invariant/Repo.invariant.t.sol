// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {console} from "forge-std/console.sol";
import {Bond} from "../../src/Bond.sol";
import {RepoFixture} from "../RepoFixture.sol";
import {RepoHandler} from "./RepoHandler.sol";

/// @notice SPEC.md §6, invariant 14, over random sequences of repo flows: what the lender holds of each bond is
/// what it owns plus the open repo's collateral record, what the borrower holds is what it owns less that record,
/// and cash moved only by whole repo flows, a close repaying exactly the purchase price plus interest.
contract RepoInvariants is RepoFixture {
    RepoHandler internal handler;

    function setUp() public override {
        super.setUp();
        Bond[2] memory both = [bond, bond2];
        handler = new RepoHandler(
            engine, wcad, both, RepoHandler.Party(bankA, bankAKey), RepoHandler.Party(bankB, bankBKey)
        );
        targetContract(address(handler));
    }

    /// @notice Invariant 14: the units the lender holds as collateral are exactly the repo's record, and the
    /// borrower's units are its own less what it pledged; a closed repo leaves no collateral anywhere.
    function invariant_14_collateralIsTheRecord() public view {
        for (uint256 b; b < 2; ++b) {
            Bond token = b == 0 ? bond : bond2;
            address key = address(token);
            assertEq(
                token.balanceOf(bankA),
                handler.lenderOwns(key) + handler.collateral(key),
                "the lender's units are not its own plus the collateral record"
            );
            assertEq(
                token.balanceOf(bankB),
                handler.borrowerOwns(key) - handler.collateral(key),
                "the borrower's units are not its own less what it pledged"
            );
            if (!handler.open()) assertEq(handler.collateral(key), 0, "a closed repo still has collateral");
        }
    }

    /// @notice Cash moved only by whole repo flows: the purchase price out, the price plus interest back.
    function invariant_14_cashMovedOnlyByRepoFlows() public view {
        assertEq(wcad.balanceOf(bankA), handler.lenderCash(), "the lender's cash");
        assertEq(wcad.balanceOf(bankB), handler.borrowerCash(), "the borrower's cash");
    }

    /// @notice Invariant 5 for repo flows: an instruction the engine refused moved nothing.
    function invariant_5_refusedRepoFlowsMoveNothing() public view {
        assertFalse(
            handler.refusedButMoved(), "a refused repo instruction moved a balance, or a bad one settled"
        );
    }

    function afterInvariant() public view {
        console.log("opened", handler.opened(), "closed", handler.closed());
        console.log("margins", handler.margins(), "substitutions", handler.substitutions());
        console.log("refused", handler.refusals());
    }
}
