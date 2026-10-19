// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {SettlementToken} from "./SettlementToken.sol";

/// @title SettlementEngine
/// @notice Executes a settlement instruction's legs atomically: all of them commit in one transaction or none
/// do (SPEC.md §4.2). An interbank transfer is one instruction of three legs: burn the payer's deposit token,
/// move wholesale tokens between the banks, mint the payee's deposit token.
/// @dev Holds no balances and no authority of its own. Every leg needs the approval of the participant that
/// owns what the leg takes or creates:
///   - a mint needs the token's issuer, since it creates the issuer's liability;
///   - a burn or a transfer out of an account needs the account's participant, or, for a customer address
///     that belongs to no participant, the token's issuer, acting for its customer.
/// Approval is the submitter (an active participant's signing key) or an EIP-712 signature by a signing key
/// of an active participant. An instruction id (the ISO 20022 UETR) settles at most once.
contract SettlementEngine is EIP712 {
    enum LegKind {
        Mint,
        Burn,
        Transfer
    }

    struct Leg {
        LegKind kind;
        address token;
        address from;
        address to;
        uint256 amount;
    }

    struct Instruction {
        bytes32 id;
        Leg[] legs;
        uint64 deadline;
    }

    struct Approval {
        address signer;
        bytes signature;
    }

    bytes32 public constant LEG_TYPEHASH =
        keccak256("Leg(uint8 kind,address token,address from,address to,uint256 amount)");
    bytes32 public constant INSTRUCTION_TYPEHASH = keccak256(
        "Instruction(bytes32 id,Leg[] legs,uint64 deadline)Leg(uint8 kind,address token,address from,address to,uint256 amount)"
    );
    uint256 public constant MAX_LEGS = 16;
    uint256 public constant MAX_APPROVALS = 8;

    ParticipantRegistry public immutable registry;

    /// @notice The block an instruction settled in, or zero if it has not.
    mapping(bytes32 id => uint256 blockNumber) public settledAt;

    event InstructionSettled(bytes32 indexed id, bytes32 indexed submitter, uint256 legCount);

    error NotASubmitter(address account);
    error InvalidInstructionId();
    error AlreadySettled(bytes32 id, uint256 blockNumber);
    error InstructionExpired(bytes32 id, uint64 deadline);
    error InvalidLegCount(uint256 count);
    error TooManyApprovals(uint256 count);
    error InvalidApproval(address signer);
    error TokenNotListed(uint256 leg, address token);
    error InvalidLeg(uint256 leg);
    error MissingApproval(uint256 leg, bytes32 participant);

    constructor(ParticipantRegistry registry_) EIP712("Open Unified Ledger Settlement", "1") {
        registry = registry_;
    }

    /// @notice The EIP-712 digest participants sign to approve `instruction`.
    function digest(Instruction calldata instruction) public view returns (bytes32) {
        uint256 count = instruction.legs.length;
        bytes32[] memory legHashes = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            Leg calldata leg = instruction.legs[i];
            legHashes[i] =
                keccak256(abi.encode(LEG_TYPEHASH, leg.kind, leg.token, leg.from, leg.to, leg.amount));
        }
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    INSTRUCTION_TYPEHASH,
                    instruction.id,
                    keccak256(abi.encodePacked(legHashes)),
                    instruction.deadline
                )
            )
        );
    }

    /// @notice Settle every leg of `instruction`, or revert and settle none.
    function settle(Instruction calldata instruction, Approval[] calldata approvals) external {
        bytes32 submitter = registry.signerOf(msg.sender);
        if (submitter == bytes32(0) || !registry.isActive(submitter)) revert NotASubmitter(msg.sender);

        bytes32 id = instruction.id;
        if (id == bytes32(0)) revert InvalidInstructionId();
        _requireUnsettled(id);
        // The deadline only retires stale approvals; QBFT validators are permissioned participants, and a
        // block's timestamp cannot move far enough to matter at the granularity of an instruction's expiry.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > instruction.deadline) revert InstructionExpired(id, instruction.deadline);
        uint256 legCount = instruction.legs.length;
        if (legCount == 0 || legCount > MAX_LEGS) revert InvalidLegCount(legCount);
        if (approvals.length > MAX_APPROVALS) revert TooManyApprovals(approvals.length);

        bytes32[] memory approvers = _approvers(digest(instruction), approvals, submitter);

        // Mark before moving anything: a reentrant or repeated call for this id cannot settle again. The
        // event goes out with it; if any leg fails, the revert discards both.
        settledAt[id] = block.number;
        // The only calls before this are views (registry reads, ERC-1271 checks), which cannot reenter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit InstructionSettled(id, submitter, legCount);

        for (uint256 i; i < legCount; ++i) {
            Leg calldata leg = instruction.legs[i];
            _execute(_authorize(approvers, leg, i), leg);
        }
    }

    /// @dev Refuse an id that has settled before (invariant 6).
    function _requireUnsettled(bytes32 id) internal view virtual {
        uint256 settledBlock = settledAt[id];
        if (settledBlock != 0) revert AlreadySettled(id, settledBlock);
    }

    /// @dev Check leg `i` and that its authority is among `approvers` (invariant 9); return its token.
    function _authorize(bytes32[] memory approvers, Leg calldata leg, uint256 i)
        internal
        view
        virtual
        returns (SettlementToken)
    {
        return LegAuthority.authorize(registry, approvers, leg, i);
    }

    function _execute(SettlementToken token, Leg calldata leg) internal {
        if (leg.kind == LegKind.Mint) token.settleMint(leg.to, leg.amount);
        else if (leg.kind == LegKind.Burn) token.settleBurn(leg.from, leg.amount);
        else token.settleTransfer(leg.from, leg.to, leg.amount);
    }

    /// @dev The submitter plus every participant with a valid signature; each must be active.
    function _approvers(bytes32 hash, Approval[] calldata approvals, bytes32 submitter)
        internal
        view
        returns (bytes32[] memory)
    {
        return LegAuthority.approvers(registry, hash, approvals, submitter);
    }
}

