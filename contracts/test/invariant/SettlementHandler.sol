// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {DepositToken} from "../../src/DepositToken.sol";
import {ParticipantRegistry} from "../../src/ParticipantRegistry.sol";
import {SettlementEngine} from "../../src/SettlementEngine.sol";
import {SettlementToken} from "../../src/SettlementToken.sol";
import {WholesaleToken} from "../../src/WholesaleToken.sol";

/// @notice Drives the network with random flows, retries, freezes, forced transfers, allowlist changes and
/// suspensions, and keeps a ghost copy of every balance.
/// @dev Before each instruction the handler simulates its legs against the ghost balances using the tokens'
/// own eligibility and frozen-balance views, without predicting whether the call will succeed. Then:
///   - if the call succeeded, the ghost takes the simulated balances, and any rule the simulation saw broken
///     (an ineligible receiver, a frozen balance moved) is recorded as a violation;
///   - if it failed, every real balance must equal its value before the call.
/// The invariants then compare the real balances with the ghost.
contract SettlementHandler is CommonBase, StdUtils {
    struct Bank {
        address account;
        uint256 key;
        bytes32 id;
        DepositToken token;
        address[] customers;
    }

    ParticipantRegistry public immutable registry;
    SettlementEngine public immutable engine;
    WholesaleToken public immutable wcad;
    address public immutable cb;

    Bank[2] internal banks;

    // Every (token, holder) pair any action can touch.
    address[] public pairToken;
    address[] public pairHolder;
    mapping(address token => mapping(address holder => uint256)) public ghost;

    bytes32[] public settledIds;
    mapping(bytes32 id => uint256) public successes;
    bytes[] internal replayCalls;
    address[] internal replaySubmitters;

    bool public atomicityViolated;
    bool public eligibilityViolated;
    bool public frozenViolated;
    bool public authorityViolated;

    uint256 public calls;
    uint256 public reverted;
    uint256 public settledInterbank;
    uint256 private _nonce;

    constructor(
        ParticipantRegistry registry_,
        SettlementEngine engine_,
        WholesaleToken wcad_,
        address cb_,
        Bank[2] memory banks_,
        address outsider
    ) {
        registry = registry_;
        engine = engine_;
        wcad = wcad_;
        cb = cb_;
        for (uint256 b; b < 2; ++b) {
            banks[b].account = banks_[b].account;
            banks[b].key = banks_[b].key;
            banks[b].id = banks_[b].id;
            banks[b].token = banks_[b].token;
            for (uint256 c; c < banks_[b].customers.length; ++c) {
                banks[b].customers.push(banks_[b].customers[c]);
            }
            // The outsider is a possible holder of every deposit token, so a wrongful credit would show.
            banks[b].customers.push(outsider);
            _track(address(wcad), banks[b].account);
            for (uint256 c; c < banks[b].customers.length; ++c) {
                _track(address(banks[b].token), banks[b].customers[c]);
            }
        }
        // Opening balances, settled through the engine like everything else, so interbank flows have
        // something to move from the first call.
        for (uint256 b; b < 2; ++b) {
            Bank storage bank = banks[b];
            _execute(
                cb,
                _single(_leg(SettlementEngine.LegKind.Mint, wcad, address(0), bank.account, 1e12)),
                _none()
            );
            for (uint256 c; c + 1 < bank.customers.length; ++c) {
                _execute(
                    bank.account,
                    _single(
                        _leg(SettlementEngine.LegKind.Mint, bank.token, address(0), bank.customers[c], 1e10)
                    ),
                    _none()
                );
            }
        }
    }

    // ================================================================ actions

    function fund(uint8 bankSeed, uint256 amount) external {
        Bank storage bank = banks[bankSeed % 2];
        amount = bound(amount, 1, 1e15);
        _execute(
            cb, _single(_leg(SettlementEngine.LegKind.Mint, wcad, address(0), bank.account, amount)), _none()
        );
    }

    function redeem(uint8 bankSeed, uint256 amount) external {
        Bank storage bank = banks[bankSeed % 2];
        amount = _spend(amount, wcad.available(bank.account));
        _execute(
            bank.account,
            _single(_leg(SettlementEngine.LegKind.Burn, wcad, bank.account, address(0), amount)),
            _none()
        );
    }

    function tokenize(uint8 bankSeed, uint8 customerSeed, uint256 amount) external {
        Bank storage bank = banks[bankSeed % 2];
        address customer = _customer(bank, customerSeed);
        amount = bound(amount, 1, 1e15);
        _execute(
            bank.account,
            _single(_leg(SettlementEngine.LegKind.Mint, bank.token, address(0), customer, amount)),
            _none()
        );
    }

    function detokenize(uint8 bankSeed, uint8 customerSeed, uint256 amount) external {
        Bank storage bank = banks[bankSeed % 2];
        address customer = _customer(bank, customerSeed);
        amount = _spend(amount, bank.token.available(customer));
        _execute(
            bank.account,
            _single(_leg(SettlementEngine.LegKind.Burn, bank.token, customer, address(0), amount)),
            _none()
        );
    }

    /// @notice The three-leg interbank transfer. Without the payee bank's approval it must fail.
    function interbank(uint8 direction, uint8 payerSeed, uint8 payeeSeed, uint256 amount, bool cosign)
        external
    {
        Bank storage from = banks[direction % 2];
        Bank storage to = banks[(uint256(direction) + 1) % 2];
        address payer = _customer(from, payerSeed);
        address payee = _customer(to, payeeSeed);
        amount = _spend(amount, _min(from.token.available(payer), wcad.available(from.account)));

        SettlementEngine.Instruction memory i = _new(3);
        i.legs[0] = _leg(SettlementEngine.LegKind.Burn, from.token, payer, address(0), amount);
        i.legs[1] = _leg(SettlementEngine.LegKind.Transfer, wcad, from.account, to.account, amount);
        i.legs[2] = _leg(SettlementEngine.LegKind.Mint, to.token, address(0), payee, amount);

        SettlementEngine.Approval[] memory approvals = cosign ? _approval(to, i) : _none();
        bool ok = _execute(from.account, i, approvals);
        if (ok && !cosign) authorityViolated = true;
        if (ok) settledInterbank++;
    }

    /// @notice A bank trying to take another bank's customer's deposit or another bank's wholesale.
    function trespass(uint8 bankSeed, uint8 victimSeed, uint256 amount, bool wholesale) external {
        Bank storage thief = banks[bankSeed % 2];
        Bank storage victim = banks[(uint256(bankSeed) + 1) % 2];
        amount = bound(amount, 1, 1e15);
        SettlementEngine.Instruction memory i = wholesale
            ? _single(_leg(SettlementEngine.LegKind.Transfer, wcad, victim.account, thief.account, amount))
            : _single(
                _leg(
                    SettlementEngine.LegKind.Burn,
                    victim.token,
                    _customer(victim, victimSeed),
                    address(0),
                    amount
                )
            );
        if (_execute(thief.account, i, _none())) authorityViolated = true;
    }

    /// @notice Resubmit an instruction that already settled, exactly as it was.
    function replay(uint256 index) external {
        if (replayCalls.length == 0) return;
        index = bound(index, 0, replayCalls.length - 1);
        calls++;
        vm.prank(replaySubmitters[index]);
        (bool ok,) = address(engine).call(replayCalls[index]);
        if (ok) {
            (SettlementEngine.Instruction memory i,) = abi.decode(
                _args(replayCalls[index]), (SettlementEngine.Instruction, SettlementEngine.Approval[])
            );
            successes[i.id]++;
        } else {
            reverted++;
        }
    }

    /// @notice Freezes up to the whole balance (sometimes more, which ERC-7943 allows), or lifts the freeze.
    function freeze(uint8 bankSeed, uint8 customerSeed, uint256 amount) external {
        Bank storage bank = banks[bankSeed % 2];
        address customer = _customer(bank, customerSeed);
        uint256 balance = bank.token.balanceOf(customer);
        if (amount % 2 == 0) amount = 0;
        else if (amount % 7 == 1) amount = balance + 1;
        else amount = bound(amount, 0, balance / 2);
        vm.prank(bank.account);
        bank.token.setFrozenTokens(customer, amount);
    }

    /// @notice An issuer's forced transfer: may move frozen balance, still needs an eligible receiver.
    function forced(uint8 bankSeed, uint8 fromSeed, uint8 toSeed, uint256 amount) external {
        Bank storage bank = banks[bankSeed % 2];
        address from = _customer(bank, fromSeed);
        address to = _customer(bank, toSeed);
        amount = _spend(amount, bank.token.balanceOf(from));
        DepositToken token = bank.token;
        bool receivable = token.canReceive(to);
        bool covered = ghost[address(token)][from] >= amount;
        uint256[] memory before = _snapshot();

        calls++;
        vm.prank(bank.account);
        (bool ok,) = address(token).call(abi.encodeCall(token.forcedTransfer, (from, to, amount)));
        if (ok) {
            if (!receivable) eligibilityViolated = true;
            if (!covered) atomicityViolated = true;
            ghost[address(token)][from] -= amount;
            ghost[address(token)][to] += amount;
        } else {
            reverted++;
            _expectUnchanged(before);
        }
    }

    /// @notice Mostly allowlists; blocks or resets about one time in seven, so flows still mostly succeed.
    function toggleAllow(uint8 bankSeed, uint8 customerSeed, uint8 mode) external {
        Bank storage bank = banks[bankSeed % 2];
        address customer = _customer(bank, customerSeed);
        vm.startPrank(bank.account);
        // Residues the fuzzer does not favour (it leans on 0 and on type maxima).
        if (mode % 13 == 5) bank.token.blockHolder(customer);
        else if (mode % 13 == 6) bank.token.resetHolder(customer);
        else bank.token.allowHolder(customer);
        vm.stopPrank();
    }

    /// @notice Suspends a bank about one time in thirteen and otherwise reinstates it.
    function toggleSuspend(uint8 bankSeed, uint8 mode) external {
        Bank storage bank = banks[bankSeed % 2];
        vm.startPrank(cb);
        if (mode % 13 == 5) registry.suspend(bank.id);
        else registry.reinstate(bank.id);
        vm.stopPrank();
    }

    function warp(uint256 seconds_) external {
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1, 2 hours));
        vm.roll(vm.getBlockNumber() + 1);
    }

    // ================================================================ reads for the invariants

    function pairCount() external view returns (uint256) {
        return pairToken.length;
    }

    function settledCount() external view returns (uint256) {
        return settledIds.length;
    }

    // ================================================================ execution and simulation

    /// @return ok Whether the engine accepted the instruction.
    function _execute(
        address submitter,
        SettlementEngine.Instruction memory i,
        SettlementEngine.Approval[] memory approvals
    ) internal returns (bool ok) {
        (uint256[] memory simulated, bool eligible, bool unfrozen, bool covered) = _simulate(i);
        uint256[] memory before = _snapshot();
        bytes memory data = abi.encodeCall(SettlementEngine.settle, (i, approvals));

        calls++;
        vm.prank(submitter);
        (ok,) = address(engine).call(data);

        if (ok) {
            if (!eligible) eligibilityViolated = true;
            if (!unfrozen) frozenViolated = true;
            if (!covered) atomicityViolated = true;
            for (uint256 p; p < pairToken.length; ++p) {
                ghost[pairToken[p]][pairHolder[p]] = simulated[p];
            }
            successes[i.id]++;
            settledIds.push(i.id);
            replayCalls.push(data);
            replaySubmitters.push(submitter);
        } else {
            reverted++;
            _expectUnchanged(before);
        }
    }

    /// @dev Apply the legs in order to a copy of the ghost, checking the token rules as they stand now.
    function _simulate(SettlementEngine.Instruction memory i)
        internal
        view
        returns (uint256[] memory balances, bool eligible, bool unfrozen, bool covered)
    {
        balances = new uint256[](pairToken.length);
        for (uint256 p; p < pairToken.length; ++p) {
            balances[p] = ghost[pairToken[p]][pairHolder[p]];
        }
        eligible = true;
        unfrozen = true;
        covered = true;
        for (uint256 l; l < i.legs.length; ++l) {
            SettlementEngine.Leg memory leg = i.legs[l];
            SettlementToken token = SettlementToken(leg.token);
            if (leg.from != address(0)) {
                uint256 p = _pair(leg.token, leg.from);
                if (!token.canSend(leg.from)) eligible = false;
                if (balances[p] < leg.amount) {
                    covered = false;
                } else {
                    // A non-forced debit may only spend what is not frozen.
                    uint256 frozenAmount = token.getFrozenTokens(leg.from);
                    uint256 spendable = balances[p] > frozenAmount ? balances[p] - frozenAmount : 0;
                    if (leg.amount > spendable) unfrozen = false;
                    balances[p] -= leg.amount;
                }
            }
            if (leg.to != address(0)) {
                if (!token.canReceive(leg.to)) eligible = false;
                balances[_pair(leg.token, leg.to)] += leg.amount;
            }
        }
    }

    function _snapshot() internal view returns (uint256[] memory values) {
        values = new uint256[](pairToken.length);
        for (uint256 p; p < pairToken.length; ++p) {
            values[p] = SettlementToken(pairToken[p]).balanceOf(pairHolder[p]);
        }
    }

    function _expectUnchanged(uint256[] memory before) internal {
        for (uint256 p; p < pairToken.length; ++p) {
            if (SettlementToken(pairToken[p]).balanceOf(pairHolder[p]) != before[p]) {
                atomicityViolated = true;
            }
        }
    }

    // ================================================================ helpers

    /// @dev One of the bank's customers; the outsider (last in the list) about one time in sixteen.
    function _customer(Bank storage bank, uint256 seed) internal view returns (address) {
        uint256 regular = bank.customers.length - 1;
        return seed % 16 == 11 ? bank.customers[regular] : bank.customers[seed % regular];
    }

    /// @dev Usually an amount the holder can cover; one time in sixteen, a little more than it can.
    function _spend(uint256 seed, uint256 balance) internal pure returns (uint256) {
        if (seed % 16 == 0 || balance == 0) return balance + 1 + (seed % 10);
        return bound(seed, 1, balance);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _track(address token, address holder) internal {
        pairToken.push(token);
        pairHolder.push(holder);
    }

    function _pair(address token, address holder) internal view returns (uint256) {
        for (uint256 p; p < pairToken.length; ++p) {
            if (pairToken[p] == token && pairHolder[p] == holder) return p;
        }
        revert("untracked pair");
    }

    function _leg(
        SettlementEngine.LegKind kind,
        SettlementToken token,
        address from,
        address to,
        uint256 amount
    ) internal pure returns (SettlementEngine.Leg memory) {
        return SettlementEngine.Leg(kind, address(token), from, to, amount);
    }

    function _new(uint256 legs) internal returns (SettlementEngine.Instruction memory i) {
        i.id = keccak256(abi.encode("handler", ++_nonce));
        i.deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        i.legs = new SettlementEngine.Leg[](legs);
    }

    function _single(SettlementEngine.Leg memory leg)
        internal
        returns (SettlementEngine.Instruction memory i)
    {
        i = _new(1);
        i.legs[0] = leg;
    }

    function _none() internal pure returns (SettlementEngine.Approval[] memory) {
        return new SettlementEngine.Approval[](0);
    }

    function _approval(Bank storage bank, SettlementEngine.Instruction memory i)
        internal
        view
        returns (SettlementEngine.Approval[] memory list)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(bank.key, engine.digest(i));
        list = new SettlementEngine.Approval[](1);
        list[0] = SettlementEngine.Approval(bank.account, abi.encodePacked(r, s, v));
    }

    /// @dev Calldata without its 4-byte selector.
    function _args(bytes memory data) internal pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 b; b < args.length; ++b) {
            args[b] = data[b + 4];
        }
    }
}
