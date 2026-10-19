// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {DepositToken} from "../src/DepositToken.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {WholesaleToken} from "../src/WholesaleToken.sol";
import {ERC20Restricted} from "../src/vendor/oz-community/token/ERC20Restricted.sol";
import {Fixture} from "./Fixture.sol";

/// @notice Two currencies on one ledger (SPEC.md §13): the CAD central bank operates the registry and admits
/// the USD central bank, which issues and lists wholesale USD alone; Bank C, the dealer, holds reserves in
/// both; Bank B also holds USD reserves and issues USD deposits. A cross-border payment is one instruction of
/// four legs, settled by the same engine.
contract CrossCurrencyTest is Fixture {
    bytes32 internal constant USD_CB = keccak256("usd-central-bank");
    bytes32 internal constant BANK_C = keccak256("bank-c");

    address internal usdCb;
    address internal bankC;
    uint256 internal bankCKey;
    WholesaleToken internal wusd;
    DepositToken internal dusdB;

    function setUp() public override {
        super.setUp();
        usdCb = makeAddr("usd-central-bank");
        (bankC, bankCKey) = makeAddrAndKey("bank-c");

        vm.startPrank(cb);
        registry.admitCentralBank(USD_CB, usdCb);
        registry.admitBank(BANK_C, bankC);
        wcad.openReserveAccount(BANK_C);
        vm.stopPrank();

        vm.startPrank(usdCb);
        wusd = new WholesaleToken("Wholesale USD", "wUSD", 2, registry, USD_CB);
        wusd.grantRole(wusd.SETTLEMENT_ROLE(), address(engine));
        wusd.openReserveAccount(BANK_B);
        wusd.openReserveAccount(BANK_C);
        registry.listToken(address(wusd));
        vm.stopPrank();

        vm.startPrank(bankB);
        dusdB = new DepositToken("Bank B deposit USD", "dUSD-B", 2, registry, BANK_B);
        dusdB.grantRole(dusdB.SETTLEMENT_ROLE(), address(engine));
        dusdB.allowHolder(carol);
        vm.stopPrank();
        vm.prank(cb);
        registry.listToken(address(dusdB));
    }

    // ---------------------------------------------------------------- the registry with two central banks

    function test_theFirstCentralBankOperatesTheRegistry() public view {
        assertEq(registry.operator(), CB);
        assertTrue(registry.isActiveOfKind(usdCb, ParticipantRegistry.Kind.CentralBank));
        assertTrue(registry.hasRole(registry.REGISTRAR_ROLE(), cb));
        assertFalse(registry.hasRole(registry.REGISTRAR_ROLE(), usdCb));
        assertEq(wusd.issuer(), USD_CB);
        assertTrue(registry.isListed(address(wusd)));
    }

    function test_anotherCentralBankAdmitsNoOne() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, usdCb, registry.REGISTRAR_ROLE()
            )
        );
        vm.prank(usdCb);
        registry.admitBank(keccak256("bank-d"), makeAddr("bank-d"));
    }

    function test_aCentralBankListsOnlyWhatItIssues() public {
        vm.startPrank(usdCb);
        vm.expectRevert(
            abi.encodeWithSelector(ParticipantRegistry.NotTokenLister.selector, usdCb, address(wcad))
        );
        registry.delistToken(address(wcad));
        vm.expectRevert(
            abi.encodeWithSelector(ParticipantRegistry.NotTokenLister.selector, usdCb, address(dusdB))
        );
        registry.delistToken(address(dusdB));
        registry.delistToken(address(wusd));
        vm.stopPrank();
        assertFalse(registry.isListed(address(wusd)));

        // A bank lists nothing, not even its own deposit token.
        vm.expectRevert(
            abi.encodeWithSelector(ParticipantRegistry.NotTokenLister.selector, bankB, address(dusdB))
        );
        vm.prank(bankB);
        registry.listToken(address(dusdB));
    }

    function test_aCentralBankIsNeverSuspended() public {
        vm.startPrank(cb);
        vm.expectRevert(
            abi.encodeWithSelector(ParticipantRegistry.CentralBankNotSuspendable.selector, USD_CB)
        );
        registry.suspend(USD_CB);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.CentralBankNotSuspendable.selector, CB));
        registry.suspend(CB);
        vm.stopPrank();
    }

    function test_aWholesaleIssuerMustBeACentralBank() public {
        vm.expectRevert(abi.encodeWithSelector(WholesaleToken.NotACentralBank.selector, BANK_A));
        new WholesaleToken("Not a central bank", "wXXX", 2, registry, BANK_A);
    }

    // ---------------------------------------------------------------- each currency is its central bank's

    function test_eachCentralBankAloneMintsItsCurrency() public {
        SettlementEngine.Instruction memory mint = _instruction(_mint(wusd, bankC, 1_000_00));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, USD_CB));
        _submit(cb, mint, _none());

        _submit(usdCb, mint, _none());
        assertEq(wusd.balanceOf(bankC), 1_000_00);
    }

    function test_onlyABankWithAReserveAccountHoldsACurrency() public {
        // Bank A holds no USD reserves: the USD central bank never opened it an account.
        vm.expectRevert(abi.encodeWithSelector(ERC20Restricted.ERC20UserRestricted.selector, bankA));
        _submit(usdCb, _instruction(_mint(wusd, bankA, 1_00)), _none());

        vm.expectRevert(abi.encodeWithSelector(WholesaleToken.NotABank.selector, CB));
        vm.prank(usdCb);
        wusd.openReserveAccount(CB);

        // Closing an account freezes what the bank holds there until it reopens.
        _submit(usdCb, _instruction(_mint(wusd, bankC, 5_00)), _none());
        vm.prank(usdCb);
        wusd.closeReserveAccount(BANK_C);
        assertFalse(wusd.hasReserveAccount(BANK_C));
        vm.expectRevert(abi.encodeWithSelector(ERC20Restricted.ERC20UserRestricted.selector, bankC));
        _submit(bankC, _instruction(_move(wusd, bankC, bankB, 5_00)), _none());

        // The CAD central bank cannot open accounts in USD.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, cb, wusd.ACCOUNTS_ROLE()
            )
        );
        vm.prank(cb);
        wusd.openReserveAccount(BANK_A);
    }

    // ---------------------------------------------------------------- payment versus payment

    /// @dev A Bank A customer pays a Bank B customer in USD from a CAD deposit, through the dealer.
    function _pvp(uint256 cad, uint256 usd) internal returns (SettlementEngine.Instruction memory) {
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](4);
        legs[0] = _burn(dcadA, alice, cad);
        legs[1] = _move(wcad, bankA, bankC, cad);
        legs[2] = _move(wusd, bankC, bankB, usd);
        legs[3] = _mint(dusdB, carol, usd);
        return _instruction(legs);
    }

    function _two(SettlementEngine.Approval memory a, SettlementEngine.Approval memory b)
        internal
        pure
        returns (SettlementEngine.Approval[] memory list)
    {
        list = new SettlementEngine.Approval[](2);
        list[0] = a;
        list[1] = b;
    }

    function _fundBoth() internal {
        _fund(bankA, 10_000_00);
        _tokenize(dcadA, bankA, alice, 2_000_00);
        _submit(usdCb, _instruction(_mint(wusd, bankC, 10_000_00)), _none());
    }

    function test_paymentVersusPaymentSettlesFourLegsInOneInstruction() public {
        _fundBoth();
        SettlementEngine.Instruction memory i = _pvp(1_000_00, 731_50);
        _submit(bankA, i, _two(_sign(bankC, bankCKey, i), _sign(bankB, bankBKey, i)));

        assertEq(dcadA.balanceOf(alice), 1_000_00);
        assertEq(wcad.balanceOf(bankA), 9_000_00);
        assertEq(wcad.balanceOf(bankC), 1_000_00);
        assertEq(wusd.balanceOf(bankC), 9_268_50);
        assertEq(wusd.balanceOf(bankB), 731_50);
        assertEq(dusdB.balanceOf(carol), 731_50);
        assertEq(engine.settledAt(i.id), block.number);
    }

    function test_paymentVersusPaymentNeedsTheDealerAndThePayeeBank() public {
        _fundBoth();
        SettlementEngine.Instruction memory i = _pvp(1_000_00, 731_50);
        SettlementEngine.Approval memory dealer = _sign(bankC, bankCKey, i);
        SettlementEngine.Approval memory payeeBank = _sign(bankB, bankBKey, i);
        // The dealer's USD leaves it; nothing else can authorize that leg.
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 2, BANK_C));
        _submit(bankA, i, _one(payeeBank));
        // The mint creates Bank B's liability.
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 3, BANK_B));
        _submit(bankA, i, _one(dealer));
    }

    function test_neitherCurrencyMovesWithoutTheOther() public {
        _fund(bankA, 10_000_00);
        _tokenize(dcadA, bankA, alice, 2_000_00);
        _submit(usdCb, _instruction(_mint(wusd, bankC, 500_00)), _none());

        // The dealer lacks the USD: the CAD it would have received does not move either.
        SettlementEngine.Instruction memory i = _pvp(1_000_00, 731_50);
        SettlementEngine.Approval[] memory approvals =
            _two(_sign(bankC, bankCKey, i), _sign(bankB, bankBKey, i));
        vm.expectRevert();
        _submit(bankA, i, approvals);

        assertEq(dcadA.balanceOf(alice), 2_000_00);
        assertEq(wcad.balanceOf(bankA), 10_000_00);
        assertEq(wcad.balanceOf(bankC), 0);
        assertEq(wusd.balanceOf(bankC), 500_00);
        assertEq(dusdB.balanceOf(carol), 0);
        assertEq(engine.settledAt(i.id), 0);
    }
}
