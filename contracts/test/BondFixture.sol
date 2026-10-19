// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Bond} from "../src/Bond.sol";
import {ClaimIssuer} from "../src/erc3643/ClaimIssuer.sol";
import {ClaimTopicsRegistry} from "../src/erc3643/ClaimTopicsRegistry.sol";
import {Identity} from "../src/erc3643/Identity.sol";
import {IdentityRegistry} from "../src/erc3643/IdentityRegistry.sol";
import {IdentityRegistryStorage} from "../src/erc3643/IdentityRegistryStorage.sol";
import {ModularCompliance} from "../src/erc3643/ModularCompliance.sol";
import {SettlementOnlyModule} from "../src/erc3643/modules/SettlementOnlyModule.sol";
import {TrustedIssuersRegistry} from "../src/erc3643/TrustedIssuersRegistry.sol";
import {IClaimIssuer, IIdentity} from "../src/erc3643/interfaces/IIdentity.sol";
import {ICompliance, IIdentityRegistry} from "../src/erc3643/interfaces/IERC3643.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {Fixture} from "./Fixture.sol";

/// @notice The ca-bond-dvp network in miniature, with the bond under ERC-3643 (SPEC.md §4.2, §15): Bank C as
/// issuing and paying agent owning the bond's identity registry, claim topics (KYC), trusted issuers (the
/// central bank for banks, each bank for its own customers) and compliance with the settlement-only module;
/// Banks A and B each with an identity carrying the central bank's KYC claim, registered for the bond.
abstract contract BondFixture is Fixture {
    bytes32 internal constant BANK_C = keccak256("bank-c");
    uint256 internal constant FACE = 1000_00; // $1,000.00 per unit
    uint256 internal constant KYC = 1;
    uint16 internal constant CANADA = 124;

    address internal bankC;
    uint256 internal bankCKey;
    Bond internal bond;

    ClaimIssuer internal cbIssuer;
    ClaimIssuer internal bankAIssuer;
    ClaimIssuer internal bankBIssuer;
    Identity internal bankAId;
    Identity internal bankBId;
    ClaimTopicsRegistry internal topics;
    TrustedIssuersRegistry internal issuers;
    IdentityRegistryStorage internal identityStorage;
    IdentityRegistry internal identities;
    ModularCompliance internal compliance;
    SettlementOnlyModule internal settlementOnly;

    function setUp() public virtual override {
        super.setUp();
        (bankC, bankCKey) = makeAddrAndKey("bank-c");
        vm.startPrank(cb);
        registry.admitBank(BANK_C, bankC);
        wcad.openReserveAccount(BANK_C);
        cbIssuer = new ClaimIssuer(registry, cb);
        vm.stopPrank();

        vm.prank(bankA);
        bankAIssuer = new ClaimIssuer(registry, bankA);
        vm.prank(bankB);
        bankBIssuer = new ClaimIssuer(registry, bankB);
        bankAId = _identityOf(bankA);
        bankBId = _identityOf(bankB);
        _attest(cb, cbKey, cbIssuer, bankAId, bankA);
        _attest(cb, cbKey, cbIssuer, bankBId, bankB);

        vm.startPrank(bankC);
        topics = new ClaimTopicsRegistry(registry, bankC);
        topics.addClaimTopic(KYC);
        issuers = new TrustedIssuersRegistry(registry, bankC);
        uint256[] memory kyc = new uint256[](1);
        kyc[0] = KYC;
        issuers.addTrustedIssuer(IClaimIssuer(address(cbIssuer)), kyc);
        issuers.addTrustedIssuer(IClaimIssuer(address(bankAIssuer)), kyc);
        issuers.addTrustedIssuer(IClaimIssuer(address(bankBIssuer)), kyc);
        identityStorage = new IdentityRegistryStorage(registry, bankC);
        identities = new IdentityRegistry(
            registry, bankC, address(issuers), address(topics), address(identityStorage)
        );
        identityStorage.bindIdentityRegistry(address(identities));
        identities.addAgent(bankC);
        compliance = new ModularCompliance(registry, bankC);
        settlementOnly = new SettlementOnlyModule();
        compliance.addModule(address(settlementOnly));
        Identity bondId = new Identity(registry, bankC);
        bond = new Bond(
            "Issuer 3.25% 2031",
            "BOND-ISSUER-2031",
            registry,
            BANK_C,
            "Issuer",
            _terms(),
            Bond.Regulation(
                IIdentityRegistry(address(identities)), ICompliance(address(compliance)), address(bondId)
            )
        );
        compliance.bindToken(address(bond));
        // The bond registers a recovered wallet's identity itself.
        identities.addAgent(address(bond));
        bond.grantRole(bond.SETTLEMENT_ROLE(), address(engine));
        identities.registerIdentity(bankA, IIdentity(address(bankAId)), CANADA);
        identities.registerIdentity(bankB, IIdentity(address(bankBId)), CANADA);
        vm.stopPrank();
        vm.prank(cb);
        registry.listToken(address(bond));

        _fund(bankA, 1_000_000_000_00);
        _fund(bankB, 1_000_000_000_00);
    }

    function _terms() internal pure returns (Bond.Terms memory) {
        return Bond.Terms({
            faceValue: FACE,
            couponRate: 0.0325e18,
            frequency: 2,
            dayCount: Bond.DayCount.Act365F,
            issueDate: 20261102,
            maturityDate: 20311102,
            recordDays: 1,
            termsHash: keccak256("terms")
        });
    }

    /// @dev An identity managed by the participant whose key `manager` is.
    function _identityOf(address manager) internal returns (Identity id) {
        vm.prank(manager);
        id = new Identity(registry, manager);
    }

    /// @dev A KYC claim by `issuer`, signed with `signerKey`, added to `identity` by its manager.
    function _attest(address, uint256 signerKey, ClaimIssuer issuer, Identity identity, address manager)
        internal
        returns (bytes memory signature)
    {
        signature = _claimSignature(signerKey, identity, KYC, "KYC verified");
        vm.prank(manager);
        identity.addClaim(KYC, 1, address(issuer), signature, "KYC verified", "");
    }

    function _claimSignature(uint256 key, Identity identity, uint256 topic, bytes memory data)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 hash = keccak256(abi.encode(address(identity), topic, data));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash)));
        return abi.encodePacked(r, s, v);
    }

    function _approvals(SettlementEngine.Instruction memory i, bool withA, bool withB)
        internal
        view
        returns (SettlementEngine.Approval[] memory list)
    {
        list = new SettlementEngine.Approval[]((withA ? 1 : 0) + (withB ? 1 : 0));
        uint256 n;
        if (withA) list[n++] = _sign(bankA, bankAKey, i);
        if (withB) list[n++] = _sign(bankB, bankBKey, i);
    }

    /// @dev Issue 600 units to A and 400 to B at par, paid to the agent in wholesale tokens.
    function _issuance() internal returns (SettlementEngine.Instruction memory) {
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](4);
        legs[0] = _mint(bond, bankA, 600);
        legs[1] = _mint(bond, bankB, 400);
        legs[2] = _move(wcad, bankA, bankC, 600 * FACE);
        legs[3] = _move(wcad, bankB, bankC, 400 * FACE);
        return _instruction(legs);
    }

    function _issue() internal {
        SettlementEngine.Instruction memory i = _issuance();
        _submit(bankC, i, _approvals(i, true, true));
    }
}
