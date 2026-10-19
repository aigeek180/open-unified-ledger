// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC20uRWA} from "./vendor/oz-community/token/ERC20uRWA.sol";
import {ParticipantRegistry} from "./ParticipantRegistry.sol";

/// @title SettlementToken
/// @notice A permissioned cash token that moves only through settlement instructions (SPEC.md §4.2).
/// @dev Every supply change and every movement goes through the settlement engine, so each one carries an
/// instruction id (the ISO 20022 UETR) that the participants' core ledgers can match. Plain ERC-20 transfers
/// and approvals are disabled. ERC-7943 (uRWA) supplies holder eligibility, freezing and forced transfer;
/// subclasses decide who is eligible. A token's decimals equal its currency's ISO 4217 minor unit, so one
/// token unit is one minor unit.
abstract contract SettlementToken is ERC20uRWA, AccessControl, Pausable {
    /// @notice The settlement engine: the only caller that can mint, burn or move balances.
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");
    bytes32 public constant FREEZER_ROLE = keccak256("FREEZER_ROLE");
    bytes32 public constant ENFORCER_ROLE = keccak256("ENFORCER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    ParticipantRegistry public immutable registry;
    /// @notice The participant whose liability this token is.
    bytes32 public immutable issuer;
    uint8 private immutable _decimals;

    error DirectTransferDisabled();

    /// @dev The issuer's roles (admin, freezer, enforcer, pauser and a subclass's own) are held by its
    /// active signing keys in the registry, not granted to an address, so a key rotation moves them all.
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        ParticipantRegistry registry_,
        bytes32 issuer_
    ) ERC20(name_, symbol_) {
        registry = registry_;
        issuer = issuer_;
        _decimals = decimals_;
    }

    /// @notice A participant's address holds a role here only as one of the issuer's active signing keys, and
    /// never the settlement role, which only contracts are granted; any other address (the settlement engine,
    /// a conditional settlement) holds what it was granted.
    function hasRole(bytes32 role, address account) public view virtual override returns (bool) {
        if (registry.participantOf(account) != bytes32(0)) {
            return role != SETTLEMENT_ROLE && registry.signerOf(account) == issuer;
        }
        return super.hasRole(role, account);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ---------------------------------------------------------------- settlement (engine only)

    function settleMint(address to, uint256 amount) external virtual onlyRole(SETTLEMENT_ROLE) whenNotPaused {
        _mint(to, amount);
    }

    function settleBurn(address from, uint256 amount)
        external
        virtual
        onlyRole(SETTLEMENT_ROLE)
        whenNotPaused
    {
        _burn(from, amount);
    }

    function settleTransfer(address from, address to, uint256 amount)
        external
        virtual
        onlyRole(SETTLEMENT_ROLE)
        whenNotPaused
    {
        _transfer(from, to, amount);
    }

    // ---------------------------------------------------------------- plain ERC-20 movement is disabled

    /// @dev Virtual for the bond, whose transfers are refused by its ERC-3643 compliance instead (Bond.sol).
    function transfer(address, uint256) public virtual override returns (bool) {
        revert DirectTransferDisabled();
    }

    function transferFrom(address, address, uint256) public virtual override returns (bool) {
        revert DirectTransferDisabled();
    }

    function approve(address, uint256) public virtual override returns (bool) {
        revert DirectTransferDisabled();
    }

    // ---------------------------------------------------------------- issuer controls

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _checkEnforcer(address, address, uint256) internal view override onlyRole(ENFORCER_ROLE) {}

    function _checkFreezer(address, uint256) internal view override onlyRole(FREEZER_ROLE) {}

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC20uRWA, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
