// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ConfidentialSettlement, INotoLocks} from "../src/ConfidentialSettlement.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {Fixture} from "./Fixture.sol";

/// @notice Noto's V1 lock rules, in miniature: a lock records commitments to its spend and cancel arguments;
/// only its current spender may spend, cancel or re-delegate it, and only with arguments matching the
/// commitment. Spending applies the lock's effect (a burn or a mint of a private balance), cancelling none.
/// The real Noto is proven against Paladin nodes on Besu (pnpm confidential:pay).
contract MockNotoLock is INotoLocks {
    struct Lock {
        address spender;
        bytes32 spendCommitment;
        bytes32 cancelCommitment;
        address holder;
        int256 delta;
    }

    mapping(bytes32 => Lock) public locks;
    mapping(address => int256) public balanceOf;

    error NotSpender(address caller);
    error WrongArguments();
    error NoLock();

    function createLock(
        bytes32 lockId,
        address holder,
        int256 delta,
        bytes calldata spendArgs,
        bytes calldata cancelArgs
    ) external {
        locks[lockId] = Lock(msg.sender, keccak256(spendArgs), keccak256(cancelArgs), holder, delta);
    }

    function mintTo(address holder, int256 amount) external {
        balanceOf[holder] += amount;
    }

    function delegateLock(bytes32 lockId, address newSpender) external {
        Lock storage l = _spender(lockId);
        l.spender = newSpender;
    }

    function spendLock(bytes32 lockId, bytes calldata spendArgs, bytes calldata) external {
        Lock storage l = _spender(lockId);
        if (keccak256(spendArgs) != l.spendCommitment) revert WrongArguments();
        balanceOf[l.holder] += l.delta;
        if (balanceOf[l.holder] < 0) revert WrongArguments();
        delete locks[lockId];
    }

    function cancelLock(bytes32 lockId, bytes calldata cancelArgs, bytes calldata) external {
        Lock storage l = _spender(lockId);
        if (keccak256(cancelArgs) != l.cancelCommitment) revert WrongArguments();
        delete locks[lockId];
    }

    function _spender(bytes32 lockId) private view returns (Lock storage l) {
        l = locks[lockId];
        if (l.spender == address(0)) revert NoLock();
        if (l.spender != msg.sender) revert NotSpender(msg.sender);
    }
}

