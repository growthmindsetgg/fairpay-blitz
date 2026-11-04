// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev The part of FairPool the batcher uses.
interface IFairPool {
    function token() external view returns (IERC20);
    function DENOMINATION() external view returns (uint256);
    function deposit(uint256 commitment) external;
}

/// @title FairPoolBatcher
/// @notice Deposits several notes into an existing FairPool in one transaction, so a customer
///         approves once and confirms one deposit instead of approving and depositing per note.
///
/// How it works: `depositMany` pulls `n * DENOMINATION` from the caller, approves the pool for
/// exactly that amount, calls `pool.deposit(c)` once per commitment (the pool pulls one
/// DENOMINATION from this contract each time), then sets the allowance back to 0. Each Deposit
/// event, tree insertion and the deposit cap are the pool's own, so a note deposited through the
/// batcher is indistinguishable from a direct deposit and is spent the same way.
///
/// Security notes:
///  - No owner, no admin functions, no storage. The pool and token are immutable, read from the
///    pool at construction. Nobody can change what this contract does.
///  - Never holds funds after a call. The batcher's token balance must be the same at the end of
///    `depositMany` as at the start, or the whole call reverts. Tokens someone sends here directly
///    (outside `depositMany`) are not counted as theirs, cannot be pulled by anyone and stay here
///    for good: there is deliberately no rescue function, because a rescue function needs an owner.
///  - Only the caller's own tokens move. `safeTransferFrom(msg.sender, ...)` is the only pull, so an
///    allowance a user gives this contract can only ever be spent by that user's own call. Nobody
///    can use someone else's approval to deposit (or to grief) on their behalf.
///  - Fee-on-transfer and other non-standard tokens: the amount received is checked by balance
///    delta and must equal `n * DENOMINATION` exactly (the pool makes the same check per deposit).
///  - Reentrancy: `depositMany` is `nonReentrant`, and `pool.deposit` is `nonReentrant` in the pool.
///    The only external calls are to the immutable token and pool. A token with transfer hooks
///    could call back during the pull or a deposit, but cannot re-enter `depositMany`, and the
///    allowance it could use is exactly what this call is about to deposit.
///  - Atomic: if any deposit fails (duplicate or invalid commitment, pool paused, deposit cap
///    reached), the whole batch reverts and the caller keeps their tokens. In particular, a
///    front-runner who copies one of the commitments from a pending batch and deposits it first
///    makes the batch revert; the front-runner has paid DENOMINATION into a note only the
///    commitment's owner can spend, so the attack costs them money and gifts it to the victim.
///    The victim retries without that commitment (the SDK reports which notes landed).
///  - Allowance: the pool is approved for exactly the batch total and the allowance is reset to 0
///    before returning, so no standing approval from the batcher to the pool remains.
///  - Gas: MAX_BATCH = 20. One pool deposit costs about 335k gas on Monad and Monad charges the
///    full gas limit, so the cap keeps a batch's gas limit (about 7M) well under the block limit
///    and keeps the up-front MON reservation predictable. Larger top-ups are split by the SDK.
contract FairPoolBatcher is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Most notes one call can deposit.
    uint256 public constant MAX_BATCH = 20;

    IFairPool public immutable pool;
    IERC20 public immutable token;
    uint256 public immutable DENOMINATION;

    error ZeroAddress();
    error ZeroAmount();
    error EmptyBatch();
    error BatchTooLarge();
    error AmountMismatch();
    error BalanceChanged();

    constructor(IFairPool pool_) {
        if (address(pool_) == address(0)) revert ZeroAddress();
        IERC20 token_ = pool_.token();
        uint256 denomination_ = pool_.DENOMINATION();
        if (address(token_) == address(0)) revert ZeroAddress();
        if (denomination_ == 0) revert ZeroAmount();
        pool = pool_;
        token = token_;
        DENOMINATION = denomination_;
    }

    /// @notice Deposits one note per commitment, paid by the caller: `commitments.length * DENOMINATION`.
    /// @dev The caller must have approved this contract for at least that amount. Each commitment
    ///      must be valid for the pool (unique, non-zero, inside the SNARK field), and the pool's
    ///      Deposit events give each note's index.
    function depositMany(uint256[] calldata commitments) external nonReentrant {
        uint256 n = commitments.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_BATCH) revert BatchTooLarge();
        uint256 total = n * DENOMINATION;

        uint256 start = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), total);
        if (token.balanceOf(address(this)) - start != total) revert AmountMismatch();

        token.forceApprove(address(pool), total);
        for (uint256 i = 0; i < n; i++) {
            pool.deposit(commitments[i]);
        }
        token.forceApprove(address(pool), 0);

        if (token.balanceOf(address(this)) != start) revert BalanceChanged();
    }
}
