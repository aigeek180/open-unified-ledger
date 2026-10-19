// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IClaimIssuer, IIdentity} from "./IIdentity.sol";

/// Interfaces of ERC-3643, T-REX: Token for Regulated EXchanges (https://eips.ethereum.org/EIPS/eip-3643,
/// status Final; the text is CC0). Written from the published standard; no reference implementation is used.

interface IAgentRole {
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);

    function addAgent(address agent) external;
    function removeAgent(address agent) external;
    function isAgent(address agent) external view returns (bool);
}

interface IClaimTopicsRegistry {
    event ClaimTopicAdded(uint256 indexed claimTopic);
    event ClaimTopicRemoved(uint256 indexed claimTopic);

    function addClaimTopic(uint256 claimTopic) external;
    function removeClaimTopic(uint256 claimTopic) external;
    function getClaimTopics() external view returns (uint256[] memory);
}

interface ITrustedIssuersRegistry {
    event TrustedIssuerAdded(IClaimIssuer indexed trustedIssuer, uint256[] claimTopics);
    event TrustedIssuerRemoved(IClaimIssuer indexed trustedIssuer);
    event ClaimTopicsUpdated(IClaimIssuer indexed trustedIssuer, uint256[] claimTopics);

    function addTrustedIssuer(IClaimIssuer trustedIssuer, uint256[] calldata claimTopics) external;
    function removeTrustedIssuer(IClaimIssuer trustedIssuer) external;
    function updateIssuerClaimTopics(IClaimIssuer trustedIssuer, uint256[] calldata claimTopics) external;
    function getTrustedIssuers() external view returns (IClaimIssuer[] memory);
    function isTrustedIssuer(address issuer) external view returns (bool);
    function getTrustedIssuerClaimTopics(IClaimIssuer trustedIssuer) external view returns (uint256[] memory);
    function getTrustedIssuersForClaimTopic(uint256 claimTopic) external view returns (IClaimIssuer[] memory);
    function hasClaimTopic(address issuer, uint256 claimTopic) external view returns (bool);
}

interface IIdentityRegistryStorage {
    event IdentityStored(address indexed investorAddress, IIdentity indexed identity);
    event IdentityUnstored(address indexed investorAddress, IIdentity indexed identity);
    event IdentityModified(IIdentity indexed oldIdentity, IIdentity indexed newIdentity);
    event CountryModified(address indexed investorAddress, uint16 indexed country);
    event IdentityRegistryBound(address indexed identityRegistry);
    event IdentityRegistryUnbound(address indexed identityRegistry);

    function storedIdentity(address userAddress) external view returns (IIdentity);
    function storedInvestorCountry(address userAddress) external view returns (uint16);
    function addIdentityToStorage(address userAddress, IIdentity identity, uint16 country) external;
    function removeIdentityFromStorage(address userAddress) external;
    function modifyStoredInvestorCountry(address userAddress, uint16 country) external;
    function modifyStoredIdentity(address userAddress, IIdentity identity) external;
    function bindIdentityRegistry(address identityRegistry) external;
    function unbindIdentityRegistry(address identityRegistry) external;
    function linkedIdentityRegistries() external view returns (address[] memory);
}

interface IIdentityRegistry {
    event ClaimTopicsRegistrySet(address indexed claimTopicsRegistry);
    event IdentityStorageSet(address indexed identityStorage);
    event TrustedIssuersRegistrySet(address indexed trustedIssuersRegistry);
    event IdentityRegistered(address indexed investorAddress, IIdentity indexed identity);
    event IdentityRemoved(address indexed investorAddress, IIdentity indexed identity);
    event IdentityUpdated(IIdentity indexed oldIdentity, IIdentity indexed newIdentity);
    event CountryUpdated(address indexed investorAddress, uint16 indexed country);

