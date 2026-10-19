// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {LegAuthority, SettlementEngine} from "./SettlementEngine.sol";
import {SettlementToken} from "./SettlementToken.sol";

/// @notice The part of Paladin's Noto V1 lock interface this contract uses (ILockableCapability).
interface INotoLocks {
    function spendLock(bytes32 lockId, bytes calldata spendArgs, bytes calldata data) external;
    function cancelLock(bytes32 lockId, bytes calldata cancelArgs, bytes calldata data) external;
}

/// @title ConfidentialSettlement
/// @notice An interbank payment in confidential mode (SPEC.md §10), settled atomically on the shared ledger.
/// The deposits are Paladin Noto tokens, private to their bank: the payer's bank locks a burn of its
/// customer's deposit, the payee's bank locks a mint of its customer's, each delegates its lock to this
/// contract, and one call here moves the wholesale leg and spends both locks, or does none of it.
/// @dev The wholesale legs are authorized exactly as the settlement engine authorizes them (LegAuthority).
/// A Noto leg is covered by the approval of the bank whose deposit token it is, since spending the lock
/// burns or mints that bank's liability; the bank also chose to delegate the lock here. Approvals cover the
/// whole payment: its id, wholesale legs, Noto locks and the hashes of their spend arguments, and deadline.
/// The spend arguments come from each lock's Paladin domain receipt; Noto checks them against the
/// commitments it recorded when the lock was made, so nothing else can be spent. A bank may cancel a lock it
/// delegated here while the payment is unsettled, with the cancel arguments from the same receipt: that only
/// aborts the payment. Needs SETTLEMENT_ROLE on the wholesale token.
contract ConfidentialSettlement is EIP712, AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    struct NotoLeg {
        address noto;
        bytes32 lockId;
        bytes spendArgs;
    }

    struct Payment {
        bytes32 id;
        SettlementEngine.Leg[] legs;
        NotoLeg[] notoLegs;
        uint64 deadline;
    }

    bytes32 public constant LEG_TYPEHASH =
        keccak256("Leg(uint8 kind,address token,address from,address to,uint256 amount)");
    bytes32 public constant NOTO_LEG_TYPEHASH =
        keccak256("NotoLeg(address noto,bytes32 lockId,bytes spendArgs)");
    bytes32 public constant PAYMENT_TYPEHASH = keccak256(
        "Payment(bytes32 id,Leg[] legs,NotoLeg[] notoLegs,uint64 deadline)"
        "Leg(uint8 kind,address token,address from,address to,uint256 amount)"
        "NotoLeg(address noto,bytes32 lockId,bytes spendArgs)"
    );
    uint256 public constant MAX_LEGS = 8;
    uint256 public constant MAX_APPROVALS = 8;

    ParticipantRegistry public immutable registry;

    /// @notice The bank whose deposit each listed Noto token is.
    mapping(address noto => bytes32 bank) public bankOf;
    /// @notice The block a payment settled in, or zero.
    mapping(bytes32 id => uint256 blockNumber) public settledAt;

    event NotoListed(address indexed noto, bytes32 indexed bank);
    event PaymentSettled(
        bytes32 indexed id, bytes32 indexed submitter, uint256 legCount, uint256 notoLegCount
    );
    event LockCancelled(address indexed noto, bytes32 indexed lockId, bytes32 indexed bank);

    error NotASubmitter(address account);
    error InvalidPaymentId();
    error AlreadySettled(bytes32 id, uint256 blockNumber);
    error PaymentExpired(bytes32 id, uint64 deadline);
    error InvalidLegCount(uint256 legs, uint256 notoLegs);
    error TooManyApprovals(uint256 count);
    error NotoNotListed(address noto);
    error MissingNotoApproval(uint256 notoLeg, bytes32 bank);
    error NotTheBank(address noto, address caller);

    constructor(ParticipantRegistry registry_, address registrar) EIP712("OUL Confidential Settlement", "1") {
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, registrar);
        _grantRole(REGISTRAR_ROLE, registrar);
    }

    /// @notice Record which bank a Noto deposit token belongs to. The central bank keeps the list, as it keeps
    /// the list of tokens the engine may move.
    function listNoto(address noto, bytes32 bank) external onlyRole(REGISTRAR_ROLE) {
        if (registry.participant(bank).kind != ParticipantRegistry.Kind.Bank) {
            revert NotTheBank(noto, msg.sender);
        }
        bankOf[noto] = bank;
        emit NotoListed(noto, bank);
    }

    /// @notice The EIP-712 digest participants sign to approve `payment`.
    function digest(Payment calldata payment) public view returns (bytes32) {
        bytes32[] memory legHashes = new bytes32[](payment.legs.length);
        for (uint256 i; i < payment.legs.length; ++i) {
            SettlementEngine.Leg calldata leg = payment.legs[i];
            legHashes[i] =
                keccak256(abi.encode(LEG_TYPEHASH, leg.kind, leg.token, leg.from, leg.to, leg.amount));
        }
        bytes32[] memory notoHashes = new bytes32[](payment.notoLegs.length);
        for (uint256 i; i < payment.notoLegs.length; ++i) {
            NotoLeg calldata n = payment.notoLegs[i];
            notoHashes[i] = keccak256(abi.encode(NOTO_LEG_TYPEHASH, n.noto, n.lockId, keccak256(n.spendArgs)));
        }
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PAYMENT_TYPEHASH,
                    payment.id,
                    keccak256(abi.encodePacked(legHashes)),
                    keccak256(abi.encodePacked(notoHashes)),
                    payment.deadline
                )
            )
        );
    }

    /// @notice Move every wholesale leg and spend every Noto lock of `payment`, or revert and do none of it.
    function settle(Payment calldata payment, SettlementEngine.Approval[] calldata approvals) external {
        bytes32 submitter = registry.signerOf(msg.sender);
        if (submitter == bytes32(0) || !registry.isActive(submitter)) revert NotASubmitter(msg.sender);
        bytes32 id = payment.id;
        if (id == bytes32(0)) revert InvalidPaymentId();
        if (settledAt[id] != 0) revert AlreadySettled(id, settledAt[id]);
        // As in the engine, block time only retires stale approvals.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > payment.deadline) revert PaymentExpired(id, payment.deadline);
        uint256 legCount = payment.legs.length;
        uint256 notoCount = payment.notoLegs.length;
        if (legCount + notoCount == 0 || legCount > MAX_LEGS || notoCount > MAX_LEGS) {
            revert InvalidLegCount(legCount, notoCount);
        }
        if (approvals.length > MAX_APPROVALS) revert TooManyApprovals(approvals.length);

        bytes32[] memory approvers = LegAuthority.approvers(registry, digest(payment), approvals, submitter);
        for (uint256 i; i < notoCount; ++i) {
            bytes32 bank = bankOf[payment.notoLegs[i].noto];
            if (bank == bytes32(0)) revert NotoNotListed(payment.notoLegs[i].noto);
            if (!LegAuthority.contains(approvers, bank)) revert MissingNotoApproval(i, bank);
        }

        settledAt[id] = block.number;
        // The only calls before this are views (registry reads, ERC-1271 checks), which cannot reenter; if any
        // leg fails, the revert discards the event with everything else.
        // forge-lint: disable-next-line(reentrancy-events)
        emit PaymentSettled(id, submitter, legCount, notoCount);

        for (uint256 i; i < legCount; ++i) {
            SettlementEngine.Leg calldata leg = payment.legs[i];
            SettlementToken token = LegAuthority.authorize(registry, approvers, leg, i);
            if (leg.kind == SettlementEngine.LegKind.Mint) token.settleMint(leg.to, leg.amount);
            else if (leg.kind == SettlementEngine.LegKind.Burn) token.settleBurn(leg.from, leg.amount);
            else token.settleTransfer(leg.from, leg.to, leg.amount);
        }
        for (uint256 i; i < notoCount; ++i) {
            NotoLeg calldata n = payment.notoLegs[i];
            INotoLocks(n.noto).spendLock(n.lockId, n.spendArgs, abi.encode(id));
        }
    }

    /// @notice A bank cancels a lock on its own deposit token that it delegated here, returning what it held.
    /// A payment that needed the lock can then no longer settle.
    function cancel(address noto, bytes32 lockId, bytes calldata cancelArgs) external {
        bytes32 bank = bankOf[noto];
        if (bank == bytes32(0)) revert NotoNotListed(noto);
        if (registry.signerOf(msg.sender) != bank || !registry.isActive(bank)) {
            revert NotTheBank(noto, msg.sender);
        }
        emit LockCancelled(noto, lockId, bank);
        INotoLocks(noto).cancelLock(lockId, cancelArgs, "");
    }
}
