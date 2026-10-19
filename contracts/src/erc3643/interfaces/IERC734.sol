// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

/// @title IERC734
/// @notice Key manager (ERC-734, https://github.com/ethereum/EIPs/issues/734), as ERC-3643 identities use it:
/// keys with purposes (1 management, 2 execution or action, 3 claim signer by convention) and executions a
/// key with the right purpose approves. Written from the published text.
interface IERC734 {
    event KeyAdded(bytes32 indexed key, uint256 indexed purpose, uint256 indexed keyType);
    event KeyRemoved(bytes32 indexed key, uint256 indexed purpose, uint256 indexed keyType);
    event ExecutionRequested(
        uint256 indexed executionId, address indexed to, uint256 indexed value, bytes data
    );
    event Executed(uint256 indexed executionId, address indexed to, uint256 indexed value, bytes data);
    event Approved(uint256 indexed executionId, bool approved);
    event KeysRequiredChanged(uint256 purpose, uint256 number);

    function getKey(bytes32 key)
        external
        view
        returns (uint256[] memory purposes, uint256 keyType, bytes32 key_);
    function keyHasPurpose(bytes32 key, uint256 purpose) external view returns (bool exists);
    function getKeysByPurpose(uint256 purpose) external view returns (bytes32[] memory keys);
    function addKey(bytes32 key, uint256 purpose, uint256 keyType) external returns (bool success);
    function removeKey(bytes32 key, uint256 purpose) external returns (bool success);
    function changeKeysRequired(uint256 purpose, uint256 number) external;
    function getKeysRequired(uint256 purpose) external view returns (uint256);
    function execute(address to, uint256 value, bytes calldata data)
        external
        payable
        returns (uint256 executionId);
    function approve(uint256 id, bool approve) external returns (bool success);
}
