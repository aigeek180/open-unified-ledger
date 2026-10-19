// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {DepositToken} from "../src/DepositToken.sol";
import {SettlementEngine} from "../src/SettlementEngine.sol";
import {LaxMintEngine} from "../src/broken/LaxMintEngine.sol";
import {NoOnceEngine} from "../src/broken/NoOnceEngine.sol";
import {OpenDepositToken} from "../src/broken/OpenDepositToken.sol";
import {SplitLegsEngine} from "../src/broken/SplitLegsEngine.sol";
import {ERC20Restricted} from "../src/vendor/oz-community/token/ERC20Restricted.sol";
import {Fixture} from "./Fixture.sol";

/// @notice The conformance kit's broken contracts (SPEC.md §14) break exactly the rule each is named for, and
/// nothing else: what the real contracts refuse in SettlementEngine.t.sol, each of these lets through.

contract NoOnceEngineTest is Fixture {
    function _deployEngine() internal override returns (SettlementEngine) {
        return new NoOnceEngine(registry);
    }

    function test_settlesTheSameInstructionTwice() public {
        _fund(bankA, 1000);
        _tokenize(dcadA, bankA, alice, 1000);
        SettlementEngine.Instruction memory i = _interbank(alice, carol, 300);
        SettlementEngine.Approval[] memory approval = _one(_sign(bankB, bankBKey, i));
        _submit(bankA, i, approval);
        _submit(bankA, i, approval);
        assertEq(dcadA.balanceOf(alice), 400);
        assertEq(dcadB.balanceOf(carol), 600);
        assertEq(wcad.balanceOf(bankB), 600);
    }

    function test_stillNeedsEveryApproval() public {
        _fund(bankA, 1000);
        _tokenize(dcadA, bankA, alice, 1000);
        SettlementEngine.Instruction memory i = _interbank(alice, carol, 300);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 2, BANK_B));
        _submit(bankA, i, _none());
    }
}

contract LaxMintEngineTest is Fixture {
    function _deployEngine() internal override returns (SettlementEngine) {
        return new LaxMintEngine(registry);
    }

    function test_mintsTheBanksLiabilityWithoutItsApproval() public {
        _fund(bankA, 1000);
        _tokenize(dcadA, bankA, alice, 1000);
        _submit(bankA, _interbank(alice, carol, 300), _none());
        assertEq(dcadB.balanceOf(carol), 300);
        assertEq(wcad.balanceOf(bankB), 300);
    }

    function test_stillNeedsTheHolderToMoveItsAccount() public {
        _fund(bankA, 1000);
        SettlementEngine.Instruction memory i = _instruction(_move(wcad, bankA, bankB, 100));
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 0, BANK_A));
        _submit(bankB, i, _none());
    }
}

contract SplitLegsEngineTest is Fixture {
    function _deployEngine() internal override returns (SettlementEngine) {
        return new SplitLegsEngine(registry);
    }

    function _leg(SettlementEngine.Instruction memory i, SettlementEngine.Approval[] memory a, uint256 index)
        internal
    {
        vm.prank(bankA);
        SplitLegsEngine(address(engine)).settleLeg(i, a, index);
    }

    function test_leavesAnInstructionPartlySettledWhenALaterLegFails() public {
        _fund(bankA, 1000);
        _tokenize(dcadA, bankA, alice, 1000);
        // The payee is on no allowlist: the mint fails, but the burn and the wholesale leg have settled.
        SettlementEngine.Instruction memory i = _instruction(
            _burn(dcadA, alice, 300), _move(wcad, bankA, bankB, 300), _mint(dcadB, mallory, 300)
        );
        SettlementEngine.Approval[] memory a = _one(_sign(bankB, bankBKey, i));
        _leg(i, a, 0);
        _leg(i, a, 1);
        vm.expectRevert(abi.encodeWithSelector(ERC20Restricted.ERC20UserRestricted.selector, mallory));
        _leg(i, a, 2);
        assertEq(dcadA.balanceOf(alice), 700);
        assertEq(wcad.balanceOf(bankB), 300);
        assertEq(dcadB.balanceOf(mallory), 0);
    }

    function test_settlesEachLegOnceAndStillChecksAuthority() public {
        _fund(bankA, 1000);
        _tokenize(dcadA, bankA, alice, 1000);
        SettlementEngine.Instruction memory i = _interbank(alice, carol, 300);
        SettlementEngine.Approval[] memory a = _one(_sign(bankB, bankBKey, i));
        _leg(i, a, 0);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.AlreadySettled.selector, i.id, block.number));
        _leg(i, a, 0);
        vm.expectRevert(abi.encodeWithSelector(SettlementEngine.MissingApproval.selector, 2, BANK_B));
        _leg(i, _none(), 2);
    }
}

contract OpenDepositTokenTest is Fixture {
    function _deployDeposit(string memory name, string memory symbol, bytes32 issuer)
        internal
        override
        returns (DepositToken)
    {
        return new OpenDepositToken(name, symbol, CAD_DECIMALS, registry, issuer);
    }

    function test_mintsToAnAddressTheBankNeverAllowed() public {
        _fund(bankA, 1000);
        _tokenize(dcadA, bankA, alice, 1000);
        SettlementEngine.Instruction memory i = _instruction(
            _burn(dcadA, alice, 300), _move(wcad, bankA, bankB, 300), _mint(dcadB, mallory, 300)
        );
        _submit(bankA, i, _one(_sign(bankB, bankBKey, i)));
        assertEq(dcadB.balanceOf(mallory), 300);
        // The bank's own allowlist still does not admit mallory.
        assertTrue(dcadB.getRestriction(mallory) != ERC20Restricted.Restriction.ALLOWED);
    }

    function test_stillRefusesABlockedHolder() public {
        vm.prank(bankB);
        dcadB.blockHolder(mallory);
        SettlementEngine.Instruction memory i = _instruction(_mint(dcadB, mallory, 300));
        vm.expectRevert(abi.encodeWithSelector(ERC20Restricted.ERC20UserRestricted.selector, mallory));
        _submit(bankB, i, _none());
    }
}