/// @title LegAuthority
/// @notice The authority rule every settlement path shares (SPEC.md §6, invariant 9): who approved an
/// instruction, and whether that covers each leg. The settlement engine settles at once; the conditional
/// settlement contract (interop mode, SPEC.md §7) locks first and settles later, under the same rule.
library LegAuthority {
    /// @dev The submitter plus every participant with a valid signature over `hash`; each must be active.
    function approvers(
        ParticipantRegistry registry,
        bytes32 hash,
        SettlementEngine.Approval[] calldata approvals,
        bytes32 submitter
    ) internal view returns (bytes32[] memory set) {
        set = new bytes32[](approvals.length + 1);
        set[0] = submitter;
        for (uint256 i; i < approvals.length; ++i) {
            address signer = approvals[i].signer;
            // Only an active signing key approves for its participant; a retired key or a holding address
            // signs for no one.
            bytes32 participant = registry.signerOf(signer);
            if (
                participant == bytes32(0) || !registry.isActive(participant)
                    || !SignatureChecker.isValidSignatureNow(signer, hash, approvals[i].signature)
            ) revert SettlementEngine.InvalidApproval(signer);
            set[i + 1] = participant;
        }
    }

    /// @dev Check leg `i` is well formed, its token listed, and its authority among `approvers`; return
    /// the token. A mint needs the issuer; a burn or transfer out needs the holder's participant, or, for a
    /// customer address, the issuer acting for it.
    function authorize(
        ParticipantRegistry registry,
        bytes32[] memory approvers_,
        SettlementEngine.Leg calldata leg,
        uint256 i
    ) internal view returns (SettlementToken token) {
        bytes32 authority;
        (token, authority) = required(registry, leg, i);
        if (!contains(approvers_, authority)) revert SettlementEngine.MissingApproval(i, authority);
    }

    /// @dev Check leg `i` is well formed and its token listed; return the token and whose approval the leg
    /// needs.
    function required(ParticipantRegistry registry, SettlementEngine.Leg calldata leg, uint256 i)
        internal
        view
        returns (SettlementToken token, bytes32 authority)
    {
        if (!registry.isListed(leg.token)) revert SettlementEngine.TokenNotListed(i, leg.token);
        if (leg.amount == 0) revert SettlementEngine.InvalidLeg(i);
        token = SettlementToken(leg.token);
        if (leg.kind == SettlementEngine.LegKind.Mint) {
            if (leg.from != address(0) || leg.to == address(0)) revert SettlementEngine.InvalidLeg(i);
            authority = token.issuer();
        } else if (leg.kind == SettlementEngine.LegKind.Burn) {
            if (leg.from == address(0) || leg.to != address(0)) revert SettlementEngine.InvalidLeg(i);
            authority = holderAuthority(registry, token, leg.from);
        } else {
            if (leg.from == address(0) || leg.to == address(0) || leg.from == leg.to) {
                revert SettlementEngine.InvalidLeg(i);
            }
            authority = holderAuthority(registry, token, leg.from);
        }
    }

    function holderAuthority(ParticipantRegistry registry, SettlementToken token, address holder)
        internal
        view
        returns (bytes32)
    {
        bytes32 participant = registry.participantOf(holder);
        return participant != bytes32(0) ? participant : token.issuer();
    }

    function contains(bytes32[] memory set, bytes32 value) internal pure returns (bool) {
        for (uint256 i; i < set.length; ++i) {
            if (set[i] == value) return true;
        }
        return false;
    }
}
