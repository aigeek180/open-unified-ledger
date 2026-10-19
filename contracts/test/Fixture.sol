// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {DepositToken} from "../src/DepositToken.sol";
import {ParticipantRegistry} from "../src/ParticipantRegistry.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {SettlementToken} from "../src/SettlementToken.sol";
import {WholesaleToken} from "../src/WholesaleToken.sol";

/// @notice The ca-interbank network in miniature: a central bank, two banks with reserve accounts in wholesale
/// CAD, one deposit token per bank, the settlement engine, and two allowlisted customers per bank plus one
/// outsider.
abstract contract Fixture is Test {
    bytes32 internal constant CB = keccak256("central-bank");
    bytes32 internal constant BANK_A = keccak256("bank-a");
    bytes32 internal constant BANK_B = keccak256("bank-b");
    uint8 internal constant CAD_DECIMALS = 2;

    address internal cb;
    uint256 internal cbKey;
    address internal bankA;
    uint256 internal bankAKey;
    address internal bankB;
    uint256 internal bankBKey;

    address internal alice = makeAddr("alice"); // Bank A customer
    address internal bob = makeAddr("bob"); // Bank A customer
    address internal carol = makeAddr("carol"); // Bank B customer
    address internal dave = makeAddr("dave"); // Bank B customer
    address internal mallory = makeAddr("mallory"); // allowlisted nowhere

    ParticipantRegistry internal registry;
    WholesaleToken internal wcad;
    DepositToken internal dcadA;
    DepositToken internal dcadB;
    SettlementEngine internal engine;

    uint256 private _nonce;

    function setUp() public virtual {
        (cb, cbKey) = makeAddrAndKey("central-bank");
        (bankA, bankAKey) = makeAddrAndKey("bank-a");
        (bankB, bankBKey) = makeAddrAndKey("bank-b");

        vm.startPrank(cb);
        registry = new ParticipantRegistry(CB, cb);
        registry.admitBank(BANK_A, bankA);
        registry.admitBank(BANK_B, bankB);
        wcad = new WholesaleToken("Wholesale CAD", "wCAD", CAD_DECIMALS, registry, CB);
        wcad.openReserveAccount(BANK_A);
        wcad.openReserveAccount(BANK_B);
        engine = _deployEngine();
        wcad.grantRole(wcad.SETTLEMENT_ROLE(), address(engine));
        vm.stopPrank();

        vm.startPrank(bankA);
        dcadA = new DepositToken("Bank A deposit CAD", "dCAD-A", CAD_DECIMALS, registry, BANK_A);
        dcadA.grantRole(dcadA.SETTLEMENT_ROLE(), address(engine));
        dcadA.allowHolder(alice);
        dcadA.allowHolder(bob);
        vm.stopPrank();

        vm.startPrank(bankB);
        dcadB = _deployDeposit("Bank B deposit CAD", "dCAD-B", BANK_B);
        dcadB.grantRole(dcadB.SETTLEMENT_ROLE(), address(engine));
        dcadB.allowHolder(carol);
        dcadB.allowHolder(dave);
        vm.stopPrank();

        vm.startPrank(cb);
        registry.listToken(address(wcad));
        registry.listToken(address(dcadA));
        registry.listToken(address(dcadB));
        vm.stopPrank();
    }

    /// @dev The engine under test, deployed by the central bank; a broken engine's test deploys its own.
    function _deployEngine() internal virtual returns (SettlementEngine) {
        return new SettlementEngine(registry);
    }

    /// @dev Bank B's deposit token, deployed by Bank B; a broken token's test deploys its own.
    function _deployDeposit(string memory name, string memory symbol, bytes32 issuer)
        internal
        virtual
        returns (DepositToken)
    {
        return new DepositToken(name, symbol, CAD_DECIMALS, registry, issuer);
    }

    // ---------------------------------------------------------------- instruction builders

    function _id() internal returns (bytes32) {
        return keccak256(abi.encode("instruction", ++_nonce));
    }

    function _mint(SettlementToken token, address to, uint256 amount)
        internal
        pure
        returns (SettlementEngine.Leg memory)
    {
        return SettlementEngine.Leg(SettlementEngine.LegKind.Mint, address(token), address(0), to, amount);
    }

    function _burn(SettlementToken token, address from, uint256 amount)
        internal
        pure
        returns (SettlementEngine.Leg memory)
    {
        return SettlementEngine.Leg(SettlementEngine.LegKind.Burn, address(token), from, address(0), amount);
    }

    function _move(SettlementToken token, address from, address to, uint256 amount)
        internal
        pure
        returns (SettlementEngine.Leg memory)
    {
        return SettlementEngine.Leg(SettlementEngine.LegKind.Transfer, address(token), from, to, amount);
    }

    function _instruction(SettlementEngine.Leg memory a)
        internal
        returns (SettlementEngine.Instruction memory i)
    {
        i.id = _id();
        i.deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        i.legs = new SettlementEngine.Leg[](1);
        i.legs[0] = a;
    }

    function _instruction(
        SettlementEngine.Leg memory a,
        SettlementEngine.Leg memory b,
        SettlementEngine.Leg memory c
    ) internal returns (SettlementEngine.Instruction memory i) {
        i.id = _id();
        i.deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        i.legs = new SettlementEngine.Leg[](3);
        i.legs[0] = a;
        i.legs[1] = b;
        i.legs[2] = c;
    }

    function _instruction(SettlementEngine.Leg[] memory legs)
        internal
        returns (SettlementEngine.Instruction memory i)
    {
        i.id = _id();
        i.deadline = uint64(vm.getBlockTimestamp() + 1 hours);
        i.legs = legs;
    }

    /// @dev The Agorá pattern: burn the payer's deposit, move wholesale between banks, mint the payee's.
    function _interbank(address payer, address payee, uint256 amount)
        internal
        returns (SettlementEngine.Instruction memory)
    {
        return _instruction(
            _burn(dcadA, payer, amount), _move(wcad, bankA, bankB, amount), _mint(dcadB, payee, amount)
        );
    }

    // ---------------------------------------------------------------- approvals and submission

    function _sign(address signer, uint256 key, SettlementEngine.Instruction memory i)
        internal
        view
        returns (SettlementEngine.Approval memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, engine.digest(i));
        return SettlementEngine.Approval(signer, abi.encodePacked(r, s, v));
    }

    function _none() internal pure returns (SettlementEngine.Approval[] memory) {
        return new SettlementEngine.Approval[](0);
    }

    function _one(SettlementEngine.Approval memory a)
        internal
        pure
        returns (SettlementEngine.Approval[] memory list)
    {
        list = new SettlementEngine.Approval[](1);
        list[0] = a;
    }

    function _submit(
        address submitter,
        SettlementEngine.Instruction memory i,
        SettlementEngine.Approval[] memory a
    ) internal {
        vm.prank(submitter);
        engine.settle(i, a);
    }

    /// @dev Fund a bank with wholesale CAD and a customer with deposit tokens.
    function _fund(address bank, uint256 amount) internal {
        _submit(cb, _instruction(_mint(wcad, bank, amount)), _none());
    }

    function _tokenize(DepositToken token, address bank, address customer, uint256 amount) internal {
        _submit(bank, _instruction(_mint(token, customer, amount)), _none());
    }
}
