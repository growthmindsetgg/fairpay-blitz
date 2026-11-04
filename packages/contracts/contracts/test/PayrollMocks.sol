// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Token with a transfer hook (like ERC-777 / ERC-1363 callbacks): once armed, the next
///      transfer calls `hookTarget` with `hookData` and bubbles up its revert. Used to prove FairPayroll
///      cannot be re-entered from inside a token transfer. Tests only.
contract HookToken is ERC20 {
    address public hookTarget;
    bytes public hookData;
    bool public armed;

    constructor() ERC20("Hook", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_) external {
        hookTarget = target_;
        hookData = data_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0)) {
            armed = false;
            (bool ok, bytes memory ret) = hookTarget.call(hookData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
