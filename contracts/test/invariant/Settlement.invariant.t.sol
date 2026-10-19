// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {console} from "forge-std/console.sol";
import {ParticipantRegistry} from "../../src/ParticipantRegistry.sol";
import {SettlementToken} from "../../src/SettlementToken.sol";
import {Fixture} from "../Fixture.sol";
import {SettlementHandler} from "./SettlementHandler.sol";

/// @notice SPEC.md §6, invariants 5, 6 and 7, over random sequences of the handler's actions.
contract SettlementInvariants is Fixture {
    SettlementHandler internal handler;

    function setUp() public override {
        super.setUp();
        SettlementHandler.Bank[2] memory banks;
        address[] memory aCustomers = new address[](2);
        aCustomers[0] = alice;
        aCustomers[1] = bob;
        address[] memory bCustomers = new address[](2);
        bCustomers[0] = carol;
        bCustomers[1] = dave;
        banks[0] = SettlementHandler.Bank(bankA, bankAKey, BANK_A, dcadA, aCustomers);
        banks[1] = SettlementHandler.Bank(bankB, bankBKey, BANK_B, dcadB, bCustomers);
        handler = new SettlementHandler(registry, engine, wcad, cb, banks, mallory);
        targetContract(address(handler));
    }

    /// @notice Invariant 5, atomicity: no committed state contains part of an instruction. Every real balance
    /// equals the ghost, which moves only by whole instructions; a rejected instruction changed nothing.
    function invariant_5_atomicity() public view {
        assertFalse(handler.atomicityViolated(), "a rejected instruction changed a balance");
        uint256 supplyW;
        uint256 supplyA;
        uint256 supplyB;
        for (uint256 p; p < handler.pairCount(); ++p) {
            address token = handler.pairToken(p);
            address holder = handler.pairHolder(p);
            uint256 expected = handler.ghost(token, holder);
            assertEq(SettlementToken(token).balanceOf(holder), expected, "balance differs from the ghost");
            if (token == address(wcad)) supplyW += expected;
            else if (token == address(dcadA)) supplyA += expected;
            else supplyB += expected;
        }
        assertEq(wcad.totalSupply(), supplyW, "wCAD supply");
        assertEq(dcadA.totalSupply(), supplyA, "dCAD-A supply");
        assertEq(dcadB.totalSupply(), supplyB, "dCAD-B supply");
    }

    /// @notice Invariant 6, exactly once: an instruction id settles at most once, however often submitted.
    function invariant_6_exactlyOnce() public view {
        for (uint256 i; i < handler.settledCount(); ++i) {
            bytes32 id = handler.settledIds(i);
            assertEq(handler.successes(id), 1, "an instruction settled more than once");
            assertGt(engine.settledAt(id), 0, "a settled instruction is not recorded");
        }
    }

    /// @notice Invariant 7, eligibility: nothing lands on an address the token does not allow, no frozen
    /// balance moves except by forced transfer, and wholesale is held only by banks.
    function invariant_7_eligibility() public view {
        assertFalse(handler.eligibilityViolated(), "a transfer reached an ineligible address");
        assertFalse(handler.frozenViolated(), "a frozen balance moved without a forced transfer");
        for (uint256 p; p < handler.pairCount(); ++p) {
            address token = handler.pairToken(p);
            address holder = handler.pairHolder(p);
            if (token == address(wcad) && wcad.balanceOf(holder) > 0) {
                assertEq(
                    uint8(registry.participant(registry.participantOf(holder)).kind),
                    uint8(ParticipantRegistry.Kind.Bank),
                    "wholesale held by a non-bank"
                );
            }
        }
    }

    /// @notice Every leg had the approval of the participant whose account or liability it touched.
    function invariant_authority() public view {
        assertFalse(handler.authorityViolated(), "an instruction settled without a required approval");
    }

    function afterInvariant() public view {
        console.log("calls", handler.calls(), "reverted", handler.reverted());
        console.log("settled instructions", handler.settledCount(), "interbank", handler.settledInterbank());
    }
}
