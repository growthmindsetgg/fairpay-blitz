import { parseAbi } from "viem"

export const fairPayAbi = parseAbi([
    "function token() view returns (address)",
    "function deployChainId() view returns (uint256)",
    "function paused() view returns (bool)",
    "function directPay(address recipient, uint256 amount, bytes32 orderRef)",
    "event PaymentReceived(bytes32 indexed orderRef, address indexed recipient, address indexed payer, uint256 amount)",
    "error WrongChain()",
    "error ZeroAddress()",
    "error ZeroAmount()",
    "error ZeroOrderRef()",
    "error InvalidRecipient()",
    "error AmountMismatch()",
    "error EnforcedPause()"
])

export const fairPoolAbi = parseAbi([
    "struct PaymentProof { uint256 merkleTreeDepth; uint256 merkleTreeRoot; uint256 nullifier; uint256 message; uint256 scope; uint256[8] points; }",
    "function token() view returns (address)",
    "function fairPay() view returns (address)",
    "function DENOMINATION() view returns (uint256)",
    "function SCOPE() view returns (uint256)",
    "function maxDeposits() view returns (uint256)",
    "function depositCount() view returns (uint256)",
    "function merkleRoot() view returns (uint256)",
    "function knownRoots(uint256 root) view returns (bool)",
    "function nullifierSpent(uint256 nullifier) view returns (bool)",
    "function isMerchant(address merchant) view returns (bool)",
    "function messageFor(address merchant, bytes32 orderRef) pure returns (uint256)",
    "function WITHDRAW_REF() view returns (bytes32)",
    "function withdrawMessage(address recipient) pure returns (uint256)",
    "function paused() view returns (bool)",
    "function deposit(uint256 commitment)",
    "function pay(address merchant, bytes32 orderRef, PaymentProof proof)",
    "function withdraw(address recipient, PaymentProof proof)",
    "event Deposit(uint256 indexed commitment, uint256 index, uint256 root)",
    "event PrivatePayment(uint256 indexed nullifier, address indexed merchant, bytes32 indexed orderRef)",
    "event Withdrawal(uint256 indexed nullifier, address indexed recipient)",
    "error ZeroAddress()",
    "error ZeroAmount()",
    "error ZeroOrderRef()",
    "error TokenMismatch()",
    "error DepositCapReached()",
    "error AmountMismatch()",
    "error NotMerchant()",
    "error WrongScope()",
    "error WrongMessage()",
    "error UnknownRoot()",
    "error UnsupportedDepth()",
    "error NullifierSpent()",
    "error InvalidProof()",
    "error ZeroRecipient()",
    "error EnforcedPause()"
])

export const erc20Abi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)"
])

/** FairPoolBatcher: deposits several notes in one transaction. Includes the pool's errors, which it bubbles up. */
export const fairPoolBatcherAbi = parseAbi([
    "function pool() view returns (address)",
    "function token() view returns (address)",
    "function DENOMINATION() view returns (uint256)",
    "function MAX_BATCH() view returns (uint256)",
    "function depositMany(uint256[] commitments)",
    "error ZeroAddress()",
    "error ZeroAmount()",
    "error EmptyBatch()",
    "error BatchTooLarge()",
    "error AmountMismatch()",
    "error BalanceChanged()",
    "error DepositCapReached()",
    "error EnforcedPause()",
    "error LeafAlreadyExists()",
    "error LeafCannotBeZero()",
    "error LeafGreaterThanSnarkScalarField()",
    "error ReentrancyGuardReentrantCall()",
    "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)"
])
