// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ICompliance, IModule} from "../interfaces/IERC3643.sol";

/// @notice What the module asks of the token: whether the movement under way is the settlement engine's.
interface ISettling {
    function settling() external view returns (bool);
}

/// @title SettlementOnlyModule
/// @notice The engine-only rule as a compliance module (SPEC.md §4.2): a movement of the bond is compliant only
/// while the settlement engine is settling it, so every movement carries an instruction id the participants'
/// books can match, and a holder's direct `transfer`, or an agent's `mint` or `burn` outside an instruction, is
/// refused as not compliant rather than disabled. It keeps no state, so any compliance may bind it.
contract SettlementOnlyModule is IModule {
    mapping(address compliance => bool) private _bound;

    error NotACompliance(address account);

    function bindCompliance(address compliance) external {
        if (msg.sender != compliance) revert NotACompliance(msg.sender);
        _bound[compliance] = true;
        emit ComplianceBound(compliance);
    }

    function unbindCompliance(address compliance) external {
        if (msg.sender != compliance) revert NotACompliance(msg.sender);
        _bound[compliance] = false;
        emit ComplianceUnbound(compliance);
    }

    /// @notice Compliant only inside a settlement: the token bound to `compliance` says so.
    function moduleCheck(address, address, uint256, address compliance) external view returns (bool) {
        address token = ICompliance(compliance).getTokenBound();
        return token != address(0) && ISettling(token).settling();
    }

    function moduleTransferAction(address, address, uint256) external view {
        if (!_bound[msg.sender]) revert NotACompliance(msg.sender);
    }

    function moduleMintAction(address, uint256) external view {
        if (!_bound[msg.sender]) revert NotACompliance(msg.sender);
    }

    function moduleBurnAction(address, uint256) external view {
        if (!_bound[msg.sender]) revert NotACompliance(msg.sender);
    }

    function isComplianceBound(address compliance) external view returns (bool) {
        return _bound[compliance];
    }

    function canComplianceBind(address) external pure returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure returns (bool) {
        return true;
    }

    function name() external pure returns (string memory) {
        return "SettlementOnlyModule";
    }
}
