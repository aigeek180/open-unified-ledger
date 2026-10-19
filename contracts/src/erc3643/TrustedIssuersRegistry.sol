// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {IClaimIssuer} from "./interfaces/IIdentity.sol";
import {ITrustedIssuersRegistry} from "./interfaces/IERC3643.sol";
import {ParticipantRoles} from "./ParticipantRoles.sol";

/// @title TrustedIssuersRegistry
/// @notice Which claim issuers count, and for which topics (ERC-3643): here, the central bank for the banks it
/// admitted and each bank for its own customers. Kept by the token's owner.
contract TrustedIssuersRegistry is ITrustedIssuersRegistry, ParticipantRoles {
    uint256 public constant MAX_ISSUERS = 50;
    uint256 public constant MAX_TOPICS_PER_ISSUER = 15;

    IClaimIssuer[] private _issuers;
    mapping(address issuer => uint256[]) private _topicsOf;

    error IssuerExists(address issuer);
    error NoSuchIssuer(address issuer);
    error InvalidTopics();
    error TooManyIssuers();

    constructor(ParticipantRegistry registry_, address owner_) ParticipantRoles(registry_, owner_) {}

    function addTrustedIssuer(IClaimIssuer trustedIssuer, uint256[] calldata claimTopics) external onlyOwner {
        if (
            address(trustedIssuer) == address(0) || claimTopics.length == 0
                || claimTopics.length > MAX_TOPICS_PER_ISSUER
        ) {
            revert InvalidTopics();
        }
        if (_topicsOf[address(trustedIssuer)].length != 0) revert IssuerExists(address(trustedIssuer));
        if (_issuers.length >= MAX_ISSUERS) revert TooManyIssuers();
        _issuers.push(trustedIssuer);
        _topicsOf[address(trustedIssuer)] = claimTopics;
        emit TrustedIssuerAdded(trustedIssuer, claimTopics);
    }

    function removeTrustedIssuer(IClaimIssuer trustedIssuer) external onlyOwner {
        if (_topicsOf[address(trustedIssuer)].length == 0) revert NoSuchIssuer(address(trustedIssuer));
        for (uint256 i; i < _issuers.length; ++i) {
            if (address(_issuers[i]) == address(trustedIssuer)) {
                _issuers[i] = _issuers[_issuers.length - 1];
                _issuers.pop();
                break;
            }
        }
        delete _topicsOf[address(trustedIssuer)];
        emit TrustedIssuerRemoved(trustedIssuer);
    }

    function updateIssuerClaimTopics(IClaimIssuer trustedIssuer, uint256[] calldata claimTopics)
        external
        onlyOwner
    {
        if (_topicsOf[address(trustedIssuer)].length == 0) {
            revert NoSuchIssuer(address(trustedIssuer));
        }
        if (claimTopics.length == 0 || claimTopics.length > MAX_TOPICS_PER_ISSUER) revert InvalidTopics();
        _topicsOf[address(trustedIssuer)] = claimTopics;
        emit ClaimTopicsUpdated(trustedIssuer, claimTopics);
    }

    function getTrustedIssuers() external view returns (IClaimIssuer[] memory) {
        return _issuers;
    }

    function isTrustedIssuer(address issuer) external view returns (bool) {
        return _topicsOf[issuer].length != 0;
    }

    function getTrustedIssuerClaimTopics(IClaimIssuer trustedIssuer)
        external
        view
        returns (uint256[] memory)
    {
        if (_topicsOf[address(trustedIssuer)].length == 0) {
            revert NoSuchIssuer(address(trustedIssuer));
        }
        return _topicsOf[address(trustedIssuer)];
    }

    function getTrustedIssuersForClaimTopic(uint256 claimTopic)
        external
        view
        returns (IClaimIssuer[] memory)
    {
        uint256 count = 0;
        for (uint256 i; i < _issuers.length; ++i) {
            if (hasClaimTopic(address(_issuers[i]), claimTopic)) count++;
        }
        IClaimIssuer[] memory out = new IClaimIssuer[](count);
        uint256 n = 0;
        for (uint256 i; i < _issuers.length; ++i) {
            if (hasClaimTopic(address(_issuers[i]), claimTopic)) out[n++] = _issuers[i];
        }
        return out;
    }

    function hasClaimTopic(address issuer, uint256 claimTopic) public view returns (bool) {
        uint256[] storage topics = _topicsOf[issuer];
        for (uint256 i; i < topics.length; ++i) {
            if (topics[i] == claimTopic) return true;
        }
        return false;
    }
}
