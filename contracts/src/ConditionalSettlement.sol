// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {LegAuthority, SettlementEngine} from "./SettlementEngine.sol";
import {SettlementToken} from "./SettlementToken.sol";

/// @title ConditionalSettlement
/// @notice Settlement in two steps, for interop mode (SPEC.md §7), where an instruction's legs live on two
/// ledgers and no single transaction can cover them. Each ledger locks its part, then settles it or
/// releases it, under a condition:
///   - Hashlock (HTLC): it settles for whoever shows the preimage of `hashlock` before `timeout`;
///   - Notary (two-phase commit): it settles when `notary` commits before `timeout`; the notary may abort.
/// After `timeout` anyone may release it. Each ledger can only ever see its own part: that two parts on
/// two ledgers end the same way is up to whoever coordinates them, which is the point interop mode makes.
/// @dev A lock is authorized exactly as the settlement engine authorizes a settlement (LegAuthority), over
/// the instruction and its condition together. Locking freezes, at the holder, what each burn or transfer
/// will take (ERC-7943), so the funds stay where they are and stay eligible; a mint is only recorded,
/// since nothing exists to hold until it settles. This contract needs SETTLEMENT_ROLE and FREEZER_ROLE on
/// every token it moves. A token's issuer also holds FREEZER_ROLE, so a lock on a deposit holds against
/// everyone but the bank that issued it: the sandbox's trust in an issuer over its own liability.
contract ConditionalSettlement is EIP712 {
    enum ConditionKind {
        Hashlock,
        Notary
    }

    struct Condition {
        ConditionKind kind;
        bytes32 hashlock;
        address notary;
        uint64 timeout;
    }

    enum State {
        None,
        Locked,
        Settled,
        Released
    }

    struct Lock {
        State state;
        ConditionKind kind;
        bytes32 hashlock;
        address notary;
        uint64 timeout;
        bytes32 submitter;
        uint64 lockedAt;
        uint64 closedAt;
    }

    bytes32 public constant LEG_TYPEHASH =
        keccak256("Leg(uint8 kind,address token,address from,address to,uint256 amount)");
    bytes32 public constant LOCK_TYPEHASH = keccak256(
        "Lock(bytes32 id,Leg[] legs,uint64 deadline,uint8 kind,bytes32 hashlock,address notary,uint64 timeout)"
        "Leg(uint8 kind,address token,address from,address to,uint256 amount)"
    );
    uint256 public constant MAX_LEGS = 16;
    uint256 public constant MAX_APPROVALS = 8;

    ParticipantRegistry public immutable registry;

    mapping(bytes32 id => Lock) private _locks;
    mapping(bytes32 id => SettlementEngine.Leg[]) private _legs;

    event Locked(
        bytes32 indexed id,
        bytes32 indexed submitter,
        ConditionKind kind,
        bytes32 hashlock,
        address notary,
        uint64 timeout
    );
    /// @notice The lock settled: every leg on this ledger executed. For a hashlock, `preimage` is what
    /// opened it, published here for the other ledger's party to use.
    event Settled(bytes32 indexed id, bytes32 preimage);
    /// @notice The lock was released with nothing moved: aborted by the notary, or past its timeout.
    event Released(bytes32 indexed id, bool timedOut);

    error NotASubmitter(address account);
    error InvalidInstructionId();
    error AlreadyLocked(bytes32 id);
    error InstructionExpired(bytes32 id, uint64 deadline);
    error InvalidLegCount(uint256 count);
    error TooManyApprovals(uint256 count);
    error InvalidCondition();
    error InsufficientUnfrozenBalance(uint256 leg, address holder);
    error NotLocked(bytes32 id);
    error WrongCondition(bytes32 id);
    error WrongPreimage(bytes32 id);
    error NotTheNotary(bytes32 id, address caller);
    error TimedOut(bytes32 id, uint64 timeout);
    error NotTimedOut(bytes32 id, uint64 timeout);

    constructor(ParticipantRegistry registry_) EIP712("OUL Conditional Settlement", "1") {
        registry = registry_;
    }

    // ---------------------------------------------------------------- reads

    function lockOf(bytes32 id) external view returns (Lock memory) {
        return _locks[id];
    }

    function legsOf(bytes32 id) external view returns (SettlementEngine.Leg[] memory) {
        return _legs[id];
    }

    /// @notice The EIP-712 digest participants sign to approve locking `instruction` under `condition`.
    function digest(SettlementEngine.Instruction calldata instruction, Condition calldata condition)
        public
        view
        returns (bytes32)
    {
        uint256 count = instruction.legs.length;
        bytes32[] memory legHashes = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            SettlementEngine.Leg calldata leg = instruction.legs[i];
            legHashes[i] =
                keccak256(abi.encode(LEG_TYPEHASH, leg.kind, leg.token, leg.from, leg.to, leg.amount));
        }
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LOCK_TYPEHASH,
                    instruction.id,
                    keccak256(abi.encodePacked(legHashes)),
                    instruction.deadline,
                    condition.kind,
                    condition.hashlock,
                    condition.notary,
                    condition.timeout
                )
            )
        );
    }

    // ---------------------------------------------------------------- lock

    /// @notice Lock this ledger's legs of `instruction` under `condition`: authorized as a settlement
    /// would be, what each burn or transfer takes frozen at its holder.
    function lock(
        SettlementEngine.Instruction calldata instruction,
        SettlementEngine.Approval[] calldata approvals,
        Condition calldata condition
    ) external {
        bytes32 submitter = registry.signerOf(msg.sender);
        if (submitter == bytes32(0) || !registry.isActive(submitter)) revert NotASubmitter(msg.sender);
        bytes32 id = instruction.id;
        if (id == bytes32(0)) revert InvalidInstructionId();
        if (_locks[id].state != State.None) revert AlreadyLocked(id);
        // As in the engine, block time only retires stale approvals and bounds a lock's life.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > instruction.deadline) revert InstructionExpired(id, instruction.deadline);
        uint256 legCount = instruction.legs.length;
        if (legCount == 0 || legCount > MAX_LEGS) revert InvalidLegCount(legCount);
        if (approvals.length > MAX_APPROVALS) revert TooManyApprovals(approvals.length);
        _checkCondition(condition);

        bytes32[] memory approvers =
            LegAuthority.approvers(registry, digest(instruction, condition), approvals, submitter);

        // Block time is seconds since 1970; it fits a uint64 for the next 500 billion years.
        _locks[id] = Lock({
            state: State.Locked,
            kind: condition.kind,
            hashlock: condition.hashlock,
            notary: condition.notary,
            timeout: condition.timeout,
            submitter: submitter,
            // forge-lint: disable-next-line(unsafe-typecast)
            lockedAt: uint64(block.timestamp),
            closedAt: 0
        });
        // The event goes out with the lock; if any leg fails, the revert discards both. The only calls before
        // this are views (registry reads, ERC-1271 checks), which cannot reenter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Locked(id, submitter, condition.kind, condition.hashlock, condition.notary, condition.timeout);
        SettlementEngine.Leg[] storage stored = _legs[id];
        for (uint256 i; i < legCount; ++i) {
            SettlementEngine.Leg calldata leg = instruction.legs[i];
            SettlementToken token = LegAuthority.authorize(registry, approvers, leg, i);
            stored.push(leg);
            if (leg.kind == SettlementEngine.LegKind.Mint) continue;
            uint256 frozen = token.getFrozenTokens(leg.from);
            uint256 balance = token.balanceOf(leg.from);
            if (balance < frozen || balance - frozen < leg.amount) {
                revert InsufficientUnfrozenBalance(i, leg.from);
            }
            // setFrozenTokens returns true or reverts.
            // forge-lint: disable-next-line(unused-return)
            token.setFrozenTokens(leg.from, frozen + leg.amount);
        }
    }

    // ---------------------------------------------------------------- settle

    /// @notice Settle a hashlocked lock with the preimage of its hashlock, before its timeout. Anyone may:
    /// knowing the preimage is the authority.
    function claim(bytes32 id, bytes32 preimage) external {
        Lock storage l = _open(id, ConditionKind.Hashlock);
        if (sha256(abi.encodePacked(preimage)) != l.hashlock) revert WrongPreimage(id);
        _settle(id, l, preimage);
    }

    /// @notice The notary commits a notarized lock, before its timeout.
    function commit(bytes32 id) external {
        Lock storage l = _open(id, ConditionKind.Notary);
        if (msg.sender != l.notary) revert NotTheNotary(id, msg.sender);
        _settle(id, l, bytes32(0));
    }

    // ---------------------------------------------------------------- release

    /// @notice The notary aborts a notarized lock it has not committed: nothing moves.
    function abort(bytes32 id) external {
        Lock storage l = _locks[id];
        if (l.state != State.Locked) revert NotLocked(id);
        if (l.kind != ConditionKind.Notary) revert WrongCondition(id);
        if (msg.sender != l.notary) revert NotTheNotary(id, msg.sender);
        _release(id, l, false);
    }

    /// @notice Release a lock past its timeout: nothing moves. Anyone may.
    function refund(bytes32 id) external {
        Lock storage l = _locks[id];
        if (l.state != State.Locked) revert NotLocked(id);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < l.timeout) revert NotTimedOut(id, l.timeout);
        _release(id, l, true);
    }

    // ---------------------------------------------------------------- internals

    function _checkCondition(Condition calldata condition) private view {
        // forge-lint: disable-next-line(block-timestamp)
        if (condition.timeout <= block.timestamp) revert InvalidCondition();
        if (condition.kind == ConditionKind.Hashlock) {
            if (condition.hashlock == bytes32(0) || condition.notary != address(0)) {
                revert InvalidCondition();
            }
        } else if (condition.notary == address(0) || condition.hashlock != bytes32(0)) {
            revert InvalidCondition();
        }
    }

    /// @dev A lock of `kind` that can still settle: locked, and its timeout not reached.
    function _open(bytes32 id, ConditionKind kind) private view returns (Lock storage l) {
        l = _locks[id];
        if (l.state != State.Locked) revert NotLocked(id);
        if (l.kind != kind) revert WrongCondition(id);
        // Settling and releasing split time at the timeout: before it only settling, from it only releasing.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= l.timeout) revert TimedOut(id, l.timeout);
    }

    /// @dev Execute every leg; if any fails (a holder blocked since, a token paused), the call reverts and
    /// the lock stays locked until its timeout.
    function _settle(bytes32 id, Lock storage l, bytes32 preimage) private {
        l.state = State.Settled;
        // forge-lint: disable-next-line(unsafe-typecast)
        l.closedAt = uint64(block.timestamp);
        emit Settled(id, preimage);
        SettlementEngine.Leg[] storage legs = _legs[id];
        for (uint256 i; i < legs.length; ++i) {
            SettlementEngine.Leg storage leg = legs[i];
            SettlementToken token = SettlementToken(leg.token);
            if (leg.kind == SettlementEngine.LegKind.Mint) {
                token.settleMint(leg.to, leg.amount);
                continue;
            }
            _unfreeze(token, leg.from, leg.amount);
            if (leg.kind == SettlementEngine.LegKind.Burn) token.settleBurn(leg.from, leg.amount);
            else token.settleTransfer(leg.from, leg.to, leg.amount);
        }
    }

    function _release(bytes32 id, Lock storage l, bool timedOut) private {
        l.state = State.Released;
        // forge-lint: disable-next-line(unsafe-typecast)
        l.closedAt = uint64(block.timestamp);
        emit Released(id, timedOut);
        SettlementEngine.Leg[] storage legs = _legs[id];
        for (uint256 i; i < legs.length; ++i) {
            SettlementEngine.Leg storage leg = legs[i];
            if (leg.kind != SettlementEngine.LegKind.Mint) {
                _unfreeze(SettlementToken(leg.token), leg.from, leg.amount);
            }
        }
    }

    /// @dev Give back what a lock froze; never below zero, should the issuer have unfrozen it already.
    function _unfreeze(SettlementToken token, address holder, uint256 amount) private {
        uint256 frozen = token.getFrozenTokens(holder);
        // setFrozenTokens returns true or reverts.
        // forge-lint: disable-next-line(unused-return)
        token.setFrozenTokens(holder, frozen > amount ? frozen - amount : 0);
    }
}
