// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {DepositToken} from "../src/DepositToken.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {SettlementToken} from "../src/SettlementToken.sol";
import {IERC7943Fungible} from "../src/vendor/oz-community/interfaces/IERC7943.sol";
import {ERC20Freezable} from "../src/vendor/oz-community/token/ERC20Freezable.sol";
import {ERC20Restricted} from "../src/vendor/oz-community/token/ERC20Restricted.sol";
import {Fixture} from "./Fixture.sol";

contract SettlementEngineTest is Fixture {
    function setUp() public override {
        super.setUp();
        _fund(bankA, 1_000_000_00); // $1,000,000.00
        _fund(bankB, 1_000_000_00);
        _tokenize(dcadA, bankA, alice, 50_000_00);
    }

    // ---------------------------------------------------------------- the flows

    function test_fundWholesaleFromTheCentralBank() public view {
        assertEq(wcad.balanceOf(bankA), 1_000_000_00);
        assertEq(wcad.totalSupply(), 2_000_000_00);
        assertEq(wcad.decimals(), 2);
    }

    function test_interbankTransferMovesAllThreeLegsTogether() public {
        SettlementEngine.Instruction memory i = _interbank(alice, carol, 2_500_00);
        _submit(bankA, i, _one(_sign(bankB, bankBKey, i)));

        assertEq(dcadA.balanceOf(alice), 47_500_00);
        assertEq(wcad.balanceOf(bankA), 997_500_00);
        assertEq(wcad.balanceOf(bankB), 1_002_500_00);
        assertEq(dcadB.balanceOf(carol), 2_500_00);
        assertEq(engine.settledAt(i.id), block.number);
    }

    function test_payeeBankMustApproveTheMintOfItsLiability() public {
        SettlementEngine.Instruction memory i = _interbank(alice, carol, 2_500_00);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 2, BANK_B));
        _submit(bankA, i, _none());
    }

    function test_aFailingLegRevertsTheWholeInstruction() public {
        // The payee is not on Bank B's allowlist: the third leg fails, so the first two never happened.
        SettlementEngine.Instruction memory i = _interbank(alice, mallory, 2_500_00);
        SettlementEngine.Approval[] memory approvals = _one(_sign(bankB, bankBKey, i));
        vm.expectRevert(abi.encodeWithSelector(ERC20Restricted.ERC20UserRestricted.selector, mallory));
        _submit(bankA, i, approvals);

        assertEq(dcadA.balanceOf(alice), 50_000_00);
        assertEq(wcad.balanceOf(bankA), 1_000_000_00);
        assertEq(engine.settledAt(i.id), 0);
    }

    function test_anInstructionSettlesOnlyOnce() public {
        SettlementEngine.Instruction memory i = _instruction(_mint(dcadA, bob, 100_00));
        _submit(bankA, i, _none());
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.AlreadySettled.selector, i.id, block.number));
        _submit(bankA, i, _none());
        assertEq(dcadA.balanceOf(bob), 100_00);
    }

    // ---------------------------------------------------------------- authority

    function test_aBankCannotMoveAnotherBanksCustomer() public {
        _tokenize(dcadB, bankB, carol, 1_000_00);
        SettlementEngine.Instruction memory i = _instruction(_burn(dcadB, carol, 1_000_00));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_B));
        _submit(bankA, i, _none());
    }

    function test_aBankCannotMoveAnotherBanksWholesale() public {
        SettlementEngine.Instruction memory i = _instruction(_move(wcad, bankB, bankA, 1_00));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_B));
        _submit(bankA, i, _none());
    }

    function test_onlyTheCentralBankMintsWholesale() public {
        SettlementEngine.Instruction memory i = _instruction(_mint(wcad, bankA, 1_00));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, CB));
        _submit(bankA, i, _none());
    }

    function test_onlyActiveParticipantsSubmit() public {
        SettlementEngine.Instruction memory i = _instruction(_mint(dcadA, bob, 1_00));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.NotASubmitter.selector, mallory));
        _submit(mallory, i, _none());
    }

    function test_aSignatureByTheWrongKeyIsRejected() public {
        SettlementEngine.Instruction memory i = _interbank(alice, carol, 1_00);
        SettlementEngine.Approval memory forged = _sign(bankB, bankAKey, i);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidApproval.selector, bankB));
        _submit(bankA, i, _one(forged));
    }

    function test_anApprovalIsBoundToTheInstruction() public {
        SettlementEngine.Instruction memory approved = _interbank(alice, carol, 1_00);
        SettlementEngine.Approval memory approval = _sign(bankB, bankBKey, approved);
        SettlementEngine.Instruction memory altered = _interbank(alice, carol, 999_00);
        altered.id = approved.id;
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidApproval.selector, bankB));
        _submit(bankA, altered, _one(approval));
    }

    function test_anApprovalIsBoundToTheChain() public {
        SettlementEngine.Instruction memory i = _interbank(alice, carol, 1_00);
        bytes32 here = engine.digest(i);
        vm.chainId(block.chainid + 1);
        assertTrue(engine.digest(i) != here);
    }

    function test_anExpiredInstructionIsRejected() public {
        SettlementEngine.Instruction memory i = _instruction(_mint(dcadA, bob, 1_00));
        vm.warp(i.deadline + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SettlementEngine.InstructionExpired.selector, i.id, i.deadline)
        );
        _submit(bankA, i, _none());
    }

    function test_aSuspendedBankCanNeitherApproveNorHoldWholesale() public {
        vm.prank(cb);
        registry.suspend(BANK_B);

        SettlementEngine.Instruction memory i = _interbank(alice, carol, 1_00);
        SettlementEngine.Approval[] memory approvals = _one(_sign(bankB, bankBKey, i));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidApproval.selector, bankB));
        _submit(bankA, i, approvals);

        assertFalse(wcad.canReceive(bankB));
        vm.expectRevert(abi.encodeWithSelector(ERC20Restricted.ERC20UserRestricted.selector, bankB));
        _fund(bankB, 1_00);
    }

    function test_unlistedTokensAreRefused() public {
        vm.prank(cb);
        registry.delistToken(address(dcadA));
        SettlementEngine.Instruction memory i = _instruction(_mint(dcadA, bob, 1_00));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.TokenNotListed.selector, 0, address(dcadA)));
        _submit(bankA, i, _none());
    }

    function test_malformedLegsAreRefused() public {
        SettlementEngine.Instruction memory i = _instruction(_move(dcadA, alice, alice, 1_00));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidLeg.selector, 0));
        _submit(bankA, i, _none());

        i = _instruction(_mint(dcadA, bob, 0));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidLeg.selector, 0));
        _submit(bankA, i, _none());
    }

    // ---------------------------------------------------------------- the tokens

    function test_tokensMoveOnlyThroughTheEngine() public {
        vm.startPrank(alice);
        vm.expectRevert(SettlementToken.DirectTransferDisabled.selector);
        dcadA.transfer(bob, 1);
        vm.expectRevert(SettlementToken.DirectTransferDisabled.selector);
        dcadA.approve(bob, 1);
        vm.expectRevert(SettlementToken.DirectTransferDisabled.selector);
        dcadA.transferFrom(alice, bob, 1);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bankA, dcadA.SETTLEMENT_ROLE()
            )
        );
        vm.prank(bankA);
        dcadA.settleMint(bankA, 1);
    }

    function test_frozenBalanceMovesOnlyByForcedTransfer() public {
        vm.prank(bankA);
        dcadA.setFrozenTokens(alice, 40_000_00);

        SettlementEngine.Instruction memory i = _instruction(_burn(dcadA, alice, 10_000_01));
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC20Freezable.ERC20InsufficientUnfrozenBalance.selector, alice, 10_000_01, 10_000_00
            )
        );
        _submit(bankA, i, _none());
        _submit(bankA, _instruction(_burn(dcadA, alice, 10_000_00)), _none());

        vm.prank(bankA);
        dcadA.forcedTransfer(alice, bob, 40_000_00);
        assertEq(dcadA.balanceOf(bob), 40_000_00);
        assertEq(dcadA.getFrozenTokens(alice), 0);
    }

    function test_theCentralBankCanPauseWholesale() public {
        vm.prank(cb);
        wcad.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _fund(bankA, 1_00);
    }

    function test_tokensReportERC7943() public view {
        assertTrue(dcadA.supportsInterface(type(IERC7943Fungible).interfaceId));
        assertTrue(wcad.supportsInterface(type(IERC7943Fungible).interfaceId));
        assertTrue(dcadA.canTransfer(alice, bob, 1_00));
        assertFalse(dcadA.canTransfer(alice, mallory, 1_00));
        assertFalse(wcad.canReceive(alice));
    }
}

