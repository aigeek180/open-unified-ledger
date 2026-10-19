// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {IClaimIssuer, IIdentity} from "./interfaces/IIdentity.sol";
import {
    IClaimTopicsRegistry,
    IIdentityRegistry,
    IIdentityRegistryStorage,
    ITrustedIssuersRegistry
} from "./interfaces/IERC3643.sol";
import {ParticipantRoles} from "./ParticipantRoles.sol";

/// @title IdentityRegistry
/// @notice Binds holder addresses to identities and says who may hold the token (ERC-3643): an address is
/// verified only if its identity carries, for every topic the claim topics registry lists, a claim by an
/// issuer the trusted issuers registry trusts for that topic, which that issuer still holds valid. Its agents
/// register identities: the token's agent, and the token itself, for recovery.
contract IdentityRegistry is IIdentityRegistry, ParticipantRoles {
    IIdentityRegistryStorage private _storage;
    IClaimTopicsRegistry private _topics;
    ITrustedIssuersRegistry private _issuers;

    error LengthMismatch();

    constructor(
        ParticipantRegistry registry_,
        address owner_,
        address trustedIssuers,
        address claimTopics,
        address identityStorage_
    ) ParticipantRoles(registry_, owner_) {
        _issuers = ITrustedIssuersRegistry(trustedIssuers);
        _topics = IClaimTopicsRegistry(claimTopics);
        _storage = IIdentityRegistryStorage(identityStorage_);
        emit TrustedIssuersRegistrySet(trustedIssuers);
        emit ClaimTopicsRegistrySet(claimTopics);
        emit IdentityStorageSet(identityStorage_);
    }

    function identityStorage() external view returns (IIdentityRegistryStorage) {
        return _storage;
    }

    function issuersRegistry() external view returns (ITrustedIssuersRegistry) {
        return _issuers;
    }

    function topicsRegistry() external view returns (IClaimTopicsRegistry) {
        return _topics;
    }

    function setIdentityRegistryStorage(address identityRegistryStorage) external onlyOwner {
        _storage = IIdentityRegistryStorage(identityRegistryStorage);
        emit IdentityStorageSet(identityRegistryStorage);
    }

    function setClaimTopicsRegistry(address claimTopicsRegistry) external onlyOwner {
        _topics = IClaimTopicsRegistry(claimTopicsRegistry);
        emit ClaimTopicsRegistrySet(claimTopicsRegistry);
    }

    function setTrustedIssuersRegistry(address trustedIssuersRegistry) external onlyOwner {
        _issuers = ITrustedIssuersRegistry(trustedIssuersRegistry);
        emit TrustedIssuersRegistrySet(trustedIssuersRegistry);
    }

    function registerIdentity(address userAddress, IIdentity identity_, uint16 country) public onlyAgent {
        _storage.addIdentityToStorage(userAddress, identity_, country);
        // The only call before it is to the identity storage the owner set, which calls nothing back.
        // forge-lint: disable-next-line(reentrancy-events)
        emit IdentityRegistered(userAddress, identity_);
    }

    function deleteIdentity(address userAddress) external onlyAgent {
        IIdentity old = _storage.storedIdentity(userAddress);
        _storage.removeIdentityFromStorage(userAddress);
        // The only call before it is to the identity storage the owner set, which calls nothing back.
        // forge-lint: disable-next-line(reentrancy-events)
        emit IdentityRemoved(userAddress, old);
    }

    function updateCountry(address userAddress, uint16 country) external onlyAgent {
        _storage.modifyStoredInvestorCountry(userAddress, country);
        // The only call before it is to the identity storage the owner set, which calls nothing back.
        // forge-lint: disable-next-line(reentrancy-events)
        emit CountryUpdated(userAddress, country);
    }

    function updateIdentity(address userAddress, IIdentity identity_) external onlyAgent {
        IIdentity old = _storage.storedIdentity(userAddress);
        _storage.modifyStoredIdentity(userAddress, identity_);
        // The only call before it is to the identity storage the owner set, which calls nothing back.
        // forge-lint: disable-next-line(reentrancy-events)
        emit IdentityUpdated(old, identity_);
    }

    function batchRegisterIdentity(
        address[] calldata userAddresses,
        IIdentity[] calldata identities,
        uint16[] calldata countries
    ) external {
        if (userAddresses.length != identities.length || userAddresses.length != countries.length) revert LengthMismatch();
        for (uint256 i; i < userAddresses.length; ++i) {
            registerIdentity(userAddresses[i], identities[i], countries[i]);
        }
    }

    function contains(address userAddress) external view returns (bool) {
        return address(_storage.storedIdentity(userAddress)) != address(0);
    }

    /// @notice Whether `userAddress` may hold the token: bound to an identity that carries, for every required
    /// topic, a valid claim by an issuer trusted for it.
    function isVerified(address userAddress) external view returns (bool) {
        IIdentity identity_ = _storage.storedIdentity(userAddress);
        if (address(identity_) == address(0)) return false;
        uint256[] memory topics = _topics.getClaimTopics();
        for (uint256 t; t < topics.length; ++t) {
            if (!_hasValidClaim(identity_, topics[t])) return false;
        }
        return true;
    }

    function identity(address userAddress) external view returns (IIdentity) {
        return _storage.storedIdentity(userAddress);
    }

    function investorCountry(address userAddress) external view returns (uint16) {
        return _storage.storedInvestorCountry(userAddress);
    }

    function _hasValidClaim(IIdentity identity_, uint256 topic) private view returns (bool) {
        IClaimIssuer[] memory issuers = _issuers.getTrustedIssuersForClaimTopic(topic);
        for (uint256 i; i < issuers.length; ++i) {
            bytes32 claimId = keccak256(abi.encode(address(issuers[i]), topic));
            // The scheme and uri say nothing about whether the claim holds.
            // forge-lint: disable-start(unused-return)
            (uint256 claimTopic,, address issuer, bytes memory signature, bytes memory data,) =
                identity_.getClaim(claimId);
            // forge-lint: disable-end(unused-return)
            if (issuer != address(issuers[i]) || claimTopic != topic) continue;
            try issuers[i].isClaimValid(identity_, topic, signature, data) returns (bool valid) {
                if (valid) return true;
            } catch {
                // An issuer that cannot answer vouches for nothing.
            }
        }
        return false;
    }
}
