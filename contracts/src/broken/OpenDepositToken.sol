// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {DepositToken} from "../DepositToken.sol";
import {ParticipantRegistry} from "../ParticipantRegistry.sol";

/// @title OpenDepositToken
/// @notice A deliberately broken deposit token, for the conformance kit only (SPEC.md §14): it lets anyone
/// not explicitly blocked hold it, the ERC-7943 default the real deposit token refuses, so a payment lands on
/// a customer its bank has taken off the allowlist. The bank's allowlist itself is unchanged. The kit must
/// fail it on eligibility (invariant 7). Never deploy it for anything else.
contract OpenDepositToken is DepositToken {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        ParticipantRegistry registry_,
        bytes32 issuer_
    ) DepositToken(name_, symbol_, decimals_, registry_, issuer_) {}

    /// @dev The break: not blocked is enough.
    function canSend(address account) public view override returns (bool) {
        return canTransact(account);
    }

    function canReceive(address account) public view override returns (bool) {
        return canTransact(account);
    }
}
