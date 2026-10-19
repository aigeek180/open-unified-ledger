// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {IERC734} from "./IERC734.sol";
import {IERC735} from "./IERC735.sol";

/// @title IIdentity
/// @notice An on-chain identity as ERC-3643 uses it: keys (ERC-734) and claims (ERC-735), and, for an
/// identity that issues claims, whether a claim it signed is valid.
interface IIdentity is IERC734, IERC735 {
    function isClaimValid(IIdentity identity, uint256 topic, bytes calldata signature, bytes calldata data)
        external
        view
        returns (bool);
}

/// @title IClaimIssuer
/// @notice An identity trusted to issue claims, which may revoke a claim it signed.
interface IClaimIssuer is IIdentity {
    event ClaimRevoked(bytes indexed signature);

    function revokeClaim(bytes32 claimId, address identity) external returns (bool);
    function revokeClaimBySignature(bytes calldata signature) external;
    function isClaimRevoked(bytes calldata signature) external view returns (bool);
}
