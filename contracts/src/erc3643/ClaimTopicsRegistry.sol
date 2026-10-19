// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {IClaimTopicsRegistry} from "./interfaces/IERC3643.sol";
import {ParticipantRoles} from "./ParticipantRoles.sol";

/// @title ClaimTopicsRegistry
/// @notice The claim topics a holder's identity must carry, each from a trusted issuer, to hold the token
/// (ERC-3643). Kept by the token's owner.
contract ClaimTopicsRegistry is IClaimTopicsRegistry, ParticipantRoles {
    /// @notice A claim topic per holder at most this many; the identity registry checks each on every receipt.
    uint256 public constant MAX_TOPICS = 15;

    uint256[] private _topics;

    error TopicExists(uint256 topic);
    error NoSuchTopic(uint256 topic);
    error TooManyTopics();

    constructor(ParticipantRegistry registry_, address owner_) ParticipantRoles(registry_, owner_) {}

    function addClaimTopic(uint256 claimTopic) external onlyOwner {
        if (_topics.length >= MAX_TOPICS) revert TooManyTopics();
        for (uint256 i; i < _topics.length; ++i) {
            if (_topics[i] == claimTopic) revert TopicExists(claimTopic);
        }
        _topics.push(claimTopic);
        emit ClaimTopicAdded(claimTopic);
    }

    function removeClaimTopic(uint256 claimTopic) external onlyOwner {
        for (uint256 i; i < _topics.length; ++i) {
            if (_topics[i] == claimTopic) {
                _topics[i] = _topics[_topics.length - 1];
                _topics.pop();
                emit ClaimTopicRemoved(claimTopic);
                return;
            }
        }
        revert NoSuchTopic(claimTopic);
    }

    function getClaimTopics() external view returns (uint256[] memory) {
        return _topics;
    }
}
