// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {SettlementToken} from "./SettlementToken.sol";

/// @title DepositToken
/// @notice A tokenized deposit (`dCAD-A` and so on): still the issuing bank's deposit liability, held only by
/// addresses the bank has allowlisted after its own off-chain KYC.
/// @dev Holder addresses are customers, not registry participants, so the issuing bank authorizes movements
/// out of them in settlement instructions.
contract DepositToken is SettlementToken {
    /// @notice May allowlist, block and reset holders.
    bytes32 public constant ALLOWLIST_ROLE = keccak256("ALLOWLIST_ROLE");

    error NotABank(bytes32 issuer);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        ParticipantRegistry registry_,
        bytes32 issuer_
    ) SettlementToken(name_, symbol_, decimals_, registry_, issuer_) {
        if (registry_.participant(issuer_).kind != ParticipantRegistry.Kind.Bank) {
            revert NotABank(issuer_);
        }
    }

    function allowHolder(address account) external onlyRole(ALLOWLIST_ROLE) {
        _allowUser(account);
    }

    function blockHolder(address account) external onlyRole(ALLOWLIST_ROLE) {
        _blockUser(account);
    }

    function resetHolder(address account) external onlyRole(ALLOWLIST_ROLE) {
        _resetUser(account);
    }

    /// @dev Only explicitly allowlisted holders; the ERC-7943 default (anyone not blocked) is too open.
    function canSend(address account) public view virtual override returns (bool) {
        return getRestriction(account) == Restriction.ALLOWED;
    }

    function canReceive(address account) public view virtual override returns (bool) {
        return getRestriction(account) == Restriction.ALLOWED;
    }
}
