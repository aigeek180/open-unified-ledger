// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

// Confidential mode (SPEC.md §10) deploys Paladin's NotoFactory behind an ERC-1967 proxy, as Paladin's own
// operator does. Paladin's release does not ship the proxy's artifact, so it is built here from the same
// OpenZeppelin Contracts this repository already pins.
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Exists only so Foundry builds ERC1967Proxy's artifact (contracts/out/ERC1967Proxy.sol).
abstract contract PaladinProxy is ERC1967Proxy {}
