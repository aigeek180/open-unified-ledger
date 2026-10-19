// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {IIdentity} from "./interfaces/IIdentity.sol";
import {IIdentityRegistryStorage} from "./interfaces/IERC3643.sol";
import {ParticipantRoles} from "./ParticipantRoles.sol";

/// @title IdentityRegistryStorage
/// @notice Which identity, and which country, each holder address is bound to (ERC-3643): written only by the
/// identity registries bound to it, so several tokens can share one set of investors.
contract IdentityRegistryStorage is IIdentityRegistryStorage, ParticipantRoles {
    struct Stored {
        IIdentity identity;
        uint16 country;
    }

    uint256 public constant MAX_REGISTRIES = 300;

    mapping(address user => Stored) private _stored;
    address[] private _registries;

    error NotABoundRegistry(address account);
    error AlreadyStored(address user);
    error NotStored(address user);
    error InvalidIdentity();
    error RegistryAlreadyBound(address registry);
    error RegistryNotBound(address registry);

    constructor(ParticipantRegistry registry_, address owner_) ParticipantRoles(registry_, owner_) {}

    modifier onlyBoundRegistry() {
        if (!_isBound(msg.sender)) revert NotABoundRegistry(msg.sender);
        _;
    }

    function storedIdentity(address userAddress) external view returns (IIdentity) {
        return _stored[userAddress].identity;
    }

    function storedInvestorCountry(address userAddress) external view returns (uint16) {
        return _stored[userAddress].country;
    }

    function addIdentityToStorage(address userAddress, IIdentity identity, uint16 country)
        external
        onlyBoundRegistry
    {
        if (userAddress == address(0) || address(identity) == address(0)) revert InvalidIdentity();
        if (address(_stored[userAddress].identity) != address(0)) revert AlreadyStored(userAddress);
        _stored[userAddress] = Stored(identity, country);
        emit IdentityStored(userAddress, identity);
    }

    function removeIdentityFromStorage(address userAddress) external onlyBoundRegistry {
        IIdentity identity = _stored[userAddress].identity;
        if (address(identity) == address(0)) revert NotStored(userAddress);
        delete _stored[userAddress];
        emit IdentityUnstored(userAddress, identity);
    }

    function modifyStoredInvestorCountry(address userAddress, uint16 country) external onlyBoundRegistry {
        if (address(_stored[userAddress].identity) == address(0)) revert NotStored(userAddress);
        _stored[userAddress].country = country;
        emit CountryModified(userAddress, country);
    }

    function modifyStoredIdentity(address userAddress, IIdentity identity) external onlyBoundRegistry {
        IIdentity old = _stored[userAddress].identity;
        if (address(old) == address(0)) revert NotStored(userAddress);
        if (address(identity) == address(0)) revert InvalidIdentity();
        _stored[userAddress].identity = identity;
        emit IdentityModified(old, identity);
    }

    function bindIdentityRegistry(address identityRegistry) external onlyOwner {
        if (_isBound(identityRegistry)) revert RegistryAlreadyBound(identityRegistry);
        if (_registries.length >= MAX_REGISTRIES) revert RegistryAlreadyBound(identityRegistry);
        _registries.push(identityRegistry);
        emit IdentityRegistryBound(identityRegistry);
    }

    function unbindIdentityRegistry(address identityRegistry) external onlyOwner {
        for (uint256 i; i < _registries.length; ++i) {
            if (_registries[i] == identityRegistry) {
                // Announced by IdentityRegistryUnbound below.
                // forge-lint: disable-next-line(missing-events-access-control)
                _registries[i] = _registries[_registries.length - 1];
                _registries.pop();
                emit IdentityRegistryUnbound(identityRegistry);
                return;
            }
        }
        revert RegistryNotBound(identityRegistry);
    }

    function linkedIdentityRegistries() external view returns (address[] memory) {
        return _registries;
    }

    function _isBound(address account) private view returns (bool) {
        for (uint256 i; i < _registries.length; ++i) {
            if (_registries[i] == account) return true;
        }
        return false;
    }
}
