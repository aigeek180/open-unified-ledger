// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {SettlementToken} from "./SettlementToken.sol";

/// @title WholesaleToken
/// @notice Tokenized central bank reserves in one currency (`wCAD`, `wUSD`): the issuing central bank's
/// liability, held only by active banks to which that central bank has opened a reserve account.
/// @dev A ledger may carry several currencies, each with its own central bank and wholesale token (SPEC.md
/// §13), so the issuer is named here rather than read from the registry. Only the issuer approves a mint
/// (the settlement engine's authority rule), and only it opens and closes reserve accounts, so each central
/// bank alone decides who holds its currency.
contract WholesaleToken is SettlementToken {
    /// @notice May open and close banks' reserve accounts.
    bytes32 public constant ACCOUNTS_ROLE = keccak256("ACCOUNTS_ROLE");

    mapping(bytes32 bank => bool) private _reserveAccounts;

    event ReserveAccountOpened(bytes32 indexed bank);
    event ReserveAccountClosed(bytes32 indexed bank);

    error NotACentralBank(bytes32 issuer);
    error NotABank(bytes32 participant);

    /// @param issuer_ The issuing central bank's participant id.
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        ParticipantRegistry registry_,
        bytes32 issuer_
    ) SettlementToken(name_, symbol_, decimals_, registry_, issuer_) {
        if (registry_.participant(issuer_).kind != ParticipantRegistry.Kind.CentralBank) {
            revert NotACentralBank(issuer_);
        }
    }

    /// @notice Let `bank` hold this currency's reserves.
    function openReserveAccount(bytes32 bank) external onlyRole(ACCOUNTS_ROLE) {
        if (registry.participant(bank).kind != ParticipantRegistry.Kind.Bank) revert NotABank(bank);
        if (!_reserveAccounts[bank]) {
            _reserveAccounts[bank] = true;
            emit ReserveAccountOpened(bank);
        }
    }

    /// @notice Stop `bank` sending or receiving this currency's reserves; what it holds stays, unmovable,
    /// until the account reopens or the central bank forces a transfer.
    function closeReserveAccount(bytes32 bank) external onlyRole(ACCOUNTS_ROLE) {
        if (_reserveAccounts[bank]) {
            _reserveAccounts[bank] = false;
            emit ReserveAccountClosed(bank);
        }
    }

    function hasReserveAccount(bytes32 bank) external view returns (bool) {
        return _reserveAccounts[bank];
    }

    function canSend(address account) public view override returns (bool) {
        return _holdsReserveAccount(account) && canTransact(account);
    }

    function canReceive(address account) public view override returns (bool) {
        return _holdsReserveAccount(account) && canTransact(account);
    }

    /// @dev An address of an active bank whose reserve account here is open.
    function _holdsReserveAccount(address account) private view returns (bool) {
        bytes32 id = registry.participantOf(account);
        return _reserveAccounts[id] && registry.isActiveOfKind(account, ParticipantRegistry.Kind.Bank);
    }
}
