// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {IAgentRole} from "./interfaces/IERC3643.sol";

/// @title ParticipantRoles
/// @notice Ownership (ERC-173) and agents (ERC-3643's IAgentRole) held by participants rather than by keys
/// (SPEC.md §15): an owner or agent that is a participant acts through its active signing keys in the
/// participant registry, so a key rotation moves these roles with every other. A contract (a token acting on
/// its identity registry) is an agent as itself.
abstract contract ParticipantRoles is IAgentRole {
    /// @notice The registry whose signing keys act for participants.
    ParticipantRegistry public immutable participantRegistry;

    bytes32 private _owner;
    /// @dev The address `owner()` names: the key the owner first acted through, kept for ERC-173 readers.
    address private _ownerAccount;
    mapping(bytes32 participant => bool) private _agentParticipants;
    mapping(address account => bool) private _agentContracts;

    /// @notice ERC-173.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotTheOwner(address account);
    error NotAnAgent(address account);
    error NotAParticipantKey(address account);

    modifier onlyOwner() {
        if (!isOwner(msg.sender)) revert NotTheOwner(msg.sender);
        _;
    }

    modifier onlyAgent() {
        if (!isAgent(msg.sender)) revert NotAnAgent(msg.sender);
        _;
    }

    /// @param owner_ A signing key of the participant that owns this contract: one the registry admits, so never
    /// the zero address.
    // forge-lint: disable-next-line(missing-zero-check)
    constructor(ParticipantRegistry registry_, address owner_) {
        if (address(registry_) == address(0)) revert NotAParticipantKey(owner_);
        participantRegistry = registry_;
        bytes32 participant = registry_.signerOf(owner_);
        if (participant == bytes32(0)) revert NotAParticipantKey(owner_);
        _owner = participant;
        _ownerAccount = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    /// @notice ERC-173: an address of the owner. The owner is a participant; any of its active signing keys
    /// acts as it.
    function owner() external view returns (address) {
        return _ownerAccount;
    }

    /// @notice The participant that owns this contract.
    function ownerParticipant() external view returns (bytes32) {
        return _owner;
    }

    /// @notice ERC-173: hand ownership to the participant whose signing key `newOwner` is.
    // A key the registry admits, so never the zero address.
    // forge-lint: disable-next-line(missing-zero-check)
    function transferOwnership(address newOwner) external onlyOwner {
        bytes32 participant = participantRegistry.signerOf(newOwner);
        if (participant == bytes32(0)) revert NotAParticipantKey(newOwner);
        emit OwnershipTransferred(_ownerAccount, newOwner);
        _owner = participant;
        _ownerAccount = newOwner;
    }

    function isOwner(address account) public view returns (bool) {
        return participantRegistry.signerOf(account) == _owner;
    }

    /// @notice Appoint an agent: the participant whose signing key `agent` is, or a contract as itself.
    function addAgent(address agent) external onlyOwner {
        bytes32 participant = participantRegistry.signerOf(agent);
        // Announced by AgentAdded below.
        // forge-lint: disable-next-line(missing-events-access-control)
        if (participant != bytes32(0)) _agentParticipants[participant] = true;
        // forge-lint: disable-next-line(missing-events-access-control)
        else _agentContracts[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external onlyOwner {
        bytes32 participant = participantRegistry.signerOf(agent);
        // Announced by AgentRemoved below.
        // forge-lint: disable-next-line(missing-events-access-control)
        if (participant != bytes32(0)) _agentParticipants[participant] = false;
        // forge-lint: disable-next-line(missing-events-access-control)
        else _agentContracts[agent] = false;
        emit AgentRemoved(agent);
    }

    function isAgent(address account) public view returns (bool) {
        if (_agentContracts[account]) return true;
        bytes32 participant = participantRegistry.signerOf(account);
        return participant != bytes32(0) && _agentParticipants[participant];
    }

    /// @notice Whether a participant is an agent, whatever key it signs with.
    function isAgentParticipant(bytes32 participant) external view returns (bool) {
        return _agentParticipants[participant];
    }
}
