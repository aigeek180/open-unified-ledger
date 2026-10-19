// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {SettlementToken} from "./SettlementToken.sol";
import {IIdentity} from "./erc3643/interfaces/IIdentity.sol";
import {ICompliance, IERC3643, IIdentityRegistry} from "./erc3643/interfaces/IERC3643.sol";
import {ISettling} from "./erc3643/modules/SettlementOnlyModule.sol";

/// @title Bond
/// @notice A fixed-rate bond (SPEC.md §4.2, §15): one unit is one face amount, issued, traded, paid and redeemed
/// through the settlement engine against wholesale tokens. It is an ERC-3643 (T-REX) token as well as an
/// ERC-7943 one: a holder needs a verified identity in the bond's identity registry, and its modular
/// compliance decides every movement.
/// @dev The token's issuer (the engine's authority for minting) is the issuing and paying agent, a bank: the
/// real issuer runs no node and acts through its agent, named in `issuerName`. The agent is the ERC-3643 owner
/// and agent too, acting through its active signing keys in the participant registry, so a key rotation moves
/// these roles with every other. Terms are fixed at deployment; `termsHash` commits to the canonical terms.
/// Balances are checkpointed per block, so a holder can verify a coupon from its holding at the record block.
///
/// The engine-only rule (SPEC.md §4.2) is the compliance's: its settlement-only module agrees to a movement only
/// while the engine is settling it, so a holder's `transfer`, or an agent's `mint` or `burn` outside an
/// instruction, is refused as not compliant, and every movement carries an instruction id. ERC-3643's agent
/// `mint` and `burn` skip compliance; here they consult it, so the rule covers every supply change. Forced
/// transfers and recovery stay outside the engine, as the standard defines them: an agent's enforcement
/// actions, which the participants' books show as movements no instruction explains (rulebook §7.3).
contract Bond is SettlementToken, ISettling {
    using Checkpoints for Checkpoints.Trace208;
    using TransientSlot for *;

    enum DayCount {
        Act365F,
        ActActIcma,
        Thirty360
    }

    struct Terms {
        /// @notice Face amount of one unit, in minor units of the cash token's currency.
        uint256 faceValue;
        /// @notice Annual coupon rate, scaled by RATE_SCALE (3.25% is 0.0325e18).
        uint256 couponRate;
        /// @notice Coupons per year: 1, 2 or 4.
        uint8 frequency;
        DayCount dayCount;
        /// @notice Calendar dates as YYYYMMDD.
        uint32 issueDate;
        uint32 maturityDate;
        /// @notice Business days between record date and payment date.
        uint8 recordDays;
        /// @notice keccak256 of the canonical terms (see packages/chain bondTermsHash).
        bytes32 termsHash;
    }

    /// @notice What ERC-3643 needs to know at deployment besides the bond's own terms.
    struct Regulation {
        IIdentityRegistry identityRegistry;
        ICompliance compliance;
        /// @notice The bond's own identity.
        address onchainID;
    }

    uint256 public constant RATE_SCALE = 1e18;
    /// @notice ERC-3643 agents: the bond's agent's signing keys, and contracts it appoints.
    bytes32 public constant AGENT_ROLE = keccak256("AGENT_ROLE");

    // keccak256(abi.encode(uint256(keccak256("oul.bond.settling")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SETTLING_SLOT =
        0x8a9ac5b655256410f9f403fc11aa00de4bedee731ad7098b11f2877521ff5700;

    string public issuerName;
    Terms private _terms;
    mapping(address account => Checkpoints.Trace208) private _balanceHistory;
    Checkpoints.Trace208 private _supplyHistory;

    string private _tokenName;
    string private _tokenSymbol;
    address private _onchainID;
    IIdentityRegistry private _identityRegistry;
    ICompliance private _compliance;
    address private _ownerAccount;

    // ERC-3643's events not already declared by an ancestor (Paused and Unpaused come from Pausable).
    event UpdatedTokenInformation(
        string newName, string newSymbol, uint8 newDecimals, string newVersion, address newOnchainID
    );
    event IdentityRegistryAdded(address indexed identityRegistry);
    event ComplianceAdded(address indexed compliance);
    event RecoverySuccess(address lostWallet, address newWallet, address investorOnchainID);
    event AddressFrozen(address indexed userAddress, bool indexed isFrozen, address indexed owner);
    event TokensFrozen(address indexed userAddress, uint256 amount);
    event TokensUnfrozen(address indexed userAddress, uint256 amount);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error AgentNotABank(bytes32 agent);
    error InvalidTerms();
    error FutureLookup(uint256 blockNumber, uint256 currentBlock);
    error ReceiverNotVerified(address to);
    error TransferNotCompliant(address from, address to, uint256 amount);
    error NotAnAgent(address account);
    error NothingToRecover(address lostWallet);
    error NotTheHoldersIdentity(address lostWallet, address investorOnchainID);
    error RecoveryNotAuthorized(address newWallet);
    error InsufficientUnfrozen(address account, uint256 amount);
    error LengthMismatch();
    error NotTheOwnersKey(address account);

    constructor(
        string memory name_,
        string memory symbol_,
        ParticipantRegistry registry_,
        bytes32 agent,
        string memory issuerName_,
        Terms memory terms_,
        Regulation memory regulation
    ) SettlementToken(name_, symbol_, 0, registry_, agent) {
        if (registry_.participant(agent).kind != ParticipantRegistry.Kind.Bank) {
            revert AgentNotABank(agent);
        }
        if (
            terms_.faceValue == 0 || terms_.couponRate >= RATE_SCALE
                || (terms_.frequency != 1 && terms_.frequency != 2 && terms_.frequency != 4)
                || terms_.maturityDate <= terms_.issueDate
        ) revert InvalidTerms();
        issuerName = issuerName_;
        _terms = terms_;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        _onchainID = regulation.onchainID;
        _identityRegistry = regulation.identityRegistry;
        _compliance = regulation.compliance;
        _ownerAccount = msg.sender;
        emit IdentityRegistryAdded(address(regulation.identityRegistry));
        emit ComplianceAdded(address(regulation.compliance));
        emit UpdatedTokenInformation(name_, symbol_, 0, version(), regulation.onchainID);
    }

    function terms() external view returns (Terms memory) {
        return _terms;
    }

    // ---------------------------------------------------------------- holders (ERC-7943 and ERC-3643)

    /// @notice A holder's identity must verify in the bond's identity registry, and the address not be frozen.
    function canReceive(address account) public view override returns (bool) {
        return _identityRegistry.isVerified(account) && canTransact(account);
    }

    /// @notice A frozen address sends nothing.
    function canSend(address account) public view override returns (bool) {
        return canTransact(account);
    }

    /// @notice A holder's units at the end of a past block: the register at a record date.
    function balanceOfAt(address account, uint256 blockNumber) external view returns (uint256) {
        _requirePast(blockNumber);
        return _balanceHistory[account].upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    function totalSupplyAt(uint256 blockNumber) external view returns (uint256) {
        _requirePast(blockNumber);
        return _supplyHistory.upperLookupRecent(SafeCast.toUint48(blockNumber));
    }

    // ---------------------------------------------------------------- settlement (engine only)

    /// @notice Whether the settlement engine is settling a movement of this bond right now: what the
    /// compliance's settlement-only module asks.
    function settling() external view returns (bool) {
        return SETTLING_SLOT.asBoolean().tload();
    }

    function settleMint(address to, uint256 amount)
        external
        override
        onlyRole(SETTLEMENT_ROLE)
        whenNotPaused
    {
        _settle(address(0), to, amount);
    }

    function settleBurn(address from, uint256 amount)
        external
        override
        onlyRole(SETTLEMENT_ROLE)
        whenNotPaused
    {
        _settle(from, address(0), amount);
    }

    function settleTransfer(address from, address to, uint256 amount)
        external
        override
        onlyRole(SETTLEMENT_ROLE)
        whenNotPaused
    {
        _settle(from, to, amount);
    }

    // ---------------------------------------------------------------- ERC-20, through compliance

    /// @notice A holder's own transfer: refused unless compliant, which outside a settlement it never is.
    function transfer(address to, uint256 amount) public override whenNotPaused returns (bool) {
        _compliantMove(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount)
        public
        override
        whenNotPaused
        returns (bool)
    {
        _spendAllowance(from, msg.sender, amount);
        _compliantMove(from, to, amount);
        return true;
    }

    function approve(address spender, uint256 value) public override returns (bool) {
        return ERC20.approve(spender, value);
    }

    function name() public view override returns (string memory) {
        return _tokenName;
    }

    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    // ---------------------------------------------------------------- ERC-3643 reads

    function onchainID() external view returns (address) {
        return _onchainID;
    }

    function version() public pure returns (string memory) {
        return "1.0.0";
    }

    function identityRegistry() external view returns (IIdentityRegistry) {
        return _identityRegistry;
    }

    function compliance() external view returns (ICompliance) {
        return _compliance;
    }

    /// @notice Whether the whole address is frozen: ERC-7943's restriction, blocked.
    function isFrozen(address userAddress) public view returns (bool) {
        return getRestriction(userAddress) == Restriction.BLOCKED;
    }

    // ---------------------------------------------------------------- ERC-173 owner, ERC-3643 agents

    /// @notice The bond's owner is its agent; `owner()` names one of the agent's keys.
    function owner() external view returns (address) {
        return _ownerAccount;
    }

    /// @notice Name another signing key of the agent as `owner()`: the owner itself is the agent participant.
    // One of the agent's keys, so never the zero address.
    // forge-lint: disable-next-line(missing-zero-check)
    function transferOwnership(address newOwner) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (registry.signerOf(newOwner) != issuer) revert NotTheOwnersKey(newOwner);
        emit OwnershipTransferred(_ownerAccount, newOwner);
        _ownerAccount = newOwner;
    }

    function isAgent(address account) public view returns (bool) {
        return hasRole(AGENT_ROLE, account);
    }

    /// @notice Appoint a contract as an agent; the agent participant's own keys are agents already.
    function addAgent(address agent) external {
        grantRole(AGENT_ROLE, agent);
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external {
        revokeRole(AGENT_ROLE, agent);
        emit AgentRemoved(agent);
    }

    modifier onlyAgent() {
        if (!isAgent(msg.sender)) revert NotAnAgent(msg.sender);
        _;
    }

    // ---------------------------------------------------------------- ERC-3643 owner actions

    function setName(string calldata name_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _tokenName = name_;
        emit UpdatedTokenInformation(_tokenName, _tokenSymbol, 0, version(), _onchainID);
    }

    function setSymbol(string calldata symbol_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _tokenSymbol = symbol_;
        emit UpdatedTokenInformation(_tokenName, _tokenSymbol, 0, version(), _onchainID);
    }

    /// @notice The bond's own identity; the zero address for none.
    // forge-lint: disable-next-line(missing-zero-check)
    function setOnchainID(address onchainID_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _onchainID = onchainID_;
        emit UpdatedTokenInformation(_tokenName, _tokenSymbol, 0, version(), _onchainID);
    }

    function setIdentityRegistry(address identityRegistry_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _identityRegistry = IIdentityRegistry(identityRegistry_);
        emit IdentityRegistryAdded(identityRegistry_);
    }

    function setCompliance(address compliance_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _compliance = ICompliance(compliance_);
        emit ComplianceAdded(compliance_);
    }

    // ---------------------------------------------------------------- ERC-3643 agent actions

    function setAddressFrozen(address userAddress, bool freeze) public onlyAgent {
        if (freeze) _blockUser(userAddress);
        else _resetUser(userAddress);
        emit AddressFrozen(userAddress, freeze, msg.sender);
    }

    function freezePartialTokens(address userAddress, uint256 amount) public onlyAgent {
        uint256 total = frozen(userAddress) + amount;
        if (total > balanceOf(userAddress)) revert InsufficientUnfrozen(userAddress, amount);
        _setFrozen(userAddress, total);
        emit TokensFrozen(userAddress, amount);
    }

    function unfreezePartialTokens(address userAddress, uint256 amount) public onlyAgent {
        uint256 current = frozen(userAddress);
        if (amount > current) revert InsufficientUnfrozen(userAddress, amount);
        _setFrozen(userAddress, current - amount);
        emit TokensUnfrozen(userAddress, amount);
    }

    /// @notice An agent's mint, refused unless compliant: outside a settlement instruction it never is.
    function mint(address to, uint256 amount) public onlyAgent whenNotPaused {
        _compliantMove(address(0), to, amount);
    }

    /// @notice An agent's burn, refused unless compliant: outside a settlement instruction it never is.
    function burn(address userAddress, uint256 amount) public onlyAgent whenNotPaused {
        _compliantMove(userAddress, address(0), amount);
    }

    /// @notice ERC-3643's and ERC-7943's forced transfer, by the agent: the receiver must verify; the
    /// compliance hears of it.
    function forcedTransfer(address from, address to, uint256 amount) public override returns (bool) {
        super.forcedTransfer(from, to, amount);
        // The compliance is the bond's own, set by its owner; its modules only read.
        // forge-lint: disable-next-line(reentrancy-no-eth)
        _compliance.transferred(from, to, amount);
        return true;
    }

    /// @notice Recover a lost wallet (ERC-3643): the holder's identity, which must hold `newWallet` as a
    /// management key, is bound to it in the identity registry, the units move there with what was frozen of
    /// them and the address's own freeze, and the lost wallet is unbound.
    function recoveryAddress(address lostWallet, address newWallet, address investorOnchainID)
        external
        onlyAgent
        returns (bool)
    {
        uint256 amount = balanceOf(lostWallet);
        if (amount == 0) revert NothingToRecover(lostWallet);
        if (address(_identityRegistry.identity(lostWallet)) != investorOnchainID) {
            revert NotTheHoldersIdentity(lostWallet, investorOnchainID);
        }
        if (!IIdentity(investorOnchainID).keyHasPurpose(keccak256(abi.encode(newWallet)), 1)) {
            revert RecoveryNotAuthorized(newWallet);
        }
        // The calls below go to the bond's own identity registry, which the owner set and which calls back only
        // what this bond allows its agents; the holder's identity is only read.
        uint256 frozenAmount = frozen(lostWallet);
        bool addressFrozen = isFrozen(lostWallet);
        if (!_identityRegistry.contains(newWallet)) {
            uint16 country = _identityRegistry.investorCountry(lostWallet);
            // forge-lint: disable-next-line(reentrancy-no-eth)
            _identityRegistry.registerIdentity(newWallet, IIdentity(investorOnchainID), country);
        }
        // forge-lint: disable-next-line(reentrancy-no-eth)
        forcedTransfer(lostWallet, newWallet, amount);
        if (frozenAmount > 0) {
            // forge-lint: disable-next-line(reentrancy-no-eth)
            _setFrozen(newWallet, frozenAmount);
            // forge-lint: disable-next-line(reentrancy-events)
            emit TokensFrozen(newWallet, frozenAmount);
        }
        if (addressFrozen) {
            _blockUser(newWallet);
            // forge-lint: disable-next-line(reentrancy-events)
            emit AddressFrozen(newWallet, true, msg.sender);
        }
        _identityRegistry.deleteIdentity(lostWallet);
        // forge-lint: disable-next-line(reentrancy-events)
        emit RecoverySuccess(lostWallet, newWallet, investorOnchainID);
        return true;
    }

    // ---------------------------------------------------------------- ERC-3643 batches

    function batchTransfer(address[] calldata toList, uint256[] calldata amounts) external {
        if (toList.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < toList.length; ++i) {
            transfer(toList[i], amounts[i]);
        }
    }

    function batchForcedTransfer(
        address[] calldata fromList,
        address[] calldata toList,
        uint256[] calldata amounts
    ) external {
        if (fromList.length != toList.length || toList.length != amounts.length) {
            revert LengthMismatch();
        }
        for (uint256 i; i < fromList.length; ++i) {
            forcedTransfer(fromList[i], toList[i], amounts[i]);
        }
    }

    function batchMint(address[] calldata toList, uint256[] calldata amounts) external {
        if (toList.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < toList.length; ++i) {
            mint(toList[i], amounts[i]);
        }
    }

    function batchBurn(address[] calldata userAddresses, uint256[] calldata amounts) external {
        if (userAddresses.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < userAddresses.length; ++i) {
            burn(userAddresses[i], amounts[i]);
        }
    }

    function batchSetAddressFrozen(address[] calldata userAddresses, bool[] calldata freeze) external {
        if (userAddresses.length != freeze.length) revert LengthMismatch();
        for (uint256 i; i < userAddresses.length; ++i) {
            setAddressFrozen(userAddresses[i], freeze[i]);
        }
    }

    function batchFreezePartialTokens(address[] calldata userAddresses, uint256[] calldata amounts) external {
        if (userAddresses.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < userAddresses.length; ++i) {
            freezePartialTokens(userAddresses[i], amounts[i]);
        }
    }

    function batchUnfreezePartialTokens(address[] calldata userAddresses, uint256[] calldata amounts)
        external
    {
        if (userAddresses.length != amounts.length) revert LengthMismatch();
        for (uint256 i; i < userAddresses.length; ++i) {
            unfreezePartialTokens(userAddresses[i], amounts[i]);
        }
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC3643).interfaceId || super.supportsInterface(interfaceId);
    }

    // ---------------------------------------------------------------- internals

    /// @dev A movement inside the engine's settlement: the compliance sees it as one.
    function _settle(address from, address to, uint256 amount) private {
        SETTLING_SLOT.asBoolean().tstore(true);
        _compliantMove(from, to, amount);
        SETTLING_SLOT.asBoolean().tstore(false);
    }

    /// @dev ERC-3643's transfer rules: the receiver verified, the compliance agreeing; then the ERC-7943 checks
    /// (frozen addresses and tokens) in `_update`; then the compliance hears of it.
    function _compliantMove(address from, address to, uint256 amount) private {
        if (to != address(0) && !_identityRegistry.isVerified(to)) revert ReceiverNotVerified(to);
        if (!_compliance.canTransfer(from, to, amount)) revert TransferNotCompliant(from, to, amount);
        if (from == address(0)) {
            _mint(to, amount);
            _compliance.created(to, amount);
        } else if (to == address(0)) {
            _burn(from, amount);
            _compliance.destroyed(from, amount);
        } else {
            _transfer(from, to, amount);
            _compliance.transferred(from, to, amount);
        }
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        uint48 key = SafeCast.toUint48(block.number);
        if (from != address(0)) _balanceHistory[from].push(key, SafeCast.toUint208(balanceOf(from)));
        if (to != address(0)) _balanceHistory[to].push(key, SafeCast.toUint208(balanceOf(to)));
        if (from == address(0) || to == address(0)) {
            _supplyHistory.push(key, SafeCast.toUint208(totalSupply()));
        }
    }

    function _requirePast(uint256 blockNumber) private view {
        if (blockNumber >= block.number) revert FutureLookup(blockNumber, block.number);
    }
}
