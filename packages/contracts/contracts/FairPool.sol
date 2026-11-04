// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {InternalLeanIMT, LeanIMTData} from "@zk-kit/lean-imt.sol/InternalLeanIMT.sol";
import {ISemaphoreVerifier} from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";
import {MIN_DEPTH, MAX_DEPTH} from "@semaphore-protocol/contracts/base/Constants.sol";
import {FairPay} from "./FairPay.sol";

/// @title FairPool
/// @notice Fixed-denomination privacy pool. A customer deposits DENOMINATION tokens against a
///         Semaphore identity commitment, and later pays a registered merchant with a
///         zero-knowledge proof of membership. The payment cannot be linked to the deposit.
///
/// Security notes:
///  - The pool keeps its OWN Merkle tree and nullifier set and calls the Semaphore verifier
///    directly. Using a shared Semaphore contract would let anyone call its public
///    validateProof() with a proof seen in the mempool, burning the nullifier and freezing
///    the depositor's funds.
///  - The proof's message commits to (merchant, orderRef). A relayer or front-runner cannot
///    redirect the payment; replaying it only pays the same merchant for the same order.
///  - The proof's scope must equal SCOPE (bound to chain id, pool address and denomination),
///    so each identity has exactly one nullifier and cannot spend twice under another scope,
///    and proofs cannot be replayed against another pool or chain.
///  - The tree is append-only (no removals), so every historical root remains a valid
///    statement of membership and is accepted.
///  - Payments only go to allowlisted merchants. This keeps the pool a payment rail rather
///    than a general-purpose mixer. Trust assumption: the owner controls this list.
///  - The owner can pause and cap deposits but has no function to move pooled funds.
contract FairPool is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using InternalLeanIMT for LeanIMTData;

    struct PaymentProof {
        uint256 merkleTreeDepth;
        uint256 merkleTreeRoot;
        uint256 nullifier;
        uint256 message;
        uint256 scope;
        uint256[8] points;
    }

    IERC20 public immutable token;
    FairPay public immutable fairPay;
    ISemaphoreVerifier public immutable verifier;
    uint256 public immutable DENOMINATION;
    uint256 public immutable SCOPE;

    /// @notice Maximum number of deposits ever accepted. Limits funds at risk while unaudited.
    uint256 public maxDeposits;

    LeanIMTData internal tree;
    mapping(uint256 root => bool) public knownRoots;
    mapping(uint256 nullifier => bool) public nullifierSpent;
    mapping(address merchant => bool) public isMerchant;

    event Deposit(uint256 indexed commitment, uint256 index, uint256 root);
    event PrivatePayment(uint256 indexed nullifier, address indexed merchant, bytes32 indexed orderRef);
    event MerchantSet(address indexed merchant, bool allowed);
    event MaxDepositsSet(uint256 maxDeposits);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroOrderRef();
    error TokenMismatch();
    error DepositCapReached();
    error AmountMismatch();
    error NotMerchant();
    error WrongScope();
    error WrongMessage();
    error UnknownRoot();
    error UnsupportedDepth();
    error NullifierSpent();
    error InvalidProof();

    constructor(
        IERC20 token_,
        FairPay fairPay_,
        ISemaphoreVerifier verifier_,
        uint256 denomination_,
        uint256 maxDeposits_,
        address owner_
    ) Ownable(owner_) {
        if (address(token_) == address(0) || address(fairPay_) == address(0) || address(verifier_) == address(0)) {
            revert ZeroAddress();
        }
        if (denomination_ == 0) revert ZeroAmount();
        if (address(fairPay_.token()) != address(token_)) revert TokenMismatch();

        token = token_;
        fairPay = fairPay_;
        verifier = verifier_;
        DENOMINATION = denomination_;
        SCOPE = uint256(keccak256(abi.encode("FairPool.v1", block.chainid, address(this), denomination_)));
        maxDeposits = maxDeposits_;
    }

    // ---------------------------------------------------------------- deposits

    /// @notice Deposit exactly DENOMINATION tokens against a Semaphore identity commitment.
    /// @dev The commitment must be unique, non-zero and inside the SNARK field (enforced by LeanIMT).
    function deposit(uint256 commitment) external nonReentrant whenNotPaused {
        if (tree.size >= maxDeposits) revert DepositCapReached();

        uint256 index = tree.size;
        uint256 root = tree._insert(commitment);
        knownRoots[root] = true;

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), DENOMINATION);
        if (token.balanceOf(address(this)) - before != DENOMINATION) revert AmountMismatch();

        emit Deposit(commitment, index, root);
    }

    // ---------------------------------------------------------------- payments

    /// @notice The Semaphore message a proof must carry to pay `merchant` for `orderRef`.
    function messageFor(address merchant, bytes32 orderRef) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(merchant, orderRef)));
    }

    /// @notice Pay DENOMINATION to `merchant` for `orderRef`, spending one deposited note.
    /// @dev Anyone may submit (normally a relayer); the proof alone authorises the spend.
    function pay(address merchant, bytes32 orderRef, PaymentProof calldata proof) external nonReentrant whenNotPaused {
        if (!isMerchant[merchant]) revert NotMerchant();
        if (orderRef == bytes32(0)) revert ZeroOrderRef();
        if (proof.scope != SCOPE) revert WrongScope();
        if (proof.message != messageFor(merchant, orderRef)) revert WrongMessage();
        if (proof.merkleTreeDepth < MIN_DEPTH || proof.merkleTreeDepth > MAX_DEPTH) revert UnsupportedDepth();
        if (!knownRoots[proof.merkleTreeRoot]) revert UnknownRoot();
        if (nullifierSpent[proof.nullifier]) revert NullifierSpent();

        // The verifier rejects public signals outside the SNARK field, so a nullifier
        // cannot be replayed as nullifier + p.
        bool ok = verifier.verifyProof(
            [proof.points[0], proof.points[1]],
            [[proof.points[2], proof.points[3]], [proof.points[4], proof.points[5]]],
            [proof.points[6], proof.points[7]],
            [proof.merkleTreeRoot, proof.nullifier, _hash(proof.message), _hash(proof.scope)],
            proof.merkleTreeDepth
        );
        if (!ok) revert InvalidProof();

        // Effects before interactions.
        nullifierSpent[proof.nullifier] = true;
        emit PrivatePayment(proof.nullifier, merchant, orderRef);

        token.forceApprove(address(fairPay), DENOMINATION);
        fairPay.directPay(merchant, DENOMINATION, orderRef);
    }

    // ---------------------------------------------------------------- views

    function merkleRoot() external view returns (uint256) {
        return tree._root();
    }

    function depositCount() external view returns (uint256) {
        return tree.size;
    }

    function merkleDepth() external view returns (uint256) {
        return tree.depth;
    }

    // ---------------------------------------------------------------- admin

    function setMerchant(address merchant, bool allowed) external onlyOwner {
        if (merchant == address(0)) revert ZeroAddress();
        isMerchant[merchant] = allowed;
        emit MerchantSet(merchant, allowed);
    }

    function setMaxDeposits(uint256 maxDeposits_) external onlyOwner {
        maxDeposits = maxDeposits_;
        emit MaxDepositsSet(maxDeposits_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Same hashing Semaphore applies to message and scope before they enter the circuit.
    function _hash(uint256 value) private pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(value))) >> 8;
    }
}
