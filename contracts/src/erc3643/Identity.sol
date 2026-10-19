// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";

/// @title Identity
/// @notice An on-chain identity for ERC-3643 (SPEC.md §4.2, §15): keys with purposes (ERC-734) and claims
/// about it by issuers (ERC-735). Written from those published texts.
/// @dev Each identity is managed by a participant: the bank of the customer it belongs to, or a bank or
/// central bank for its own. The manager's active signing keys in the participant registry hold every purpose
/// here, so a key rotation moves the management of every identity it manages in the same change; further
/// keys may be added explicitly (a wallet that recovery may bind to it, for one). Customers sign nothing: their
/// bank manages their identities.
///
/// A claim is signed over keccak256(abi.encode(identity, topic, data)), as an EIP-191 personal message: the
/// form the ERC-735 text describes. This identity, as an issuer, holds a claim valid if a claim key signed it
/// (an explicit one, or a key its manager signs or signed with), which `ClaimIssuer` refines with revocation.
contract Identity is IIdentity {
    uint256 public constant MANAGEMENT_KEY = 1;
    /// @notice ERC-734's execution key, which ERC-3643 identities call an action key.
    uint256 public constant ACTION_KEY = 2;
    /// @notice The purpose of a key that signs claims: 3, by the convention of ERC-734 identities.
    uint256 public constant CLAIM_SIGNER_KEY = 3;
    uint256 public constant ECDSA_TYPE = 1;

    ParticipantRegistry public immutable participantRegistry;
    /// @notice The participant that manages this identity.
    bytes32 public immutable manager;

    struct Key {
        uint256[] purposes;
        uint256 keyType;
        bytes32 key;
    }

    struct Execution {
        address to;
        uint256 value;
        bytes data;
        uint256 approvals;
        bool executed;
    }

    struct Claim {
        uint256 topic;
        uint256 scheme;
        address issuer;
        bytes signature;
        bytes data;
        string uri;
    }

    mapping(bytes32 key => Key) private _keys;
    mapping(uint256 purpose => bytes32[]) private _keysByPurpose;
    mapping(uint256 purpose => uint256) private _keysRequired;
    mapping(uint256 id => Execution) private _executions;
    mapping(uint256 id => mapping(bytes32 key => bool)) private _approvedBy;
    uint256 private _executionNonce;
    mapping(bytes32 claimId => Claim) private _claims;
    mapping(uint256 topic => bytes32[]) private _claimsByTopic;

    error NotAKey(address account, uint256 purpose);
    error KeyExists(bytes32 key, uint256 purpose);
    error NoSuchKey(bytes32 key, uint256 purpose);
    error NoSuchExecution(uint256 id);
    error AlreadyExecuted(uint256 id);
    error ExecutionFailed(uint256 id);
    error InvalidClaim(address issuer, uint256 topic);
    error NoSuchClaim(bytes32 claimId);
    error InvalidKeysRequired(uint256 number);

    /// @param managerKey A signing key of the participant that manages this identity.
    constructor(ParticipantRegistry registry_, address managerKey) {
        participantRegistry = registry_;
        manager = registry_.signerOf(managerKey);
        if (manager == bytes32(0)) revert NotAKey(managerKey, MANAGEMENT_KEY);
    }

    // ---------------------------------------------------------------- ERC-734 keys

    /// @notice Whether `account` holds `purpose` here: an explicit key with it (or with management, which holds
    /// every purpose), or an active signing key of the manager.
    function hasPurpose(address account, uint256 purpose) public view returns (bool) {
        return keyHasPurpose(keccak256(abi.encode(account)), purpose)
            || participantRegistry.signerOf(account) == manager;
    }

    function getKey(bytes32 key)
        external
        view
        returns (uint256[] memory purposes, uint256 keyType, bytes32 key_)
    {
        Key storage k = _keys[key];
        return (k.purposes, k.keyType, k.key);
    }

    function keyHasPurpose(bytes32 key, uint256 purpose) public view returns (bool exists) {
        uint256[] storage purposes = _keys[key].purposes;
        for (uint256 i; i < purposes.length; ++i) {
            if (purposes[i] == purpose || purposes[i] == MANAGEMENT_KEY) return true;
        }
        return false;
    }

    function getKeysByPurpose(uint256 purpose) external view returns (bytes32[] memory keys) {
        return _keysByPurpose[purpose];
    }

    function addKey(bytes32 key, uint256 purpose, uint256 keyType) external returns (bool success) {
        _requireManagement();
        Key storage k = _keys[key];
        for (uint256 i; i < k.purposes.length; ++i) {
            if (k.purposes[i] == purpose) revert KeyExists(key, purpose);
        }
        k.purposes.push(purpose);
        k.keyType = keyType;
        k.key = key;
        _keysByPurpose[purpose].push(key);
        emit KeyAdded(key, purpose, keyType);
        return true;
    }

    function removeKey(bytes32 key, uint256 purpose) external returns (bool success) {
        _requireManagement();
        Key storage k = _keys[key];
        if (!_remove(k.purposes, purpose)) revert NoSuchKey(key, purpose);
        _removeKey(_keysByPurpose[purpose], key);
        uint256 keyType = k.keyType;
        if (k.purposes.length == 0) delete _keys[key];
        emit KeyRemoved(key, purpose, keyType);
        return true;
    }

    /// @notice How many keys with `purpose` must approve an execution needing it before it runs; 1 by default.
    function changeKeysRequired(uint256 purpose, uint256 number) external {
        _requireManagement();
        if (number == 0) revert InvalidKeysRequired(number);
        _keysRequired[purpose] = number;
        emit KeysRequiredChanged(purpose, number);
    }

    function getKeysRequired(uint256 purpose) public view returns (uint256) {
        uint256 n = _keysRequired[purpose];
        return n == 0 ? 1 : n;
    }

    /// @notice Request a call from this identity: a call to the identity itself needs management keys, any
    /// other an action key. A key with that purpose requesting it counts as its first approval.
    function execute(address to, uint256 value, bytes calldata data)
        external
        payable
        returns (uint256 executionId)
    {
        executionId = _executionNonce++;
        _executions[executionId] =
            Execution({to: to, value: value, data: data, approvals: 0, executed: false});
        emit ExecutionRequested(executionId, to, value, data);
        if (hasPurpose(msg.sender, _purposeFor(to))) _approve(executionId);
    }

    function approve(uint256 id, bool approve_) external returns (bool success) {
        Execution storage e = _executions[id];
        if (id >= _executionNonce) revert NoSuchExecution(id);
        if (e.executed) revert AlreadyExecuted(id);
        uint256 purpose = _purposeFor(e.to);
        if (!hasPurpose(msg.sender, purpose)) revert NotAKey(msg.sender, purpose);
        if (!approve_) {
            emit Approved(id, false);
            return true;
        }
        _approve(id);
        return true;
    }

    // ---------------------------------------------------------------- ERC-735 claims

    function getClaim(bytes32 claimId)
        external
        view
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        )
    {
        Claim storage c = _claims[claimId];
        return (c.topic, c.scheme, c.issuer, c.signature, c.data, c.uri);
    }

    function getClaimIdsByTopic(uint256 topic) external view returns (bytes32[] memory claimIds) {
        return _claimsByTopic[topic];
    }

    /// @notice Add or replace the claim `issuer` makes on `topic` about this identity. Only a claim key here
    /// may add one, and only a claim its issuer holds valid: one per issuer and topic.
    function addClaim(
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes calldata signature,
        bytes calldata data,
        string calldata uri
    ) external returns (uint256 claimRequestId) {
        if (!hasPurpose(msg.sender, CLAIM_SIGNER_KEY)) {
            revert NotAKey(msg.sender, CLAIM_SIGNER_KEY);
        }
        if (issuer != address(this) && !IIdentity(issuer).isClaimValid(this, topic, signature, data)) {
            revert InvalidClaim(issuer, topic);
        }
        bytes32 claimId = keccak256(abi.encode(issuer, topic));
        bool exists = _claims[claimId].issuer != address(0);
        _claims[claimId] =
            Claim({topic: topic, scheme: scheme, issuer: issuer, signature: signature, data: data, uri: uri});
        if (exists) {
            emit ClaimChanged(claimId, topic, scheme, issuer, signature, data, uri);
        } else {
            _claimsByTopic[topic].push(claimId);
            emit ClaimAdded(claimId, topic, scheme, issuer, signature, data, uri);
        }
        return uint256(claimId);
    }

    /// @notice Replace a claim with the issuer's new one on the same topic.
    function changeClaim(
        bytes32 claimId,
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes calldata signature,
        bytes calldata data,
        string calldata uri
    ) external returns (bool success) {
        if (!hasPurpose(msg.sender, CLAIM_SIGNER_KEY)) {
            revert NotAKey(msg.sender, CLAIM_SIGNER_KEY);
        }
        if (_claims[claimId].issuer == address(0) || keccak256(abi.encode(issuer, topic)) != claimId) {
            revert NoSuchClaim(claimId);
        }
        if (issuer != address(this) && !IIdentity(issuer).isClaimValid(this, topic, signature, data)) {
            revert InvalidClaim(issuer, topic);
        }
        _claims[claimId] =
            Claim({topic: topic, scheme: scheme, issuer: issuer, signature: signature, data: data, uri: uri});
        emit ClaimChanged(claimId, topic, scheme, issuer, signature, data, uri);
        return true;
    }

    /// @notice Remove a claim: by a claim key here, or by the claim's issuer.
    function removeClaim(bytes32 claimId) external returns (bool success) {
        Claim memory c = _claims[claimId];
        if (c.issuer == address(0)) revert NoSuchClaim(claimId);
        if (msg.sender != c.issuer && !hasPurpose(msg.sender, CLAIM_SIGNER_KEY)) {
            revert NotAKey(msg.sender, CLAIM_SIGNER_KEY);
        }
        _removeKey(_claimsByTopic[c.topic], claimId);
        delete _claims[claimId];
        emit ClaimRemoved(claimId, c.topic, c.scheme, c.issuer, c.signature, c.data, c.uri);
        return true;
    }

    /// @notice Whether this identity, as an issuer, signed `data` on `topic` about `identity`: with an explicit
    /// claim key, or with a key its manager signs with or signed with before a rotation retired it.
    function isClaimValid(IIdentity identity, uint256 topic, bytes calldata signature, bytes calldata data)
        public
        view
        virtual
        returns (bool)
    {
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(keccak256(abi.encode(identity, topic, data)));
        (address signer, ECDSA.RecoverError failure,) = ECDSA.tryRecover(hash, signature);
        if (failure != ECDSA.RecoverError.NoError) return false;
        if (keyHasPurpose(keccak256(abi.encode(signer)), CLAIM_SIGNER_KEY)) return true;
        // Retired or not: what a key signed while it was active stands.
        // forge-lint: disable-next-line(unused-return)
        (bytes32 participant,) = participantRegistry.keyOf(signer);
        return participant != bytes32(0) && participant == manager;
    }

    // ---------------------------------------------------------------- internals

    function _requireManagement() internal view {
        if (msg.sender != address(this) && !hasPurpose(msg.sender, MANAGEMENT_KEY)) {
            revert NotAKey(msg.sender, MANAGEMENT_KEY);
        }
    }

    function _purposeFor(address to) private view returns (uint256) {
        return to == address(this) ? MANAGEMENT_KEY : ACTION_KEY;
    }

    function _approve(uint256 id) private {
        bytes32 key = keccak256(abi.encode(msg.sender));
        if (!_approvedBy[id][key]) {
            _approvedBy[id][key] = true;
            _executions[id].approvals += 1;
        }
        emit Approved(id, true);
        Execution storage e = _executions[id];
        if (e.approvals < getKeysRequired(_purposeFor(e.to))) return;
        e.executed = true;
        // Announced before the call: if it fails, the revert takes the event with it.
        emit Executed(id, e.to, e.value, e.data);
        // Calling what the identity's own keys approved, with the value they approved, is what ERC-734
        // execution is; whatever the call returns, only whether it succeeded counts.
        // forge-lint: disable-next-line(arbitrary-send-eth,unused-return)
        (bool ok,) = e.to.call{value: e.value}(e.data);
        if (!ok) revert ExecutionFailed(id);
    }

    function _remove(uint256[] storage list, uint256 value) private returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == value) {
                list[i] = list[list.length - 1];
                list.pop();
                return true;
            }
        }
        return false;
    }

    function _removeKey(bytes32[] storage list, bytes32 value) private {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == value) {
                list[i] = list[list.length - 1];
                list.pop();
                return;
            }
        }
    }
}
