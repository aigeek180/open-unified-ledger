// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ConditionalSettlement} from "../src/ConditionalSettlement.sol";
import {DepositToken} from "../src/DepositToken.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {SettlementToken} from "../src/SettlementToken.sol";
import {WholesaleToken} from "../src/WholesaleToken.sol";
import {Fixture} from "./Fixture.sol";

/// @notice A payment across currencies split across two ledgers (SPEC.md §13): CAD on ledger 1, USD on
/// ledger 2. Ledger 1 holds the payer's CAD burn and Bank A's wCAD to the dealer, Bank C; ledger 2 holds the
/// dealer's wUSD to Bank B and the payee's USD mint, locked by the dealer and co-signed by Bank B. One EVM
/// stands in for both ledgers, which share nothing. Where the coordination leaves the ledgers disagreeing,
/// one currency was delivered and the other not: FX settlement risk, which payment versus payment on one
/// ledger removes (CrossCurrency.t.sol).
contract CrossCurrencyInteropTest is Fixture {
    bytes32 internal constant USD_CB = keccak256("usd-central-bank");
    bytes32 internal constant BANK_C = keccak256("bank-c");
    bytes32 internal constant SECRET = keccak256("the payer's bank's secret");
    uint256 internal constant CAD = 1_000_00;
    uint256 internal constant USD = 731_50;

    address internal usdCb;
    address internal bankC;
    uint256 internal bankCKey;
    address internal notary;
    bytes32 internal hashOfSecret;

    ConditionalSettlement internal cs1;

    // Ledger 2: USD.
    ParticipantRegistry internal registry2;
    WholesaleToken internal wusd2;
    DepositToken internal dusdB2;
    SettlementEngine internal engine2;
    ConditionalSettlement internal cs2;

    function setUp() public override {
        super.setUp();
        usdCb = makeAddr("usd-central-bank");
        (bankC, bankCKey) = makeAddrAndKey("bank-c");
        notary = makeAddr("notary");
        hashOfSecret = sha256(abi.encodePacked(SECRET));

        // Ledger 1: the dealer holds CAD reserves; locks may move wCAD and dCAD-A.
        vm.startPrank(cb);
        registry.admitBank(BANK_C, bankC);
        wcad.openReserveAccount(BANK_C);
        vm.stopPrank();
        cs1 = new ConditionalSettlement(registry);
        _grantLocks(wcad, cb, address(cs1));
        _grantLocks(dcadA, bankA, address(cs1));

        // Ledger 2: the USD central bank operates it; Bank B and the dealer hold USD reserves.
        vm.startPrank(usdCb);
        registry2 = new ParticipantRegistry(USD_CB, usdCb);
        registry2.admitBank(BANK_B, bankB);
        registry2.admitBank(BANK_C, bankC);
        wusd2 = new WholesaleToken("Wholesale USD", "wUSD", 2, registry2, USD_CB);
        wusd2.openReserveAccount(BANK_B);
        wusd2.openReserveAccount(BANK_C);
        engine2 = new SettlementEngine(registry2);
        wusd2.grantRole(wusd2.SETTLEMENT_ROLE(), address(engine2));
        vm.stopPrank();
        vm.startPrank(bankB);
        dusdB2 = new DepositToken("Bank B deposit USD", "dUSD-B", 2, registry2, BANK_B);
        dusdB2.allowHolder(carol);
        vm.stopPrank();
        cs2 = new ConditionalSettlement(registry2);
        _grantLocks(wusd2, usdCb, address(cs2));
        _grantLocks(dusdB2, bankB, address(cs2));
        vm.startPrank(usdCb);
        registry2.listToken(address(wusd2));
        registry2.listToken(address(dusdB2));
        vm.stopPrank();

        _fund(bankA, 10_000_00);
        _tokenize(dcadA, bankA, alice, 5_000_00);
        // The USD central bank funds the dealer's wUSD on ledger 2.
        SettlementEngine.Instruction memory fund = _instruction(_mint(wusd2, bankC, 10_000_00));
        vm.prank(usdCb);
        engine2.settle(fund, _none());
    }

    function _grantLocks(SettlementToken token, address admin, address locks) private {
        vm.startPrank(admin);
        token.grantRole(token.SETTLEMENT_ROLE(), locks);
        token.grantRole(token.FREEZER_ROLE(), locks);
        vm.stopPrank();
    }

    function _hashlock(uint256 inSeconds) internal view returns (ConditionalSettlement.Condition memory) {
        return ConditionalSettlement.Condition(
            ConditionalSettlement.ConditionKind.Hashlock,
            hashOfSecret,
            address(0),
            uint64(vm.getBlockTimestamp() + inSeconds)
        );
    }

    function _notarized(uint256 inSeconds) internal view returns (ConditionalSettlement.Condition memory) {
        return ConditionalSettlement.Condition(
            ConditionalSettlement.ConditionKind.Notary,
            bytes32(0),
            notary,
            uint64(vm.getBlockTimestamp() + inSeconds)
        );
    }

    /// @dev Ledger 1's part, in CAD: burn the payer's deposit, move wCAD from Bank A to the dealer.
    function _cadPart() internal returns (SettlementEngine.Instruction memory i) {
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _burn(dcadA, alice, CAD);
        legs[1] = _move(wcad, bankA, bankC, CAD);
        i = _instruction(legs);
    }

    /// @dev Ledger 2's part, in USD, under the same id: the dealer's wUSD to Bank B, the payee's mint.
    function _usdPart(bytes32 id) internal view returns (SettlementEngine.Instruction memory i) {
        i.id = id;
        i.deadline = uint64(vm.getBlockTimestamp() + 1 days);
        i.legs = new SettlementEngine.Leg[](2);
        i.legs[0] = _move(wusd2, bankC, bankB, USD);
        i.legs[1] = _mint(dusdB2, carol, USD);
    }

    /// @dev The dealer locks ledger 2's part; Bank B co-signs, since the mint creates its liability.
    function _dealerLocks(SettlementEngine.Instruction memory i, ConditionalSettlement.Condition memory c)
        internal
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bankBKey, cs2.digest(i, c));
        SettlementEngine.Approval[] memory approvals =
            _one(SettlementEngine.Approval(bankB, abi.encodePacked(r, s, v)));
        vm.prank(bankC);
        cs2.lock(i, approvals, c);
    }

    function _settled(ConditionalSettlement cs, bytes32 id) internal view returns (bool) {
        return cs.lockOf(id).state == ConditionalSettlement.State.Settled;
    }

    function test_ledger2sPartNeedsThePayeeBanksConsent() public {
        SettlementEngine.Instruction memory usd = _usdPart(_cadPart().id);
        ConditionalSettlement.Condition memory c = _hashlock(1 hours);
        // The dealer alone covers its own wUSD, not the payee's mint.
        vm.prank(bankC);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 1, BANK_B));
        cs2.lock(usd, _none(), c);
        _dealerLocks(usd, c);
        assertEq(wusd2.getFrozenTokens(bankC), USD, "the dealer's USD is held in place");
    }

    function test_htlc_deliversBothCurrenciesWhenEverySideActs() public {
        SettlementEngine.Instruction memory cad = _cadPart();
        SettlementEngine.Instruction memory usd = _usdPart(cad.id);
        vm.prank(bankA);
        cs1.lock(cad, _none(), _hashlock(2 hours));
        _dealerLocks(usd, _hashlock(1 hours));

        vm.prank(bankA);
        cs2.claim(cad.id, SECRET); // USD delivered to the payee; the secret is public on ledger 2
        assertTrue(
            _settled(cs2, cad.id) && !_settled(cs1, cad.id), "USD delivered, CAD not yet: the window is open"
        );
        vm.prank(bankC);
        cs1.claim(cad.id, SECRET);
        assertEq(dusdB2.balanceOf(carol), USD);
        assertEq(wusd2.balanceOf(bankB), USD);
        assertEq(wcad.balanceOf(bankC), CAD, "and closes once the dealer collects its CAD");
        assertEq(dcadA.balanceOf(alice), 5_000_00 - CAD);
    }

    function test_htlc_aDealerOfflinePastLedger1sTimeoutDeliversUsdForNothing() public {
        SettlementEngine.Instruction memory cad = _cadPart();
        ConditionalSettlement.Condition memory c1 = _hashlock(2 hours);
        vm.prank(bankA);
        cs1.lock(cad, _none(), c1);
        _dealerLocks(_usdPart(cad.id), _hashlock(1 hours));
        vm.prank(bankA);
        cs2.claim(cad.id, SECRET);

        // The dealer is offline past ledger 1's timeout; Bank A takes its CAD back.
        vm.warp(c1.timeout);
        cs1.refund(cad.id);

        assertEq(wusd2.balanceOf(bankB), USD, "the dealer delivered the USD");
        assertEq(
            wcad.balanceOf(bankC), 0, "and never received the CAD: FX settlement risk, borne by the dealer"
        );
        assertEq(dcadA.balanceOf(alice), 5_000_00, "while the payer kept its money");
        assertEq(dusdB2.balanceOf(carol), USD, "and the payee was paid");
    }

    function test_notary_aCrashBetweenCommitsDeliversCadForNothing() public {
        SettlementEngine.Instruction memory cad = _cadPart();
        ConditionalSettlement.Condition memory c2 = _notarized(1 hours);
        vm.prank(bankA);
        cs1.lock(cad, _none(), _notarized(1 hours));
        _dealerLocks(_usdPart(cad.id), c2);

        vm.prank(notary);
        cs1.commit(cad.id); // CAD delivered to the dealer
        // The notary crashes and is back only after ledger 2's timeout; the dealer refunds its USD.
        vm.warp(c2.timeout);
        cs2.refund(cad.id);

        assertEq(wcad.balanceOf(bankC), CAD, "the dealer received the CAD");
        assertEq(
            wusd2.balanceOf(bankC),
            10_000_00,
            "and kept its USD: FX settlement risk, borne by the payer's side"
        );
        assertEq(dcadA.balanceOf(alice), 5_000_00 - CAD, "the payer paid");
        assertEq(dusdB2.balanceOf(carol), 0, "and the payee was never credited");
    }

    function test_notary_abortsBothWhenTheDealerCannotLock() public {
        SettlementEngine.Instruction memory cad = _cadPart();
        vm.prank(bankA);
        cs1.lock(cad, _none(), _notarized(1 hours));
        // The dealer does not lock (it lacks the USD, or will not trade); the notary aborts ledger 1.
        vm.prank(notary);
        cs1.abort(cad.id);
        assertEq(dcadA.balanceOf(alice), 5_000_00);
        assertEq(dcadA.getFrozenTokens(alice), 0, "nothing stays held");
        assertEq(wcad.getFrozenTokens(bankA), 0);
    }
}