    function identityStorage() external view returns (IIdentityRegistryStorage);
    function issuersRegistry() external view returns (ITrustedIssuersRegistry);
    function topicsRegistry() external view returns (IClaimTopicsRegistry);
    function setIdentityRegistryStorage(address identityRegistryStorage) external;
    function setClaimTopicsRegistry(address claimTopicsRegistry) external;
    function setTrustedIssuersRegistry(address trustedIssuersRegistry) external;
    function registerIdentity(address userAddress, IIdentity identity, uint16 country) external;
    function deleteIdentity(address userAddress) external;
    function updateCountry(address userAddress, uint16 country) external;
    function updateIdentity(address userAddress, IIdentity identity) external;
    function batchRegisterIdentity(
        address[] calldata userAddresses,
        IIdentity[] calldata identities,
        uint16[] calldata countries
    ) external;
    function contains(address userAddress) external view returns (bool);
    function isVerified(address userAddress) external view returns (bool);
    function identity(address userAddress) external view returns (IIdentity);
    function investorCountry(address userAddress) external view returns (uint16);
}

interface ICompliance {
    event TokenBound(address token);
    event TokenUnbound(address token);

    function bindToken(address token) external;
    function unbindToken(address token) external;
    function isTokenBound(address token) external view returns (bool);
    function getTokenBound() external view returns (address);
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
    function transferred(address from, address to, uint256 amount) external;
    function created(address to, uint256 amount) external;
    function destroyed(address from, uint256 amount) external;
}

interface IERC3643 is IERC20 {
    event UpdatedTokenInformation(
        string newName, string newSymbol, uint8 newDecimals, string newVersion, address newOnchainID
    );
    event IdentityRegistryAdded(address indexed identityRegistry);
    event ComplianceAdded(address indexed compliance);
    event RecoverySuccess(address lostWallet, address newWallet, address investorOnchainID);
    event AddressFrozen(address indexed userAddress, bool indexed isFrozen, address indexed owner);
    event TokensFrozen(address indexed userAddress, uint256 amount);
    event TokensUnfrozen(address indexed userAddress, uint256 amount);
    event Paused(address userAddress);
    event Unpaused(address userAddress);

    function onchainID() external view returns (address);
    function version() external view returns (string memory);
    function identityRegistry() external view returns (IIdentityRegistry);
    function compliance() external view returns (ICompliance);
    function paused() external view returns (bool);
    function isFrozen(address userAddress) external view returns (bool);
    function getFrozenTokens(address userAddress) external view returns (uint256);

    function setName(string calldata name) external;
    function setSymbol(string calldata symbol) external;
    function setOnchainID(address onchainID) external;
    function pause() external;
    function unpause() external;
    function setAddressFrozen(address userAddress, bool freeze) external;
    function freezePartialTokens(address userAddress, uint256 amount) external;
    function unfreezePartialTokens(address userAddress, uint256 amount) external;
    function setIdentityRegistry(address identityRegistry) external;
    function setCompliance(address compliance) external;

    function forcedTransfer(address from, address to, uint256 amount) external returns (bool);
    function mint(address to, uint256 amount) external;
    function burn(address userAddress, uint256 amount) external;
    function recoveryAddress(address lostWallet, address newWallet, address investorOnchainID)
        external
        returns (bool);

    function batchTransfer(address[] calldata toList, uint256[] calldata amounts) external;
    function batchForcedTransfer(
        address[] calldata fromList,
        address[] calldata toList,
        uint256[] calldata amounts
    ) external;
    function batchMint(address[] calldata toList, uint256[] calldata amounts) external;
    function batchBurn(address[] calldata userAddresses, uint256[] calldata amounts) external;
    function batchSetAddressFrozen(address[] calldata userAddresses, bool[] calldata freeze) external;
    function batchFreezePartialTokens(address[] calldata userAddresses, uint256[] calldata amounts) external;
    function batchUnfreezePartialTokens(address[] calldata userAddresses, uint256[] calldata amounts) external;
}

/// @title IModule
/// @notice A rule a modular compliance contract consults (ERC-3643 describes modules in prose only; this
/// interface is this project's).
interface IModule {
    event ComplianceBound(address indexed compliance);
    event ComplianceUnbound(address indexed compliance);

    function bindCompliance(address compliance) external;
    function unbindCompliance(address compliance) external;
    function moduleCheck(address from, address to, uint256 value, address compliance)
        external
        view
        returns (bool);
    function moduleTransferAction(address from, address to, uint256 value) external;
    function moduleMintAction(address to, uint256 value) external;
    function moduleBurnAction(address from, uint256 value) external;
    function isComplianceBound(address compliance) external view returns (bool);
    function canComplianceBind(address compliance) external view returns (bool);
    function isPlugAndPlay() external pure returns (bool);
    function name() external pure returns (string memory);
}
