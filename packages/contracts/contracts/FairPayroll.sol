// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title FairPayroll
/// @notice Payroll escrow for restaurant owners paying their staff in one token (USDC). Any wallet is
///         an employer; state is keyed by (employer, employee), so one person can work for several
///         restaurants. Two pay models share one escrow per employer:
///          1. Shifts: the employer approves a batch of (employee, shiftId, amount). Each amount moves
///             at once from the employer's available funds to the employee's claimable pay. A shiftId
///             is paid at most once per employer.
///          2. Schedules: `amountPerPeriod` every DAY, WEEK or MONTH (MONTH is a fixed 30 days, not a
///             calendar month). While a schedule runs, pay becomes claimable per COMPLETED period from
///             `start`. When it ends or is changed, the period in progress is paid pro rata for the
///             time worked: floor(elapsed * amountPerPeriod / period). Staff are paid for time worked.
///         Employees `claim`; anyone may `claimFor` an employee (a keeper doing auto-payouts), and the
///         money always goes to the employee.
///
/// How schedule pay is set aside (the part that needs care):
///  Schedule pay is not approved transaction by transaction, so the contract must decide when the
///  employer's money stops being theirs. It does this the way streaming-payment contracts do: each
///  schedule reserves `rate = ceil(amountPerPeriod * SCALE / period)` (in 1e-9 token units) per
///  second, and the employer's account keeps one total rate and one `fundedUntil` time. Whenever the
///  account is touched, the time since `fundedUntil` is paid for, in order, out of the employer's free
///  balance into `reserved`; if the free balance runs out, `fundedUntil` stops early and the account
///  is underfunded. A schedule's claimable pay is its earned pay minus what it was already paid,
///  capped by what was reserved for it. All of this is O(1): no loops over staff.
///
///  Why not compute "earned but unclaimed" exactly, as a sum over schedules, and pay schedule claims
///  from whatever is free? (1) That sum needs a loop over every schedule on every withdrawal and
///  approval. (2) It lets the employer jump the queue: add a schedule paying a lot to a second wallet
///  of their own, let it earn one period, and claim it first, taking money the real staff had already
///  earned. Here, money reserved for a second passes to nobody else, and a new schedule only competes
///  for money that was still free when it was added.
///
///  Consequence: the employer cannot withdraw (or spend on shifts) the pay for the period in progress
///  either. Because the per-second rate is rounded up, the reservation always covers the pro-rata pay
///  for the time worked; only the rounding excess (and any reservation made ahead of a future start)
///  returns to the employer when a schedule ends.
///
/// Starts: `start == 0` means now. A brand-new schedule may start up to 30 days in the past (back pay,
/// set aside at once) but never before the end of this employee's previous schedule with this
/// employer, so no time is paid twice. Changing a running schedule settles the old one up to now and
/// the new terms start now or later, never earlier.
///
/// Underfunding: schedules keep earning even when the escrow is empty. A claim then pays what was
/// reserved, up to the earned amount, and emits Shortfall with the rest; once the employer funds
/// again, reservations resume from `fundedUntil` (oldest time first) and later claims pay the rest.
/// Ending a schedule while underfunded (`endSchedule` by the employer, or `resign` by the employee)
/// turns its unreserved earned pay into debt. Debts are shared pro rata between debtors through an
/// O(1) index (with a scale factor, as in Liquity's stability pool, so it never loses precision), so
/// the order of claims does not matter. `employerInfo` shows `shortfall` and `fundedUntil`, and
/// `fundingNeeded` says exactly what to fund; an underfunded employer cannot add or change a schedule
/// until it funds.
///
/// Seniority when money is short: new funds back DEBT FIRST (pay of schedules that have ended), then
/// the unreserved time of schedules still running, oldest second first. So the unfunded pay of
/// someone still working is junior to the debt of someone who left, including a large schedule the
/// employer ended for a wallet of its own. An employee who is still working and not being funded can
/// `resign`: that settles their schedule up to now (pro rata, exactly like `endSchedule`) and their
/// unfunded pay joins the debt pool, pro rata with everyone else's.
///
/// Security notes:
///  - No owner, admin, pause or upgrade. The token is immutable. Only an employer can move its free
///    funds (`withdraw`, `approveShifts`, a back-dated `setSchedule`); a claim only ever pays the
///    employee; nobody else can touch an employer's money.
///  - Money owed to staff is never withdrawable: withdraw only takes the free balance, after the
///    reservations up to now have been made. Approved shift pay is set aside in full when approved,
///    so it is always payable and a schedule shortfall never blocks it.
///  - An employer can promise pay to a wallet of its own like to anyone else. That never reaches
///    money already set aside; in an underfunded account it dilutes new funding in proportion to the
///    pay promised (per second while schedules run, pro rata between debts once ended).
///  - Fee-on-transfer tokens are rejected by a balance-delta check on `fund`. Tokens sent here
///    directly are not credited to anyone and stay here: there is no rescue function, because that
///    would need an owner.
///  - Every state-changing function is nonReentrant and writes its state before calling the token.
///  - Bounded work: `approveShifts` takes at most MAX_SHIFTS; every other function is constant gas
///    (Monad charges the full gas limit, so this keeps limits tight and predictable).
///  - A fork of the chain is refused: state-changing calls revert unless block.chainid is the
///    chain the contract was deployed on.
contract FairPayroll is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant DAY = 1 days;
    uint256 public constant WEEK = 7 days;
    /// @notice "Monthly" is a fixed 30 days.
    uint256 public constant MONTH = 30 days;
    /// @notice Most shifts one `approveShifts` call can approve.
    uint256 public constant MAX_SHIFTS = 50;
    /// @notice A schedule may start at most this far in the past (back pay) or the future.
    uint256 public constant MAX_START_OFFSET = 30 days;
    /// @notice Reservations are counted in 1/SCALE token units so per-second rates stay exact enough.
    uint256 public constant SCALE = 1e9;
    /// @dev Starting value of the debt index (fraction of a debt still unbacked), fixed point.
    uint256 private constant ONE = 1e36;
    /// @dev When the debt index would fall below this it is multiplied by SCALE_STEP and the
    ///      employer's debtScale goes up by one, so the index always keeps 18+ significant digits.
    uint256 private constant MIN_INDEX = 1e18;
    uint256 private constant SCALE_STEP = 1e18;

    struct Shift {
        address employee;
        bytes32 shiftId;
        uint256 amount;
    }

    /// @dev Slot 0: amountPerPeriod, period, start, origin, endedAt. Slot 1: paid.
    ///      origin = the time from which this schedule's rate counts in the employer's reservations
    ///      (min(start, time it was set)); paid = schedule pay already claimed by the employee;
    ///      endedAt = when the previous schedule for this pair ended (a new one cannot start earlier).
    struct Schedule {
        uint96 amountPerPeriod;
        uint32 period;
        uint40 start;
        uint40 origin;
        uint40 endedAt;
        uint256 paid;
    }

    /// @dev Per employer. `free` and `reserved` are in 1/SCALE token units, the rest in token units.
    ///      Held for the employer = (free + reserved) / SCALE + settled + debtBacked.
    struct Account {
        uint128 free; // nobody's: withdrawable, can pay shifts
        uint128 reserved; // set aside for active schedules, not yet claimed
        uint128 rate; // sum of active schedules' rates, 1/SCALE tokens per second
        uint40 fundedUntil; // schedules are reserved for up to this time
        uint64 debtEpoch; // increments each time all debt is backed
        uint24 debtScale; // how many times debtIndex was multiplied by SCALE_STEP in this epoch
        uint128 settled; // fully backed, waiting to be claimed (shifts, settled schedules, repaid debt)
        uint128 debtBacked; // funds set aside for debts, not yet moved to a debtor's settled pay
        uint128 debt; // unbacked debt (liability only)
        uint128 debtIndex; // fraction of each debt still unbacked in this epoch, times ONE
    }

    /// @dev Per (employer, employee).
    struct Position {
        uint128 settled; // fully backed: approved shifts, settled schedule pay, repaid debt
        uint128 debt; // unbacked debt as of the checkpoint below
        uint128 debtIndex; // the employer's debtIndex when `debt` was last updated
        uint64 debtEpoch; // the employer's debtEpoch then
        uint24 debtScale; // the employer's debtScale then
    }

    struct EmployerInfo {
        uint256 balance; // tokens held for the employer
        uint256 available; // withdrawable now
        uint256 owed; // everything set aside for staff or owed to them (balance - available + shortfall)
        uint256 shortfall; // what the employer must fund for all pay to be set aside up to now
        uint256 fundedUntil; // schedule pay is set aside up to this time
        uint256 runwayUntil; // when the current free balance runs out at today's rates (0: no schedules)
        uint256 payPerDay; // what all active schedules cost per day, rounded up
    }

    struct EmployeeInfo {
        uint256 claimable; // what claim() would pay now
        uint256 earned; // everything owed to the employee by this employer up to now
        uint256 shortfall; // earned - claimable: earned but not yet funded
        uint256 settled; // backed and claimable: shifts, settled schedule pay, this debtor's repaid debt
        uint256 debt; // unbacked debt from schedules that ended while underfunded
        uint256 scheduleEarned; // unpaid pay from completed periods of the active schedule
        uint256 nextPeriodEnd; // when the active schedule's next period completes (0: none)
    }

    IERC20 public immutable token;
    uint256 public immutable deployChainId;

    mapping(address employer => Account) internal _accounts;
    mapping(address employer => mapping(address employee => Position)) internal _positions;
    mapping(address employer => mapping(address employee => Schedule)) internal _schedules;
    mapping(address employer => mapping(bytes32 shiftId => bool)) public shiftApproved;

    event Funded(address indexed employer, uint256 amount);
    event Withdrawn(address indexed employer, uint256 amount);
    event ShiftApproved(address indexed employer, address indexed employee, bytes32 indexed shiftId, uint256 amount);
    /// @param start when pay starts counting (a `start` of 0 is reported as the block time)
    /// @param origin from when pay is set aside: min(start, now)
    /// @param upfront back pay set aside at once for a start in the past (tokens, rounded up)
    event ScheduleSet(
        address indexed employer,
        address indexed employee,
        uint256 amountPerPeriod,
        uint256 period,
        uint256 start,
        uint256 origin,
        uint256 upfront
    );
    /// @param settled earned pay (incl. the pro-rata period in progress) moved to claimable pay
    /// @param debt earned pay that was not funded; owed as debt
    event ScheduleEnded(address indexed employer, address indexed employee, uint256 settled, uint256 debt);
    /// @param caller the employee, or a keeper calling claimFor
    /// @param fromSchedule part paid from the running schedule (the rest: shifts, settled schedules, debt)
    /// @param fromDebt part that is debt repaid since this employee's last checkpoint
    event Claimed(
        address indexed employer,
        address indexed employee,
        address indexed caller,
        uint256 amount,
        uint256 fromSchedule,
        uint256 fromDebt
    );
    /// @notice A claim left `unpaid` earned pay unfunded. It stays owed.
    event Shortfall(address indexed employer, address indexed employee, uint256 unpaid);
    /// @notice After this call the employer's pay is only funded up to `fundedUntil` (or debt remains).
    event Underfunded(address indexed employer, uint256 fundedUntil, uint256 shortfall);
    /// @notice New funds backed `amount` of debt (shared pro rata by the debtors).
    event DebtBacked(address indexed employer, uint256 amount, uint256 debtLeft);
    /// @notice `amount` of this employee's debt was backed and moved to their claimable pay. Emitted
    ///         whenever that happens (a claim, or a schedule ending); Claimed.fromDebt only counts the
    ///         part moved in that same claim.
    event DebtRepaid(address indexed employer, address indexed employee, uint256 amount);
    /// @notice The employee ended their own schedule (followed by ScheduleEnded).
    event Resigned(address indexed employer, address indexed employee);

    error WrongChain();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroShiftId();
    error InvalidEmployee();
    error AmountMismatch();
    error AmountTooLarge();
    error BalanceTooLarge();
    error EmptyBatch();
    error BatchTooLarge();
    error ShiftAlreadyApproved(bytes32 shiftId);
    error InsufficientAvailable(uint256 available, uint256 needed);
    error InvalidPeriod();
    error InvalidStart();
    error AccountUnderfunded();
    error NoSchedule();
    error NothingToClaim();

    modifier onDeployChain() {
        if (block.chainid != deployChainId) revert WrongChain();
        _;
    }

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        deployChainId = block.chainid;
    }

    // ---------------------------------------------------------------- employer: escrow

    /// @notice Add `amount` to the caller's escrow. Needs a prior token approval.
    /// @dev New money first backs debts, then pays schedule time not yet reserved (oldest first).
    function fund(uint256 amount) external nonReentrant onDeployChain {
        if (amount == 0) revert ZeroAmount();
        Account memory a = _accounts[msg.sender];
        uint256 held = uint256(a.free) + a.reserved + (uint256(a.settled) + a.debtBacked) * SCALE;
        if (held + amount * SCALE > type(uint128).max) revert BalanceTooLarge();
        a.free = (uint256(a.free) + amount * SCALE).toUint128();
        _accrueAndLog(msg.sender, a);
        _store(msg.sender, a);

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        // Rejects fee-on-transfer and similar tokens: the escrow must hold exactly what it credits.
        if (token.balanceOf(address(this)) - before != amount) revert AmountMismatch();
        emit Funded(msg.sender, amount);
    }

    /// @notice Withdraw up to `available(msg.sender)`: money no employee has earned or is earning.
    ///         `type(uint256).max` withdraws everything available at the time the call runs.
    function withdraw(uint256 amount) external nonReentrant onDeployChain returns (uint256) {
        Account memory a = _accounts[msg.sender];
        _accrueAndLog(msg.sender, a);
        uint256 avail = _available(a);
        if (amount == type(uint256).max) amount = avail;
        if (amount == 0) revert ZeroAmount();
        if (amount > avail) revert InsufficientAvailable(avail, amount);
        a.free -= uint128(amount * SCALE);
        _store(msg.sender, a);

        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
        return amount;
    }

    // ---------------------------------------------------------------- employer: shifts

    /// @notice Approve up to MAX_SHIFTS shifts at once. Each amount moves from the caller's available
    ///         funds to the employee's claimable pay. All or nothing.
    /// @dev Reverts if any shiftId was already approved by this employer (also within the batch) or if
    ///      the total exceeds what is available.
    function approveShifts(Shift[] calldata shifts) external nonReentrant onDeployChain {
        uint256 n = shifts.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_SHIFTS) revert BatchTooLarge();
        Account memory a = _accounts[msg.sender];
        _accrueAndLog(msg.sender, a);

        uint256 total = 0;
        for (uint256 i = 0; i < n; i++) {
            Shift calldata s = shifts[i];
            _checkEmployee(s.employee);
            if (s.shiftId == bytes32(0)) revert ZeroShiftId();
            if (s.amount == 0) revert ZeroAmount();
            if (shiftApproved[msg.sender][s.shiftId]) revert ShiftAlreadyApproved(s.shiftId);
            shiftApproved[msg.sender][s.shiftId] = true;
            Position storage p = _positions[msg.sender][s.employee];
            p.settled = (uint256(p.settled) + s.amount).toUint128();
            total += s.amount;
            emit ShiftApproved(msg.sender, s.employee, s.shiftId, s.amount);
        }

        uint256 avail = _available(a);
        if (total > avail) revert InsufficientAvailable(avail, total);
        a.free -= uint128(total * SCALE);
        a.settled += uint128(total);
        _store(msg.sender, a);
    }

    // ---------------------------------------------------------------- employer: schedules

    /// @notice Pay `employee` `amountPerPeriod` for every completed `period` (DAY, WEEK or MONTH)
    ///         from `start` (0 = now). If a schedule is running for this employee it is first settled
    ///         up to now, the period in progress pro rata, and the new terms must start now or later.
    /// @dev A brand-new schedule may start up to MAX_START_OFFSET in the past, but not before this
    ///      employee's previous schedule with the caller ended; that back pay is set aside at once from
    ///      available funds. Any schedule may start up to MAX_START_OFFSET in the future; pay is set
    ///      aside from the moment of this call (returned when the schedule ends). Reverts while the
    ///      employer's account is underfunded.
    function setSchedule(address employee, uint256 amountPerPeriod, uint256 period, uint256 start)
        external
        nonReentrant
        onDeployChain
    {
        _checkEmployee(employee);
        if (amountPerPeriod == 0) revert ZeroAmount();
        if (amountPerPeriod > type(uint96).max) revert AmountTooLarge();
        if (period != DAY && period != WEEK && period != MONTH) revert InvalidPeriod();
        uint256 begin = start == 0 ? block.timestamp : start;
        Schedule storage old = _schedules[msg.sender][employee];
        bool running = old.amountPerPeriod != 0;
        uint256 earliest = running ? block.timestamp : Math.max(old.endedAt, block.timestamp - Math.min(block.timestamp, MAX_START_OFFSET));
        if (begin < earliest || begin > block.timestamp + MAX_START_OFFSET) revert InvalidStart();

        Account memory a = _accounts[msg.sender];
        _accrueAndLog(msg.sender, a);
        if (a.fundedUntil < block.timestamp || a.debt != 0) revert AccountUnderfunded();
        if (running) _end(a, msg.sender, employee);

        uint256 rate = _rate(amountPerPeriod, period);
        uint256 origin = Math.min(begin, block.timestamp);
        uint256 lump = rate * (block.timestamp - origin);
        if (lump > a.free) revert InsufficientAvailable(a.free / SCALE, Math.ceilDiv(lump, SCALE));
        a.free -= uint128(lump);
        a.reserved += uint128(lump);
        a.rate = (uint256(a.rate) + rate).toUint128();
        _store(msg.sender, a);

        _schedules[msg.sender][employee] = Schedule({
            amountPerPeriod: uint96(amountPerPeriod),
            period: uint32(period),
            start: uint40(begin),
            origin: uint40(origin),
            endedAt: 0,
            paid: 0
        });
        emit ScheduleSet(msg.sender, employee, amountPerPeriod, period, begin, origin, Math.ceilDiv(lump, SCALE));
    }

    /// @notice Stop `employee`'s schedule now. Everything earned, including the period in progress pro
    ///         rata, stays owed: funded pay becomes claimable, unfunded pay becomes debt. What the
    ///         schedule had set aside beyond that returns to the employer.
    function endSchedule(address employee) external nonReentrant onDeployChain {
        _endNow(msg.sender, employee);
    }

    /// @notice The employee ends their own schedule with `employer`, exactly as `endSchedule` would:
    ///         everything earned up to now (pro rata) is settled, funded pay becomes claimable and
    ///         unfunded pay becomes debt, shared pro rata with the other debts. See "Seniority".
    function resign(address employer) external nonReentrant onDeployChain {
        _endNow(employer, msg.sender);
        emit Resigned(employer, msg.sender);
    }

    // ---------------------------------------------------------------- employees

    /// @notice Pay the caller everything `employer` owes them that is funded.
    function claim(address employer) external nonReentrant onDeployChain returns (uint256) {
        return _claim(employer, msg.sender);
    }

    /// @notice Same as `claim`, callable by anyone (e.g. a keeper). Pays only `employee`.
    function claimFor(address employer, address employee) external nonReentrant onDeployChain returns (uint256) {
        if (employee == address(0)) revert ZeroAddress();
        return _claim(employer, employee);
    }

    // ---------------------------------------------------------------- views

    /// @notice What `employer` can withdraw or spend on shifts now.
    function available(address employer) external view returns (uint256) {
        Account memory a = _accounts[employer];
        _accrue(a);
        return _available(a);
    }

    /// @notice Tokens `employer` must fund now so that all debt is backed and every running schedule
    ///         is set aside up to `until` (at today's rates). Includes the per-second rounding.
    /// @dev Computed at the time of the call. Running schedules keep costing money every second, so
    ///      pass an `until` at or after the time the funding transaction is expected to be included,
    ///      plus a margin (e.g. now + 10 minutes, or the next payday). `until` = 0 (or any time up to
    ///      `fundedUntil`) gives the debt only.
    function fundingNeeded(address employer, uint256 until) external view returns (uint256) {
        Account memory a = _accounts[employer];
        _accrue(a);
        uint256 need = uint256(a.debt) * SCALE;
        if (until > a.fundedUntil) need += uint256(a.rate) * (until - a.fundedUntil);
        return need > a.free ? Math.ceilDiv(need - a.free, SCALE) : 0;
    }

    function employerInfo(address employer) external view returns (EmployerInfo memory info) {
        Account memory a = _accounts[employer];
        _accrue(a);
        info.balance = (uint256(a.free) + a.reserved) / SCALE + a.settled + a.debtBacked;
        info.available = _available(a);
        info.shortfall = _shortfall(a);
        info.owed = info.balance - info.available + info.shortfall;
        info.fundedUntil = a.fundedUntil;
        if (a.rate != 0) {
            info.runwayUntil = uint256(a.fundedUntil) + a.free / a.rate;
            info.payPerDay = Math.ceilDiv(uint256(a.rate) * 1 days, SCALE);
        }
    }

    function employeeInfo(address employer, address employee) external view returns (EmployeeInfo memory info) {
        Account memory a = _accounts[employer];
        _accrue(a);
        Position memory p = _positions[employer][employee];
        _syncDebt(a, p);
        Schedule memory s = _schedules[employer][employee];
        info.settled = p.settled;
        info.debt = p.debt;
        info.claimable = p.settled;
        info.earned = uint256(p.settled) + p.debt;
        if (s.amountPerPeriod != 0) {
            (uint256 owed, uint256 payable_) = _due(s, a.fundedUntil);
            info.scheduleEarned = owed;
            info.claimable += payable_;
            info.earned += owed;
            uint256 nextPeriod = block.timestamp < s.start ? 1 : (block.timestamp - s.start) / s.period + 1;
            info.nextPeriodEnd = uint256(s.start) + nextPeriod * s.period;
        }
        info.shortfall = info.earned - info.claimable;
    }

    function scheduleOf(address employer, address employee) external view returns (Schedule memory) {
        return _schedules[employer][employee];
    }

    // ---------------------------------------------------------------- internals

    function _endNow(address employer, address employee) private {
        if (_schedules[employer][employee].amountPerPeriod == 0) revert NoSchedule();
        Account memory a = _accounts[employer];
        _accrueAndLog(employer, a);
        _end(a, employer, employee);
        // The returned reservation is applied at once (debts first, then unreserved time).
        _accrueAndLog(employer, a);
        _store(employer, a);
    }

    function _claim(address employer, address employee) private returns (uint256 pay) {
        Account memory a = _accounts[employer];
        _accrueAndLog(employer, a);
        Position memory p = _positions[employer][employee];
        uint256 fromDebt = _syncDebt(a, p);
        if (fromDebt != 0) emit DebtRepaid(employer, employee, fromDebt);

        pay = p.settled;
        a.settled -= p.settled;
        p.settled = 0;
        uint256 unpaid = p.debt;

        uint256 fromSchedule = 0;
        Schedule storage s = _schedules[employer][employee];
        if (s.amountPerPeriod != 0) {
            (uint256 owed, uint256 payable_) = _due(s, a.fundedUntil);
            if (payable_ != 0) {
                s.paid += payable_;
                a.reserved -= uint128(payable_ * SCALE);
                fromSchedule = payable_;
                pay += payable_;
            }
            unpaid += owed - payable_;
        }
        if (pay == 0 && unpaid == 0) revert NothingToClaim();

        _positions[employer][employee] = p;
        _store(employer, a);
        if (unpaid != 0) emit Shortfall(employer, employee, unpaid);
        if (pay != 0) {
            token.safeTransfer(employee, pay);
            emit Claimed(employer, employee, msg.sender, pay, fromSchedule, fromDebt);
        }
    }

    /// @dev Settles `employee`'s schedule up to now (completed periods plus the period in progress pro
    ///      rata) and clears it. Funded pay moves to the employee's settled pay, unfunded pay to debt,
    ///      and the rest of its reservation back to free.
    function _end(Account memory a, address employer, address employee) private {
        Schedule memory s = _schedules[employer][employee];
        uint256 rate = _rate(s.amountPerPeriod, s.period);
        uint256 worked = block.timestamp > s.start ? block.timestamp - s.start : 0;
        uint256 owed = (worked * s.amountPerPeriod) / s.period - s.paid;
        // This schedule's share of `reserved`: everything reserved for it minus what it was paid.
        // rate >= amountPerPeriod * SCALE / period and origin <= start, so when funded up to now this
        // covers `owed` (see the contract notes).
        uint256 mine = rate * (uint256(a.fundedUntil) - s.origin) - s.paid * SCALE;
        uint256 backed = Math.min(owed, mine / SCALE);
        uint256 debt = owed - backed;

        a.reserved -= uint128(mine);
        a.free += uint128(mine - backed * SCALE);
        a.settled += uint128(backed);
        a.rate -= uint128(rate);

        Position memory p = _positions[employer][employee];
        uint256 repaid = _syncDebt(a, p);
        if (repaid != 0) emit DebtRepaid(employer, employee, repaid);
        p.settled = (uint256(p.settled) + backed).toUint128();
        if (debt != 0) {
            if (a.debt == 0) {
                a.debtIndex = uint128(ONE);
                a.debtScale = 0;
            }
            // After the sync, p.debt is valued at the current index, like the new debt.
            p.debt = (uint256(p.debt) + debt).toUint128();
            p.debtIndex = a.debtIndex;
            p.debtEpoch = a.debtEpoch;
            p.debtScale = a.debtScale;
            a.debt = (uint256(a.debt) + debt).toUint128();
        }
        _positions[employer][employee] = p;
        _schedules[employer][employee] =
            Schedule({amountPerPeriod: 0, period: 0, start: 0, origin: 0, endedAt: uint40(block.timestamp), paid: 0});
        emit ScheduleEnded(employer, employee, backed, debt);
    }

    /// @dev Moves this debtor's pro-rata share of backed debt (since its checkpoint) to its settled
    ///      pay. Rounds the remaining debt up, so the shares handed out never exceed what was backed;
    ///      once all debt is backed (a new epoch) the remainder is exact.
    function _syncDebt(Account memory a, Position memory p) private pure returns (uint256 repaid) {
        if (p.debt == 0) return 0;
        bool sameEpoch = p.debtEpoch == a.debtEpoch;
        uint256 remaining = sameEpoch ? _remainingDebt(a, p) : 0;
        repaid = Math.min(p.debt - remaining, a.debtBacked);
        if (repaid != 0) {
            p.debt -= uint128(repaid);
            p.settled += uint128(repaid);
            a.debtBacked -= uint128(repaid);
            a.settled += uint128(repaid);
        }
        if (sameEpoch) {
            p.debtIndex = a.debtIndex;
            p.debtScale = a.debtScale;
        }
    }

    /// @dev p.debt * (current index / checkpoint index), across scale changes, rounded up.
    ///      Both indexes are in [MIN_INDEX, ONE]. One scale apart: divide by one more SCALE_STEP.
    ///      Two or more apart the true value is below p.debt / 1e18, so that bound (rounded up) is used:
    ///      at most a unit or two for any realistic debt, and exact once the epoch ends.
    function _remainingDebt(Account memory a, Position memory p) private pure returns (uint256) {
        uint256 diff = uint256(a.debtScale) - p.debtScale;
        if (diff == 0) return Math.mulDiv(p.debt, a.debtIndex, p.debtIndex, Math.Rounding.Ceil);
        if (diff == 1) return Math.mulDiv(p.debt, a.debtIndex, uint256(p.debtIndex) * SCALE_STEP, Math.Rounding.Ceil);
        return Math.ceilDiv(p.debt, SCALE_STEP);
    }

    /// @dev Unpaid earned pay (completed periods) of a running schedule, and how much of it is funded.
    function _due(Schedule memory s, uint256 fundedUntil) private view returns (uint256 owed, uint256 payable_) {
        owed = _periodsAt(s, block.timestamp) * s.amountPerPeriod - s.paid;
        uint256 mine = _rate(s.amountPerPeriod, s.period) * (fundedUntil - s.origin) - s.paid * SCALE;
        payable_ = Math.min(owed, mine / SCALE);
    }

    /// @dev Brings an account up to now: free funds back debts first (pro rata, via the debt index),
    ///      then pay the schedule time since `fundedUntil`, in order, until now or the money runs out.
    function _accrue(Account memory a) private view returns (uint256 repaid) {
        if (a.debt != 0) {
            repaid = Math.min(a.debt, a.free / SCALE);
            if (repaid != 0) {
                uint256 left = a.debt - repaid;
                a.free -= uint128(repaid * SCALE);
                a.debtBacked += uint128(repaid);
                if (left == 0) {
                    a.debtEpoch += 1;
                    a.debtIndex = 0;
                    a.debtScale = 0;
                } else {
                    // Rounded up: debtors are never shown more than was backed.
                    uint256 index = Math.mulDiv(a.debtIndex, left, a.debt, Math.Rounding.Ceil);
                    if (index < MIN_INDEX) {
                        // Rescale instead of losing digits (index * SCALE_STEP stays below ONE).
                        index = Math.mulDiv(uint256(a.debtIndex) * SCALE_STEP, left, a.debt, Math.Rounding.Ceil);
                        uint256 steps = 1;
                        while (index < MIN_INDEX) {
                            index *= SCALE_STEP;
                            steps++;
                        }
                        a.debtScale = (uint256(a.debtScale) + steps).toUint24();
                    }
                    a.debtIndex = uint128(index);
                }
                a.debt = uint128(left);
            }
        }
        if (a.fundedUntil >= block.timestamp) return repaid;
        if (a.rate == 0) {
            a.fundedUntil = uint40(block.timestamp);
            return repaid;
        }
        uint256 need = uint256(a.rate) * (block.timestamp - a.fundedUntil);
        if (need <= a.free) {
            a.free -= uint128(need);
            a.reserved += uint128(need);
            a.fundedUntil = uint40(block.timestamp);
        } else {
            uint256 secs = a.free / a.rate;
            uint256 spent = secs * a.rate;
            a.free -= uint128(spent);
            a.reserved += uint128(spent);
            a.fundedUntil += uint40(secs);
        }
    }

    function _accrueAndLog(address employer, Account memory a) private {
        uint256 repaid = _accrue(a);
        if (repaid != 0) emit DebtBacked(employer, repaid, a.debt);
    }

    /// @dev Free funds, except while schedules are funded only up to a time before now: then the free
    ///      balance is less than one second of pay (rounding dust) and belongs to the next reservation.
    function _available(Account memory a) private view returns (uint256) {
        return a.fundedUntil < block.timestamp ? 0 : a.free / SCALE;
    }

    function _store(address employer, Account memory a) private {
        _accounts[employer] = a;
        uint256 short = _shortfall(a);
        if (short != 0) emit Underfunded(employer, a.fundedUntil, short);
    }

    /// @dev Debt plus schedule time not yet reserved, rounded up to whole tokens.
    function _shortfall(Account memory a) private view returns (uint256) {
        return a.debt + Math.ceilDiv(uint256(a.rate) * (block.timestamp - a.fundedUntil), SCALE);
    }

    function _periodsAt(Schedule memory s, uint256 t) private pure returns (uint256) {
        return t < s.start ? 0 : (t - s.start) / s.period;
    }

    function _rate(uint256 amountPerPeriod, uint256 period) private pure returns (uint256) {
        return Math.ceilDiv(amountPerPeriod * SCALE, period);
    }

    function _checkEmployee(address employee) private view {
        if (employee == address(0)) revert ZeroAddress();
        if (employee == address(this)) revert InvalidEmployee();
    }
}
