// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ConditionalSettlement} from "../src/ConditionalSettlement.sol";
import {DepositToken} from "../src/DepositToken.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {SettlementToken} from "../src/SettlementToken.sol";
import {Fixture} from "./Fixture.sol";

/// @notice Interop mode's building block (SPEC.md §7): the lock rules on one ledger, then the interbank
/// transfer split across two, where Bank B's deposit token lives on a second ledger. One EVM stands in for
/// both: ledger 2 has its own registry, its own dCAD-B and its own conditional settlement contract, and
/// shares nothing with ledger 1. The cross-ledger tests show where each coordination ends consistently and
/// where it can leave the two ledgers disagreeing.
contract ConditionalSettlementTest is Fixture {
    ConditionalSettlement internal cs1;

    // Ledger 2.
    ParticipantRegistry internal registry2;
    DepositToken internal dcadB2;
    ConditionalSettlement internal cs2;

    address internal notary;
    uint256 internal notaryKey;
    bytes32 internal constant SECRET = keccak256("the payer's bank's secret");
    /// @dev Hashed once here: sha256 is a precompile call, which would consume a pending prank or
    /// expectRevert if made while building a call's arguments.
    bytes32 internal hashOfSecret;

    function setUp() public override {
        super.setUp();
        (notary, notaryKey) = makeAddrAndKey("notary");
        hashOfSecret = sha256(abi.encodePacked(SECRET));

        cs1 = new ConditionalSettlement(registry);
        _grantLocks(wcad, cb, address(cs1));
        _grantLocks(dcadA, bankA, address(cs1));
        _grantLocks(dcadB, bankB, address(cs1));

        vm.startPrank(cb);
        registry2 = new ParticipantRegistry(CB, cb);
        registry2.admitBank(BANK_B, bankB);
        vm.stopPrank();
        vm.startPrank(bankB);
        dcadB2 = new DepositToken("Bank B deposit CAD", "dCAD-B", CAD_DECIMALS, registry2, BANK_B);
        dcadB2.allowHolder(carol);
        vm.stopPrank();
        cs2 = new ConditionalSettlement(registry2);
        _grantLocks(dcadB2, bankB, address(cs2));
        vm.prank(cb);
        registry2.listToken(address(dcadB2));

        _fund(bankA, 1_000_000);
        _tokenize(dcadA, bankA, alice, 50_000);
    }

    function _grantLocks(SettlementToken token, address admin, address locks) private {
        vm.startPrank(admin);
        token.grantRole(token.SETTLEMENT_ROLE(), locks);
        token.grantRole(token.FREEZER_ROLE(), locks);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- builders

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

    /// @dev Ledger 1's part of the split transfer: burn the payer's deposit, move wholesale A to B.
    function _ledger1Part(uint256 amount) internal returns (SettlementEngine.Instruction memory i) {
        SettlementEngine.Leg[] memory legs = new SettlementEngine.Leg[](2);
        legs[0] = _burn(dcadA, alice, amount);
        legs[1] = _move(wcad, bankA, bankB, amount);
        i = _instruction(legs);
    }

    /// @dev Ledger 2's part, under the same id: mint the payee's deposit at Bank B.
    function _ledger2Part(bytes32 id, uint256 amount)
        internal
        view
        returns (SettlementEngine.Instruction memory i)
    {
        i.id = id;
        i.deadline = uint64(vm.getBlockTimestamp() + 1 days);
        i.legs = new SettlementEngine.Leg[](1);
        i.legs[0] = _mint(dcadB2, carol, amount);
    }

    function _signLock(
        ConditionalSettlement cs,
        address signer,
        uint256 key,
        SettlementEngine.Instruction memory i,
        ConditionalSettlement.Condition memory c
    ) internal view returns (SettlementEngine.Approval memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, cs.digest(i, c));
        return SettlementEngine.Approval(signer, abi.encodePacked(r, s, v));
    }

    function _state(ConditionalSettlement cs, bytes32 id)
        internal
        view
        returns (ConditionalSettlement.State)
    {
        return cs.lockOf(id).state;
    }

    // ---------------------------------------------------------------- locking on one ledger

    function test_lockFreezesWhatTheLegsTakeAndRecordsTheRest() public {
        SettlementEngine.Instruction memory i = _ledger1Part(2_500);
        vm.prank(bankA);
        cs1.lock(i, _none(), _hashlock(1 hours));

        assertEq(dcadA.getFrozenTokens(alice), 2_500, "the payer's deposit is held in place");
        assertEq(wcad.getFrozenTokens(bankA), 2_500, "Bank A's wholesale is held in place");
        assertEq(dcadA.balanceOf(alice), 50_000, "nothing has moved");
        assertEq(wcad.balanceOf(bankB), 0);
        assertEq(uint8(_state(cs1, i.id)), uint8(ConditionalSettlement.State.Locked));
        assertEq(cs1.legsOf(i.id).length, 2);
    }

    function test_lockIsAuthorizedLikeASettlement() public {
        // Bank B cannot lock what Bank A's customer and Bank A hold.
        SettlementEngine.Instruction memory i = _ledger1Part(2_500);
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_A));
        cs1.lock(i, _none(), _hashlock(1 hours));
    }

    function test_anApprovalCoversOneConditionOnly() public {
        // Bank B signs a lock of the mint under one timeout; it is submitted under a longer one.
        SettlementEngine.Instruction memory i = _instruction(_mint(dcadB, carol, 100));
        SettlementEngine.Approval memory approval = _signLock(cs1, bankB, bankBKey, i, _hashlock(1 hours));
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.InvalidApproval.selector, bankB));
        cs1.lock(i, _one(approval), _hashlock(2 hours));
    }

    function test_cannotLockWhatIsAlreadyHeld() public {
        vm.prank(bankA);
        cs1.lock(_ledger1Part(40_000), _none(), _hashlock(1 hours));
        SettlementEngine.Instruction memory again = _ledger1Part(20_000);
        vm.prank(bankA);
        vm.expectRevert(
            abi.encodeWithSelector(ConditionalSettlement.InsufficientUnfrozenBalance.selector, 0, alice)
        );
        cs1.lock(again, _none(), _hashlock(1 hours));
    }

    function test_heldFundsCannotBeSpentMeanwhile() public {
        vm.prank(bankA);
        cs1.lock(_ledger1Part(50_000), _none(), _hashlock(1 hours));
        // A direct settlement of the same deposit fails: it is frozen for the lock.
        vm.expectRevert();
        _submit(bankA, _instruction(_burn(dcadA, alice, 1)), _none());
    }

    function test_anIdLocksOnce() public {
        SettlementEngine.Instruction memory i = _ledger1Part(100);
        vm.startPrank(bankA);
        cs1.lock(i, _none(), _hashlock(1 hours));
        vm.expectRevert(abi.encodeWithSelector(ConditionalSettlement.AlreadyLocked.selector, i.id));
        cs1.lock(i, _none(), _hashlock(1 hours));
        vm.stopPrank();
    }

    function test_conditionsMustBeWellFormed() public {
        SettlementEngine.Instruction memory i = _ledger1Part(100);
        ConditionalSettlement.Condition memory past = _hashlock(1 hours);
        past.timeout = uint64(vm.getBlockTimestamp());
        ConditionalSettlement.Condition memory mixed = _notarized(1 hours);
        mixed.hashlock = keccak256("both");
        vm.startPrank(bankA);
        vm.expectRevert(ConditionalSettlement.InvalidCondition.selector);
        cs1.lock(i, _none(), past);
        vm.expectRevert(ConditionalSettlement.InvalidCondition.selector);
        cs1.lock(i, _none(), mixed);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- hashlock

    function test_thePreimageSettlesEveryLeg() public {
        SettlementEngine.Instruction memory i = _ledger1Part(2_500);
        vm.prank(bankA);
        cs1.lock(i, _none(), _hashlock(1 hours));

        vm.expectEmit(address(cs1));
        emit ConditionalSettlement.Settled(i.id, SECRET);
        vm.prank(mallory); // knowing the preimage is the authority
        cs1.claim(i.id, SECRET);

        assertEq(dcadA.balanceOf(alice), 47_500);
        assertEq(dcadA.getFrozenTokens(alice), 0);
        assertEq(wcad.balanceOf(bankB), 2_500);
        assertEq(wcad.getFrozenTokens(bankA), 0);
        assertEq(uint8(_state(cs1, i.id)), uint8(ConditionalSettlement.State.Settled));
    }

    function test_aWrongPreimageSettlesNothing() public {
        SettlementEngine.Instruction memory i = _ledger1Part(2_500);
        vm.prank(bankA);
        cs1.lock(i, _none(), _hashlock(1 hours));
        vm.expectRevert(abi.encodeWithSelector(ConditionalSettlement.WrongPreimage.selector, i.id));
        cs1.claim(i.id, keccak256("guess"));
    }

    function test_theTimeoutSplitsClaimingFromRefunding() public {
        SettlementEngine.Instruction memory i = _ledger1Part(2_500);
        ConditionalSettlement.Condition memory c = _hashlock(1 hours);
        vm.prank(bankA);
        cs1.lock(i, _none(), c);

        vm.expectRevert(abi.encodeWithSelector(ConditionalSettlement.NotTimedOut.selector, i.id, c.timeout));
        cs1.refund(i.id);

        vm.warp(c.timeout);
        vm.expectRevert(abi.encodeWithSelector(ConditionalSettlement.TimedOut.selector, i.id, c.timeout));
        cs1.claim(i.id, SECRET);

        cs1.refund(i.id);
        assertEq(dcadA.getFrozenTokens(alice), 0, "released");
        assertEq(wcad.getFrozenTokens(bankA), 0);
        assertEq(dcadA.balanceOf(alice), 50_000, "nothing moved");
        assertEq(uint8(_state(cs1, i.id)), uint8(ConditionalSettlement.State.Released));
    }

    // ---------------------------------------------------------------- notary

    function test_onlyTheNotaryCommits() public {
        SettlementEngine.Instruction memory i = _ledger1Part(2_500);
        vm.prank(bankA);
        cs1.lock(i, _none(), _notarized(1 hours));
        vm.prank(bankA);
        vm.expectRevert(abi.encodeWithSelector(ConditionalSettlement.NotTheNotary.selector, i.id, bankA));
        cs1.commit(i.id);
        vm.prank(notary);
        cs1.commit(i.id);
        assertEq(wcad.balanceOf(bankB), 2_500);
    }

    function test_theNotaryAbortsAndNothingMoves() public {
        SettlementEngine.Instruction memory i = _ledger1Part(2_500);
        vm.prank(bankA);
        cs1.lock(i, _none(), _notarized(1 hours));
        vm.prank(notary);
        cs1.abort(i.id);
        assertEq(dcadA.getFrozenTokens(alice), 0);
        assertEq(dcadA.balanceOf(alice), 50_000);
        vm.prank(notary);
        vm.expectRevert(abi.encodeWithSelector(ConditionalSettlement.NotLocked.selector, i.id));
        cs1.commit(i.id);
    }

    function test_aNotaryCannotCommitPastTheTimeout() public {
        SettlementEngine.Instruction memory i = _ledger1Part(2_500);
        ConditionalSettlement.Condition memory c = _notarized(1 hours);
        vm.prank(bankA);
        cs1.lock(i, _none(), c);
        vm.warp(c.timeout);
        vm.prank(notary);
        vm.expectRevert(abi.encodeWithSelector(ConditionalSettlement.TimedOut.selector, i.id, c.timeout));
        cs1.commit(i.id);
    }

    // ---------------------------------------------------------------- across two ledgers

    /// @dev Ledger 1 moved value (payer burned, wholesale to Bank B) and ledger 2 created value (payee
    /// minted), or neither did. Anything else is the two ledgers disagreeing.
    function _ledgersAgree() internal view returns (bool) {
        bool paid = wcad.balanceOf(bankB) > 0;
        bool credited = dcadB2.balanceOf(carol) > 0;
        return paid == credited;
    }

    function test_unified_oneTransactionLeavesNoWindow() public {
        // The baseline: all three legs on one ledger settle in one transaction (SPEC.md §5.3).
        SettlementEngine.Instruction memory i = _interbank(alice, carol, 2_500);
        _submit(bankA, i, _one(_sign(bankB, bankBKey, i)));
        assertEq(wcad.balanceOf(bankB), 2_500);
        assertEq(dcadB.balanceOf(carol), 2_500);
    }

    function test_htlc_endsConsistentlyWhenBothSidesAct() public {
        SettlementEngine.Instruction memory l1 = _ledger1Part(2_500);
        SettlementEngine.Instruction memory l2 = _ledger2Part(l1.id, 2_500);
        // Bank A, which knows the secret, locks first with the longer timeout; Bank B locks the mint with a
        // shorter one, so it has time to claim after the secret is out.
        vm.prank(bankA);
        cs1.lock(l1, _none(), _hashlock(2 hours));
        vm.prank(bankB);
        cs2.lock(l2, _none(), _hashlock(1 hours));

        vm.prank(bankA);
        cs2.claim(l1.id, SECRET); // the payee is credited, and the secret is public on ledger 2
        assertFalse(_ledgersAgree(), "the window opens: ledger 2 settled, ledger 1 still locked");
        vm.prank(bankB);
        cs1.claim(l1.id, SECRET); // Bank B uses the published secret to collect
        assertTrue(_ledgersAgree(), "and closes once Bank B claims");
        assertEq(dcadB2.balanceOf(carol), 2_500);
        assertEq(wcad.balanceOf(bankB), 2_500);
    }

    function test_htlc_aParticipantOfflinePastItsTimeoutLeavesTheLedgersDisagreeing() public {
        SettlementEngine.Instruction memory l1 = _ledger1Part(2_500);
        SettlementEngine.Instruction memory l2 = _ledger2Part(l1.id, 2_500);
        ConditionalSettlement.Condition memory c1 = _hashlock(2 hours);
        vm.prank(bankA);
        cs1.lock(l1, _none(), c1);
        vm.prank(bankB);
        cs2.lock(l2, _none(), _hashlock(1 hours));
        vm.prank(bankA);
        cs2.claim(l1.id, SECRET);

        // Bank B is offline past ledger 1's timeout; Bank A takes its locked funds back.
        vm.warp(c1.timeout);
        cs1.refund(l1.id);

        assertEq(dcadB2.balanceOf(carol), 2_500, "Bank B created a deposit for the payee");
        assertEq(wcad.balanceOf(bankB), 0, "and was never paid for it");
        assertEq(dcadA.balanceOf(alice), 50_000, "while the payer kept the money");
        assertFalse(_ledgersAgree());
    }

    function test_htlc_aLateClaimLosesTheRaceToTheTimeout() public {
        SettlementEngine.Instruction memory l1 = _ledger1Part(2_500);
        SettlementEngine.Instruction memory l2 = _ledger2Part(l1.id, 2_500);
        ConditionalSettlement.Condition memory c1 = _hashlock(2 hours);
        vm.prank(bankA);
        cs1.lock(l1, _none(), c1);
        vm.prank(bankB);
        cs2.lock(l2, _none(), _hashlock(1 hours));
        vm.prank(bankA);
        cs2.claim(l1.id, SECRET);

        // Bank B's claim lands in the first block at or after the timeout: too late, by one second or more.
        vm.warp(c1.timeout);
        vm.prank(bankB);
        vm.expectRevert(abi.encodeWithSelector(ConditionalSettlement.TimedOut.selector, l1.id, c1.timeout));
        cs1.claim(l1.id, SECRET);
        assertFalse(_ledgersAgree());
    }

    function test_htlc_ifTheSecretNeverComesOutBothSidesRefund() public {
        SettlementEngine.Instruction memory l1 = _ledger1Part(2_500);
        SettlementEngine.Instruction memory l2 = _ledger2Part(l1.id, 2_500);
        ConditionalSettlement.Condition memory c1 = _hashlock(2 hours);
        ConditionalSettlement.Condition memory c2 = _hashlock(1 hours);
        vm.prank(bankA);
        cs1.lock(l1, _none(), c1);
        vm.prank(bankB);
        cs2.lock(l2, _none(), c2);
        vm.warp(c2.timeout);
        cs2.refund(l1.id);
        vm.warp(c1.timeout);
        cs1.refund(l1.id);
        assertTrue(_ledgersAgree(), "nothing happened on either ledger");
        assertEq(wcad.balanceOf(bankB), 0);
    }

    function test_notary_commitsBothWhenItSurvives() public {
        SettlementEngine.Instruction memory l1 = _ledger1Part(2_500);
        SettlementEngine.Instruction memory l2 = _ledger2Part(l1.id, 2_500);
        vm.prank(bankA);
        cs1.lock(l1, _none(), _notarized(1 hours));
        vm.prank(bankB);
        cs2.lock(l2, _none(), _notarized(1 hours));
        vm.startPrank(notary);
        cs1.commit(l1.id);
        assertFalse(_ledgersAgree(), "between the two commits the ledgers disagree");
        cs2.commit(l1.id);
        vm.stopPrank();
        assertTrue(_ledgersAgree());
    }

    function test_notary_aCrashBetweenCommitsLeavesTheLedgersDisagreeing() public {
        SettlementEngine.Instruction memory l1 = _ledger1Part(2_500);
        SettlementEngine.Instruction memory l2 = _ledger2Part(l1.id, 2_500);
        ConditionalSettlement.Condition memory c2 = _notarized(1 hours);
        vm.prank(bankA);
        cs1.lock(l1, _none(), _notarized(1 hours));
        vm.prank(bankB);
        cs2.lock(l2, _none(), c2);
        vm.prank(notary);
        cs1.commit(l1.id);

        // The notary crashes before committing ledger 2 and is not back before its timeout.
        vm.warp(c2.timeout);
        cs2.refund(l1.id);

        assertEq(wcad.balanceOf(bankB), 2_500, "Bank B was paid");
        assertEq(dcadA.balanceOf(alice), 47_500, "the payer's deposit is gone");
        assertEq(dcadB2.balanceOf(carol), 0, "and the payee was never credited");
        assertFalse(_ledgersAgree());
    }

    function test_notary_abortsBothWhenOneSideCannotLock() public {
        SettlementEngine.Instruction memory l1 = _ledger1Part(2_500);
        SettlementEngine.Instruction memory l2 = _ledger2Part(l1.id, 2_500);
        vm.prank(bankA);
        cs1.lock(l1, _none(), _notarized(1 hours));
        // Bank B has blocked the payee meanwhile; its lock still records the mint, but cannot settle it.
        vm.prank(bankB);
        dcadB2.blockHolder(carol);
        vm.prank(bankB);
        cs2.lock(l2, _none(), _notarized(1 hours));
        vm.prank(notary);
        vm.expectRevert();
        cs2.commit(l1.id);
        // So the notary aborts both, before committing either.
        vm.startPrank(notary);
        cs2.abort(l1.id);
        cs1.abort(l1.id);
        vm.stopPrank();
        assertTrue(_ledgersAgree());
        assertEq(dcadA.balanceOf(alice), 50_000);
    }
}
