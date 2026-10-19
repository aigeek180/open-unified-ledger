// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.30;

import {ParticipantRegistry} from "../ParticipantRegistry.sol";
import {SettlementEngine} from "../SettlementEngine.sol";

/// @title NoOnceEngine
/// @notice A deliberately broken settlement engine, for the conformance kit only (SPEC.md §14): it has no
/// once-only check on the instruction id, so an instruction sent again after it settled settles again. The
/// kit must fail it on exactly once (invariant 6). Never deploy it for anything else.
contract NoOnceEngine is SettlementEngine {
    constructor(ParticipantRegistry registry_) SettlementEngine(registry_) {}

    /// @dev The break: any id settles, however often it has before.
    // forge-lint: disable-next-line(empty-block)
    function _requireUnsettled(bytes32) internal view override {}
}
