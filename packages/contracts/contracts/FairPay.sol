// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FairPay
/// @notice Non-custodial payment router. Every payment, public or private, ends here and
///         emits one PaymentReceived event carrying an opaque order reference. Off-chain
///         verification only needs this event.
/// @dev Holds no funds: tokens move straight from payer to recipient in a single call.
contract FairPay is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The only token this router moves (USDC in production).
    IERC20 public immutable token;

    /// @notice Chain the router was deployed on. Calls on any other chain (e.g. after a fork) revert.
    uint256 public immutable deployChainId;

    /// @param orderRef Opaque reference, e.g. keccak256(orderId, participantId, secret). Never a raw order id.
    /// @param recipient Merchant payout address.
    /// @param payer msg.sender. For private payments this is the FairPool contract, not the customer.
    event PaymentReceived(bytes32 indexed orderRef, address indexed recipient, address indexed payer, uint256 amount);

    error WrongChain();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroOrderRef();
    error InvalidRecipient();
    error AmountMismatch();

    constructor(IERC20 token_, address owner_) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        deployChainId = block.chainid;
    }

    /// @notice Pay `amount` of `token` from msg.sender to `recipient`, tagged with `orderRef`.
    /// @dev Requires a prior approval of at least `amount` to this contract.
    function directPay(address recipient, uint256 amount, bytes32 orderRef) external nonReentrant whenNotPaused {
        if (block.chainid != deployChainId) revert WrongChain();
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        if (orderRef == bytes32(0)) revert ZeroOrderRef();

        uint256 before = token.balanceOf(recipient);
        token.safeTransferFrom(msg.sender, recipient, amount);
        // Rejects fee-on-transfer or rebasing behaviour: the event must state exactly what arrived.
        if (token.balanceOf(recipient) - before != amount) revert AmountMismatch();

        emit PaymentReceived(orderRef, recipient, msg.sender, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
