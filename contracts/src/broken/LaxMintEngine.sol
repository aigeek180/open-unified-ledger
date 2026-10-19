// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {LegAuthority, SettlementEngine} from "../SettlementEngine.sol";
import {SettlementToken} from "../SettlementToken.sol";

/// @title LaxMintEngine
/// @notice A deliberately broken settlement engine, for the conformance kit only (SPEC.md §14): it accepts a
/// mint without the approval of the token's issuer, so a payment can create a bank's deposit liability
/// without that bank's consent. Burns and transfers still need their holder's approval. The kit must fail it
/// on authority (invariant 9). Never deploy it for anything else.
contract LaxMintEngine is SettlementEngine {
    constructor(ParticipantRegistry registry_) SettlementEngine(registry_) {}

    /// @dev The break: a mint's authority is never looked for among the approvers.
    function _authorize(bytes32[] memory approvers, Leg calldata leg, uint256 i)
        internal
        view
        override
        returns (SettlementToken token)
    {
        bytes32 authority;
        (token, authority) = LegAuthority.required(registry, leg, i);
        if (leg.kind != LegKind.Mint && !LegAuthority.contains(approvers, authority)) {
            revert MissingApproval(i, authority);
        }
    }
}
