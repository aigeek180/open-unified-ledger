// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice What the registry reads of a token it lists: the participant whose liability it is.
interface IIssuedToken {
    function issuer() external view returns (bytes32);
}

/// @title ParticipantRegistry
/// @notice Who may take part in settlement on the shared ledger (SPEC.md §4.2): which addresses belong to
/// which participant, what kind each participant is, whether it is active, and which tokens the settlement
/// engine may move. A ledger may carry several currencies, each with its own central bank (SPEC.md §13):
/// the first central bank operates the registry and admits the others, and each central bank lists its own
/// wholesale token.
/// @dev Participants are identified by a bytes32 id (the scenario's participant id, hashed). An address
/// belongs to at most one participant; an address that belongs to none is a customer, acting through the
/// bank that issued the token it holds. A participant's address is either a signing key, which submits and
/// approves instructions and holds the participant's roles on every contract, or a holding address, which
/// holds balances for it and signs nothing: a retired signing key, or a custody address (SPEC.md §15).
/// Roles here and on every token are the participant's, held through its active signing keys, so moving to
/// a new key (`rotateKey`) moves every role in one change.
contract ParticipantRegistry is AccessControl, EIP712 {
    enum Kind {
        None,
        CentralBank,
        Bank
    }

    struct Participant {
        Kind kind;
        bool active;
    }

    /// @notice May admit, suspend and reinstate participants, bind addresses and list tokens: the operator.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice What a participant signs to move to a new key: its current key consents, the new key proves
    /// it is held. `nonce` is the participant's rotations so far, so neither signature can be used twice.
    bytes32 public constant KEY_ROTATION_TYPEHASH =
        keccak256("KeyRotation(bytes32 participant,address oldKey,address newKey,uint256 nonce)");

    mapping(bytes32 id => Participant) private _participants;
    mapping(address account => bytes32 id) private _participantOf;
    /// @dev Bound addresses that may sign for their participant; the rest hold balances only.
    mapping(address account => bool) private _signer;
    /// @dev Signing keys retired by a rotation: they sign nothing now, but what they signed while active stands.
    mapping(address account => bool) private _retired;
    mapping(bytes32 id => uint256) private _rotations;
    mapping(address token => bool) private _listed;

    event ParticipantAdmitted(bytes32 indexed id, Kind kind);
    event ParticipantSuspended(bytes32 indexed id);
    event ParticipantReinstated(bytes32 indexed id);
    event AddressBound(bytes32 indexed id, address indexed account);
    event AddressUnbound(bytes32 indexed id, address indexed account);
    event TokenListed(address indexed token);
    event TokenDelisted(address indexed token);
    event HoldingAddressBound(bytes32 indexed id, address indexed account);
    event KeyRotated(bytes32 indexed id, address indexed oldKey, address indexed newKey);

    error UnknownParticipant(bytes32 id);
    error ParticipantExists(bytes32 id);
    error InvalidParticipant();
    error AddressAlreadyBound(address account, bytes32 id);
    error AddressNotBound(address account);
    error CentralBankNotSuspendable(bytes32 id);
    error NotTokenLister(address account, address token);
    error NotASigningKey(address account, bytes32 id);
    error InvalidRotationSignature(address signer);

    /// @notice The central bank that operates the registry: the first one admitted.
    bytes32 public immutable operator;

    /// @param operatorId The operating central bank's participant id; its signing keys hold the admin and
    /// registrar roles.
    /// @param operatorAccount The operating central bank's first signing key.
    constructor(bytes32 operatorId, address operatorAccount) EIP712("Open Unified Ledger Registry", "1") {
        operator = operatorId;
        _admit(operatorId, Kind.CentralBank, operatorAccount);
    }

    /// @notice Roles here belong to the operating central bank, held through its active signing keys; a role
    /// granted to an address outside every participant (a contract) is held as AccessControl grants it.
    function hasRole(bytes32 role, address account) public view override returns (bool) {
        if (_participantOf[account] != bytes32(0)) return _signerOf(account) == operator;
        return super.hasRole(role, account);
    }

    // ---------------------------------------------------------------- administration

    /// @notice Admit another currency's central bank, which then issues and lists its own wholesale token.
    function admitCentralBank(bytes32 id, address account) external onlyRole(REGISTRAR_ROLE) {
        _admit(id, Kind.CentralBank, account);
    }

    function admitBank(bytes32 id, address account) external onlyRole(REGISTRAR_ROLE) {
        _admit(id, Kind.Bank, account);
    }

    /// @notice Suspend a bank. A central bank is never suspended: its currency is its own, and it cuts a bank
    /// off from that currency by closing the bank's reserve account on its wholesale token instead.
    function suspend(bytes32 id) external onlyRole(REGISTRAR_ROLE) {
        Participant storage p = _existing(id);
        if (p.kind == Kind.CentralBank) revert CentralBankNotSuspendable(id);
        if (p.active) {
            p.active = false;
            emit ParticipantSuspended(id);
        }
    }

    function reinstate(bytes32 id) external onlyRole(REGISTRAR_ROLE) {
        Participant storage p = _existing(id);
        if (!p.active) {
            p.active = true;
            emit ParticipantReinstated(id);
        }
    }

    /// @notice Bind another signing key to a participant.
    function bindAddress(bytes32 id, address account) external onlyRole(REGISTRAR_ROLE) {
        _existing(id);
        _bind(id, account);
    }

    /// @notice Bind an address that holds balances for a participant and signs nothing for it: a custody
    /// address whose movements the participant authorizes with its signing keys.
    function bindHoldingAddress(bytes32 id, address account) external onlyRole(REGISTRAR_ROLE) {
        _existing(id);
        _bind(id, account);
        _signer[account] = false;
        emit HoldingAddressBound(id, account);
    }

    /// @notice Move a participant from `oldKey` to `newKey` in one change: the new key is bound as a signing
    /// key, the old one retired to a holding address, so it keeps what it holds for the participant but no
    /// longer submits, approves or holds any role. Every role the participant holds, here and on every
    /// token, moves with it, since roles follow the participant's active signing keys. The registrar sends it;
    /// the participant consents with its old key and proves it holds the new one, both over the EIP-712
    /// `KeyRotation` digest.
    function rotateKey(
        bytes32 id,
        address oldKey,
        address newKey,
        bytes calldata oldKeyConsent,
        bytes calldata newKeyProof
    ) external onlyRole(REGISTRAR_ROLE) {
        _existing(id);
        if (_signerOf(oldKey) != id) revert NotASigningKey(oldKey, id);
        bytes32 hash = rotationDigest(id, oldKey, newKey);
        if (!_signedBy(oldKey, hash, oldKeyConsent)) revert InvalidRotationSignature(oldKey);
        if (!_signedBy(newKey, hash, newKeyProof)) revert InvalidRotationSignature(newKey);
        _rotations[id] += 1;
        _bind(id, newKey);
        // Announced by KeyRotated below, which names the retired key.
        // forge-lint: disable-next-line(missing-events-access-control)
        _signer[oldKey] = false;
        _retired[oldKey] = true;
        // The only call before it is the ecrecover precompile, which cannot reenter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit KeyRotated(id, oldKey, newKey);
    }

    function unbindAddress(address account) external onlyRole(REGISTRAR_ROLE) {
        bytes32 id = _participantOf[account];
        if (id == bytes32(0)) revert AddressNotBound(account);
        delete _participantOf[account];
        // Announced by AddressUnbound below.
        // forge-lint: disable-next-line(missing-events-access-control)
        delete _signer[account];
        delete _retired[account];
        emit AddressUnbound(id, account);
    }

    /// @notice Let the settlement engine move `token`. The operator lists any token; another central bank
    /// lists the tokens it issues.
    function listToken(address token) external onlyLister(token) {
        if (!_listed[token]) {
            _listed[token] = true;
            emit TokenListed(token);
        }
    }

    function delistToken(address token) external onlyLister(token) {
        if (_listed[token]) {
            _listed[token] = false;
            emit TokenDelisted(token);
        }
    }

    // ---------------------------------------------------------------- reads

    function participant(bytes32 id) external view returns (Participant memory) {
        return _participants[id];
    }

    /// @notice The participant an address belongs to, signing key or holding address, or zero for a customer
    /// address: whose balance it is, and so whose approval moves it.
    function participantOf(address account) external view returns (bytes32) {
        return _participantOf[account];
    }

    /// @notice The participant `account` signs for, if it is one of its active signing keys; zero otherwise.
    function signerOf(address account) external view returns (bytes32) {
        return _signerOf(account);
    }

    /// @notice Whose signing key `account` is or was, and whether it still signs: a key a rotation retired keeps
    /// its participant, so what it signed while active, such as an identity claim, can still be told apart
    /// from a signature by a key that never signed for anyone.
    function keyOf(address account) external view returns (bytes32 id, bool active) {
        if (_signer[account]) return (_participantOf[account], true);
        if (_retired[account]) return (_participantOf[account], false);
        return (bytes32(0), false);
    }

    /// @notice How many times a participant has moved to a new key: the nonce of its next rotation.
    function rotations(bytes32 id) external view returns (uint256) {
        return _rotations[id];
    }

    /// @notice The EIP-712 digest a participant's old and new keys sign to rotate.
    function rotationDigest(bytes32 id, address oldKey, address newKey) public view returns (bytes32) {
        return
            _hashTypedDataV4(keccak256(abi.encode(KEY_ROTATION_TYPEHASH, id, oldKey, newKey, _rotations[id])));
    }

    function isActive(bytes32 id) public view returns (bool) {
        return _participants[id].active;
    }

    /// @notice Whether `account` belongs to an active participant of `kind`.
    function isActiveOfKind(address account, Kind kind) external view returns (bool) {
        Participant storage p = _participants[_participantOf[account]];
        return p.active && p.kind == kind;
    }

    function isListed(address token) external view returns (bool) {
        return _listed[token];
    }

    // ---------------------------------------------------------------- internals

    modifier onlyLister(address token) {
        if (!hasRole(REGISTRAR_ROLE, msg.sender) && !_isIssuingCentralBank(msg.sender, token)) {
            revert NotTokenLister(msg.sender, token);
        }
        _;
    }

    /// @dev Whether `account` is a signing key of an active central bank that issues `token`.
    function _isIssuingCentralBank(address account, address token) private view returns (bool) {
        bytes32 id = _signerOf(account);
        Participant storage p = _participants[id];
        if (!p.active || p.kind != Kind.CentralBank) return false;
        try IIssuedToken(token).issuer() returns (bytes32 tokenIssuer) {
            return tokenIssuer == id;
        } catch {
            return false;
        }
    }

    function _admit(bytes32 id, Kind kind, address account) private {
        if (id == bytes32(0) || kind == Kind.None) revert InvalidParticipant();
        if (_participants[id].kind != Kind.None) revert ParticipantExists(id);
        _participants[id] = Participant({kind: kind, active: true});
        emit ParticipantAdmitted(id, kind);
        _bind(id, account);
    }

    function _bind(bytes32 id, address account) private {
        if (account == address(0)) revert InvalidParticipant();
        bytes32 current = _participantOf[account];
        if (current != bytes32(0)) revert AddressAlreadyBound(account, current);
        _participantOf[account] = id;
        // Announced by AddressBound below; a holding address is announced again by HoldingAddressBound.
        // forge-lint: disable-next-line(missing-events-access-control)
        _signer[account] = true;
        // In a rotation, the only call before it is the ecrecover precompile, which cannot reenter.
        // forge-lint: disable-next-line(reentrancy-events)
        emit AddressBound(id, account);
    }

    /// @dev Signing keys are EOAs: a rotation's signatures are plain ECDSA, so checking them calls nothing.
    function _signedBy(address key, bytes32 hash, bytes calldata signature) private pure returns (bool) {
        (address recovered, ECDSA.RecoverError failure,) = ECDSA.tryRecover(hash, signature);
        return failure == ECDSA.RecoverError.NoError && recovered == key;
    }

    function _signerOf(address account) private view returns (bytes32) {
        return _signer[account] ? _participantOf[account] : bytes32(0);
    }

    function _existing(bytes32 id) private view returns (Participant storage p) {
        p = _participants[id];
        if (p.kind == Kind.None) revert UnknownParticipant(id);
    }
}
