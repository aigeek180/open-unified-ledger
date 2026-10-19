// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {SettlementEngine} from "../SettlementEngine.sol";

/// @title SplitLegsEngine
/// @notice A deliberately broken settlement engine, for the conformance kit only (SPEC.md §14): it settles an
/// instruction one leg per transaction (`settleLeg`), each under the instruction's approvals, so legs that
/// settle stay settled when a later one fails. The kit must fail it on atomicity (invariant 5). Never deploy
/// it for anything else.
contract SplitLegsEngine is SettlementEngine {
    /// @notice Which legs of an instruction have settled.
    mapping(bytes32 id => mapping(uint256 leg => bool)) public legSettled;

    constructor(ParticipantRegistry registry_) SettlementEngine(registry_) {}

    /// @notice Settle leg `index` of `instruction` alone, with the same checks `settle` makes.
    function settleLeg(Instruction calldata instruction, Approval[] calldata approvals, uint256 index)
        external
    {
        bytes32 submitter = registry.signerOf(msg.sender);
        if (submitter == bytes32(0) || !registry.isActive(submitter)) revert NotASubmitter(msg.sender);
        bytes32 id = instruction.id;
        if (id == bytes32(0)) revert InvalidInstructionId();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > instruction.deadline) revert InstructionExpired(id, instruction.deadline);
        uint256 legCount = instruction.legs.length;
        if (legCount == 0 || legCount > MAX_LEGS || index >= legCount) revert InvalidLegCount(legCount);
        if (approvals.length > MAX_APPROVALS) revert TooManyApprovals(approvals.length);
        if (legSettled[id][index]) revert AlreadySettled(id, settledAt[id]);

        bytes32[] memory approvers = _approvers(digest(instruction), approvals, submitter);
        // The break: this leg settles on its own, whatever becomes of the others.
        legSettled[id][index] = true;
        settledAt[id] = block.number;
        // forge-lint: disable-next-line(reentrancy-events)
        emit InstructionSettled(id, submitter, 1);
        Leg calldata leg = instruction.legs[index];
        _execute(_authorize(approvers, leg, index), leg);
    }
}
