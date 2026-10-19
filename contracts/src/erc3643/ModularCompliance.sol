// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {ICompliance, IModule} from "./interfaces/IERC3643.sol";
import {ParticipantRoles} from "./ParticipantRoles.sol";

/// @title ModularCompliance
/// @notice Decides every movement of the token it is bound to (ERC-3643): a movement is compliant only if every
/// module it holds agrees, and each module hears of every movement that happened. Its owner adds and removes
/// modules; the token reports its movements.
contract ModularCompliance is ICompliance, ParticipantRoles {
    uint256 public constant MAX_MODULES = 25;

    address private _token;
    address[] private _modules;

    event ModuleAdded(address indexed module);
    event ModuleRemoved(address indexed module);

    error OnlyTheToken(address account);
    error TokenAlreadyBound(address token);
    error ModuleAlreadyBound(address module);
    error NoSuchModule(address module);
    error CannotBind(address module);
    error TooManyModules();

    constructor(ParticipantRegistry registry_, address owner_) ParticipantRoles(registry_, owner_) {}

    modifier onlyToken() {
        if (msg.sender != _token || _token == address(0)) revert OnlyTheToken(msg.sender);
        _;
    }

    /// @notice Bind the token this compliance decides for: its owner, or the token binding itself while none is.
    function bindToken(address token) external {
        if (token == address(0)) revert OnlyTheToken(token);
        if (!isOwner(msg.sender) && !(_token == address(0) && msg.sender == token)) {
            revert NotTheOwner(msg.sender);
        }
        if (_token != address(0)) revert TokenAlreadyBound(_token);
        _token = token;
        emit TokenBound(token);
    }

    function unbindToken(address token) external onlyOwner {
        if (token != _token) revert OnlyTheToken(token);
        delete _token;
        emit TokenUnbound(token);
    }

    function isTokenBound(address token) external view returns (bool) {
        return token == _token && token != address(0);
    }

    function getTokenBound() external view returns (address) {
        return _token;
    }

    function addModule(address module) external onlyOwner {
        if (_modules.length >= MAX_MODULES) revert TooManyModules();
        if (isModuleBound(module)) revert ModuleAlreadyBound(module);
        if (!IModule(module).canComplianceBind(address(this))) revert CannotBind(module);
        _modules.push(module);
        emit ModuleAdded(module);
        IModule(module).bindCompliance(address(this));
    }

    function removeModule(address module) external onlyOwner {
        for (uint256 i; i < _modules.length; ++i) {
            if (_modules[i] == module) {
                _modules[i] = _modules[_modules.length - 1];
                _modules.pop();
                emit ModuleRemoved(module);
                IModule(module).unbindCompliance(address(this));
                return;
            }
        }
        revert NoSuchModule(module);
    }

    function getModules() external view returns (address[] memory) {
        return _modules;
    }

    function isModuleBound(address module) public view returns (bool) {
        for (uint256 i; i < _modules.length; ++i) {
            if (_modules[i] == module) return true;
        }
        return false;
    }

    /// @notice Every module must agree; with none, any movement the token's own checks allow is compliant.
    function canTransfer(address from, address to, uint256 amount) external view returns (bool) {
        for (uint256 i; i < _modules.length; ++i) {
            if (!IModule(_modules[i]).moduleCheck(from, to, amount, address(this))) return false;
        }
        return true;
    }

    function transferred(address from, address to, uint256 amount) external onlyToken {
        for (uint256 i; i < _modules.length; ++i) {
            IModule(_modules[i]).moduleTransferAction(from, to, amount);
        }
    }

    function created(address to, uint256 amount) external onlyToken {
        for (uint256 i; i < _modules.length; ++i) {
            IModule(_modules[i]).moduleMintAction(to, amount);
        }
    }

    function destroyed(address from, uint256 amount) external onlyToken {
        for (uint256 i; i < _modules.length; ++i) {
            IModule(_modules[i]).moduleBurnAction(from, amount);
        }
    }
}