contract ConfidentialSettlementTest is Fixture {
    ConfidentialSettlement internal cs;
    MockNotoLock internal notoA; // Bank A's deposit token, private on Bank A's Paladin node
    MockNotoLock internal notoB; // Bank B's

    bytes32 internal constant BURN_LOCK = keccak256("burn lock");
    bytes32 internal constant MINT_LOCK = keccak256("mint lock");

    function setUp() public override {
        super.setUp();
        cs = new ConfidentialSettlement(registry, cb);
        vm.startPrank(cb);
        wcad.grantRole(wcad.SETTLEMENT_ROLE(), address(cs));
        vm.stopPrank();
        notoA = new MockNotoLock();
        notoB = new MockNotoLock();
        vm.startPrank(cb);
        cs.listNoto(address(notoA), BANK_A);
        cs.listNoto(address(notoB), BANK_B);
        vm.stopPrank();

        _fund(bankA, 1_000_000);
        notoA.mintTo(alice, 50_000);
    }

    /// @dev The payer's bank locks a burn, the payee's bank a mint; both delegate their locks to the contract.
    function _lockBoth(uint256 amount, bool delegateMint) internal {
        vm.startPrank(bankA);
        notoA.createLock(BURN_LOCK, alice, -int256(amount), "burn spend", "burn cancel");
        notoA.delegateLock(BURN_LOCK, address(cs));
        vm.stopPrank();
        vm.startPrank(bankB);
        notoB.createLock(MINT_LOCK, carol, int256(amount), "mint spend", "mint cancel");
        if (delegateMint) notoB.delegateLock(MINT_LOCK, address(cs));
        vm.stopPrank();
    }

    function _payment(uint256 amount) internal view returns (ConfidentialSettlement.Payment memory p) {
        p.id = keccak256(abi.encode("payment", amount));
        p.deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        p.legs = new SettlementEngine.Leg[](1);
        p.legs[0] = _move(wcad, bankA, bankB, amount);
        p.notoLegs = new ConfidentialSettlement.NotoLeg[](2);
        p.notoLegs[0] = ConfidentialSettlement.NotoLeg(address(notoA), BURN_LOCK, "burn spend");
        p.notoLegs[1] = ConfidentialSettlement.NotoLeg(address(notoB), MINT_LOCK, "mint spend");
    }

    function _approval(address signer, uint256 key, ConfidentialSettlement.Payment memory p)
        internal
        view
        returns (SettlementEngine.Approval[] memory list)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, cs.digest(p));
        list = new SettlementEngine.Approval[](1);
        list[0] = SettlementEngine.Approval(signer, abi.encodePacked(r, s, v));
    }

    function test_settlesWholesaleAndBothDepositsInOneTransaction() public {
        _lockBoth(2_500, true);
        ConfidentialSettlement.Payment memory p = _payment(2_500);
        SettlementEngine.Approval[] memory approvals = _approval(bankB, bankBKey, p);
        vm.prank(bankA);
        cs.settle(p, approvals);

        assertEq(notoA.balanceOf(alice), 47_500, "the payer's deposit is burned");
        assertEq(notoB.balanceOf(carol), 2_500, "the payee's deposit is minted");
        assertEq(wcad.balanceOf(bankB), 2_500, "wholesale moved between the banks");
        assertEq(cs.settledAt(p.id), block.number);
    }

    function test_aLockNotDelegatedHereStopsEverything() public {
        _lockBoth(2_500, false); // Bank B never delegated its mint lock
        ConfidentialSettlement.Payment memory p = _payment(2_500);
        SettlementEngine.Approval[] memory approvals = _approval(bankB, bankBKey, p);
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(MockNotoLock.NotSpender.selector, address(cs)));
        cs.settle(p, approvals);
        assertEq(wcad.balanceOf(bankB), 0, "nothing moved");
        assertEq(notoA.balanceOf(alice), 50_000);
    }

    function test_thePayeeBankMustApproveTheMintOfItsLiability() public {
        _lockBoth(2_500, true);
        ConfidentialSettlement.Payment memory p = _payment(2_500);
        vm.prank(bankA);
        vm.expectRevert(
            abi.encodeWithSelector(ConfidentialSettlement.MissingNotoApproval.selector, 1, BANK_B)
        );
        cs.settle(p, _none());
    }

    function test_anApprovalCoversTheSpendArguments() public {
        _lockBoth(2_500, true);
        ConfidentialSettlement.Payment memory p = _payment(2_500);
        SettlementEngine.Approval[] memory approvals = _approval(bankB, bankBKey, p);
        p.notoLegs[1].spendArgs = "something else";
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidApproval.selector, bankB));
        cs.settle(p, approvals);
    }

    function test_wholesaleLegsNeedTheirOwnAuthority() public {
        _lockBoth(2_500, true);
        ConfidentialSettlement.Payment memory p = _payment(2_500);
        // Bank B submits with nobody's signature for Bank A's wholesale.
        vm.prank(bankB);
        vm.expectRevert();
        cs.settle(p, _none());
        assertEq(wcad.balanceOf(bankB), 0);
    }

    function test_aPaymentSettlesOnceAndNotAfterItsDeadline() public {
        _lockBoth(2_500, true);
        ConfidentialSettlement.Payment memory p = _payment(2_500);
        SettlementEngine.Approval[] memory approvals = _approval(bankB, bankBKey, p);
        vm.prank(bankA);
        cs.settle(p, approvals);
        vm.prank(bankA);
        vm.expectRevert(
            abi.encodeWithSelector(ConfidentialSettlement.AlreadySettled.selector, p.id, block.number)
        );
        cs.settle(p, approvals);

        ConfidentialSettlement.Payment memory late = _payment(1);
        SettlementEngine.Approval[] memory lateApproval = _approval(bankB, bankBKey, late);
        vm.warp(late.deadline + 1);
        vm.prank(bankA);
        vm.expectRevert(
            abi.encodeWithSelector(ConfidentialSettlement.PaymentExpired.selector, late.id, late.deadline)
        );
        cs.settle(late, lateApproval);
    }

    function test_onlyListedNotoTokens() public {
        MockNotoLock stranger = new MockNotoLock();
        ConfidentialSettlement.Payment memory p = _payment(2_500);
        p.notoLegs[1].noto = address(stranger);
        SettlementEngine.Approval[] memory approvals = _approval(bankB, bankBKey, p);
        vm.prank(bankA);
        vm.expectRevert(
            abi.encodeWithSelector(ConfidentialSettlement.NotoNotListed.selector, address(stranger))
        );
        cs.settle(p, approvals);

        vm.prank(bankA);
        vm.expectRevert();
        cs.listNoto(address(stranger), BANK_A);
    }

    function test_aBankCancelsItsOwnLockAndThePaymentCannotSettle() public {
        _lockBoth(2_500, true);
        vm.prank(bankA);
        vm.expectRevert(
            abi.encodeWithSelector(ConfidentialSettlement.NotTheBank.selector, address(notoB), bankA)
        );
        cs.cancel(address(notoB), MINT_LOCK, "mint cancel");

        vm.prank(bankB);
        cs.cancel(address(notoB), MINT_LOCK, "mint cancel");

        ConfidentialSettlement.Payment memory p = _payment(2_500);
        SettlementEngine.Approval[] memory approvals = _approval(bankB, bankBKey, p);
        vm.prank(bankA);
        vm.expectRevert(MockNotoLock.NoLock.selector);
        cs.settle(p, approvals);
        assertEq(wcad.balanceOf(bankB), 0, "nothing moved");

        // The payer's bank takes back its burn lock too.
        vm.prank(bankA);
        cs.cancel(address(notoA), BURN_LOCK, "burn cancel");
        assertEq(notoA.balanceOf(alice), 50_000);
    }
}