contract ParticipantRegistryTest is Fixture {
    function test_admissionAndAddressBinding() public {
        bytes32 bankC = keccak256("bank-c");
        address account = makeAddr("bank-c");
        vm.startPrank(cb);
        registry.admitBank(bankC, account);
        vm.expectRevert(abi.encodeWithSelector(ParticipantRegistry.ParticipantExists.selector, bankC));
        registry.admitBank(bankC, makeAddr("other"));
        vm.expectRevert(
            abi.encodeWithSelector(ParticipantRegistry.AddressAlreadyBound.selector, account, bankC)
        );
        registry.bindAddress(BANK_A, account);
        vm.stopPrank();
        assertEq(registry.participantOf(account), bankC);
        assertTrue(registry.isActiveOfKind(account, ParticipantRegistry.Kind.Bank));
        assertTrue(registry.isActiveOfKind(cb, ParticipantRegistry.Kind.CentralBank));
    }

    function test_onlyTheRegistrarAdministers() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, bankA, registry.REGISTRAR_ROLE()
            )
        );
        vm.prank(bankA);
        registry.admitBank(keccak256("bank-c"), makeAddr("bank-c"));
    }

    function test_aDepositTokenIssuerMustBeABank() public {
        vm.expectRevert(abi.encodeWithSelector(DepositToken.NotABank.selector, CB));
        new DepositToken("Not a bank", "NAB", 2, registry, CB);
    }
}
