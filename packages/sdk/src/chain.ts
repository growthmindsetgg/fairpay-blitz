import { WaitForTransactionReceiptTimeoutError, type Account, type Chain, type Hash, type PublicClient, type Transport, type WalletClient } from "viem"
import { FairPayError, type FairPayDeployment } from "./config.js"

export type Clients = {
    publicClient: PublicClient
    walletClient: WalletClient<Transport, Chain | undefined, Account>
}

/** Refuses to act when the wallet or RPC is on a different chain than the deployment. */
export async function assertChain(deployment: FairPayDeployment, clients: Partial<Clients>) {
    if (clients.publicClient) {
        const id = await clients.publicClient.getChainId()
        if (id !== deployment.chainId) {
            throw new FairPayError("WRONG_CHAIN", `RPC is on chain ${id}, deployment is on ${deployment.chainId}`)
        }
    }
    if (clients.walletClient) {
        const id = await clients.walletClient.getChainId()
        if (id !== deployment.chainId) {
            throw new FairPayError("WRONG_CHAIN", `Wallet is on chain ${id}, deployment is on ${deployment.chainId}`)
        }
    }
}

// One send queue per sending account (and chain), shared by every caller in this process. Without
// it, two writes at the same moment both read the same pending nonce: one is rejected or replaces
// the other, and a relayed payment fails after the payer's deposit is already in the pool.
// `next` is the nonce after the last transaction this process got the node to accept. Some RPCs
// answer `pending` with the mined count only, so it is trusted over a lower `pending` answer.
type Lane = { tail: Promise<unknown>; next?: number }
const lanes = new Map<string, Lane>()

function laneOf(clients: Clients): Lane {
    const key = `${clients.walletClient.chain?.id ?? "?"}:${clients.walletClient.account.address.toLowerCase()}`
    let lane = lanes.get(key)
    if (!lane) {
        lane = { tail: Promise.resolve() }
        lanes.set(key, lane)
    }
    return lane
}

/**
 * Sends a simulated write with a gas limit close to the estimate. Monad charges for the gas
 * limit rather than gas used, so a generous default limit costs real money.
 *
 * Writes from one account run one at a time, from simulation until the node has accepted the
 * transaction; waiting for the receipt is up to the caller and happens outside the queue. A failed
 * simulation or broadcast doesn't use up a nonce, so later sends never wait behind a gap.
 */
export async function sendSimulated(
    clients: Clients,
    request: Parameters<PublicClient["simulateContract"]>[0]
): Promise<`0x${string}`> {
    const lane = laneOf(clients)
    const run = async () => {
        const { request: simulated } = await clients.publicClient.simulateContract({
            ...request,
            account: clients.walletClient.account
        } as Parameters<PublicClient["simulateContract"]>[0])
        const gas = await clients.publicClient.estimateContractGas({
            ...request,
            account: clients.walletClient.account
        } as Parameters<PublicClient["estimateContractGas"]>[0])
        const tx = { ...simulated, gas: (gas * 115n) / 100n }
        // A browser wallet picks its own nonce; the queue still keeps this page's writes in order.
        if (clients.walletClient.account.type !== "local") return clients.walletClient.writeContract(tx as never)
        const pending = await clients.publicClient.getTransactionCount({
            address: clients.walletClient.account.address,
            blockTag: "pending"
        })
        const nonce = lane.next !== undefined && lane.next > pending ? lane.next : pending
        const hash = await clients.walletClient.writeContract({ ...tx, nonce } as never)
        lane.next = nonce + 1
        return hash
    }
    const p = lane.tail.then(run, run)
    lane.tail = p.catch(() => undefined)
    return p
}

/**
 * Waits for the receipt of a transaction from sendSimulated. If none arrives in time the
 * transaction may have been dropped, so the account's next send goes back to the node's pending
 * count instead of leaving a nonce gap that every later transaction would wait behind.
 */
export async function waitForSent(clients: Clients, hash: Hash, options: { timeout?: number } = {}) {
    try {
        return await clients.publicClient.waitForTransactionReceipt({ hash, ...options })
    } catch (err) {
        if (err instanceof WaitForTransactionReceiptTimeoutError) laneOf(clients).next = undefined
        throw err
    }
}
