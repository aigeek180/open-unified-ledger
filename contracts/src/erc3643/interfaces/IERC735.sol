// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

/// @title IERC735
/// @notice Claim holder (ERC-735, https://github.com/ethereum/EIPs/issues/735): claims about an identity, each
/// by an issuer on a topic, once per issuer and topic. Written from the published text.
interface IERC735 {
    event ClaimRequested(
        uint256 indexed claimRequestId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );
    event ClaimAdded(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );
    event ClaimRemoved(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );
    event ClaimChanged(
        bytes32 indexed claimId,
        uint256 indexed topic,
        uint256 scheme,
        address indexed issuer,
        bytes signature,
        bytes data,
        string uri
    );

    function getClaim(bytes32 claimId)
        external
        view
        returns (
            uint256 topic,
            uint256 scheme,
            address issuer,
            bytes memory signature,
            bytes memory data,
            string memory uri
        );
    function getClaimIdsByTopic(uint256 topic) external view returns (bytes32[] memory claimIds);
    function addClaim(
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes calldata signature,
        bytes calldata data,
        string calldata uri
    ) external returns (uint256 claimRequestId);
    function changeClaim(
        bytes32 claimId,
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes calldata signature,
        bytes calldata data,
        string calldata uri
    ) external returns (bool success);
    function removeClaim(bytes32 claimId) external returns (bool success);
}
