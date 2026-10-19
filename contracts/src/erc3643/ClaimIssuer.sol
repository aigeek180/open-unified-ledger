// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {Identity} from "./Identity.sol";
import {IClaimIssuer, IIdentity} from "./interfaces/IIdentity.sol";

/// @title ClaimIssuer
/// @notice The identity of a participant trusted to issue claims (SPEC.md §15): the central bank attesting the
/// banks it admitted, each bank attesting its own customers' KYC. It may revoke a claim it signed; a revoked
/// claim is no longer valid wherever it is held, so the holder stops verifying without anything else changing.
contract ClaimIssuer is Identity, IClaimIssuer {
    mapping(bytes32 signatureHash => bool) private _revoked;

    error NotAClaimOfThisIssuer(bytes32 claimId);

    constructor(ParticipantRegistry registry_, address managerKey) Identity(registry_, managerKey) {}

    /// @notice Revoke the claim `claimId` this issuer made about `identity`.
    function revokeClaim(bytes32 claimId, address identity) external returns (bool) {
        _requireManagement();
        // Only the issuer and the signature decide what is revoked.
        // forge-lint: disable-next-line(unused-return)
        (,, address issuer, bytes memory signature,,) = IIdentity(identity).getClaim(claimId);
        if (issuer != address(this)) revert NotAClaimOfThisIssuer(claimId);
        _revoke(signature);
        return true;
    }

    function revokeClaimBySignature(bytes calldata signature) external {
        _requireManagement();
        _revoke(signature);
    }

    function isClaimRevoked(bytes calldata signature) public view returns (bool) {
        return _revoked[keccak256(signature)];
    }

    /// @notice Valid only if a claim key of this issuer signed it and it has not been revoked.
    function isClaimValid(IIdentity identity, uint256 topic, bytes calldata signature, bytes calldata data)
        public
        view
        override(Identity, IIdentity)
        returns (bool)
    {
        return !isClaimRevoked(signature) && super.isClaimValid(identity, topic, signature, data);
    }

    function _revoke(bytes memory signature) private {
        _revoked[keccak256(signature)] = true;
        emit ClaimRevoked(signature);
    }
}
