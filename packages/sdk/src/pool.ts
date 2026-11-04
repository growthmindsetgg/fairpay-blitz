import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { generateProof } from "@semaphore-protocol/proof"
import { poseidon2 } from "poseidon-lite"
import {
    encodeAbiParameters,
    getAddress,
    isAddress,
    keccak256,
    parseEventLogs,
    type Address,
    type Hash,
    type Hex,
    type Log,
    type PublicClient
} from "viem"
import { erc20Abi, fairPoolAbi, fairPoolBatcherAbi } from "./abi.js"
import { assertChain, sendSimulated, waitForSent, type Clients } from "./chain.js"
import { FairPayError, type FairPayDeployment, type LogScanOptions } from "./config.js"
import { getLogsChunked } from "./logs.js"

// ------------------------------------------------------------------ notes

/**
 * A private note: the right to spend one pool deposit. Whoever holds the serialized note can
 * spend it, so treat it like a private key. Losing it loses the deposit.
 */
export type Note = { chainId: number; pool: Address; identity: Identity }

const NOTE_PREFIX = "fairpay-note-v1:"
// Base64 of exactly 32 bytes.
const NOTE_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/

export function createNote(deployment: FairPayDeployment): Note {
    const pool = requirePool(deployment)
    return { chainId: deployment.chainId, pool, identity: new Identity() }
}

export function serializeNote(note: Note): string {
    const json = JSON.stringify({ chainId: note.chainId, pool: note.pool, key: note.identity.export() })
    return NOTE_PREFIX + btoa(json)
}

export function parseNote(serialized: string): Note {
    if (!serialized.startsWith(NOTE_PREFIX)) throw new FairPayError("INVALID_INPUT", "not a FairPay note")
    let data: { chainId: unknown; pool: unknown; key: unknown }
    try {
        data = JSON.parse(atob(serialized.slice(NOTE_PREFIX.length)))
    } catch {
        throw new FairPayError("INVALID_INPUT", "corrupted note")
    }
    if (typeof data !== "object" || data === null) throw new FairPayError("INVALID_INPUT", "corrupted note")
    if (!Number.isSafeInteger(data.chainId) || (data.chainId as number) <= 0) {
        throw new FairPayError("INVALID_INPUT", "corrupted note")
    }
    if (typeof data.pool !== "string" || !isAddress(data.pool)) {
        throw new FairPayError("INVALID_INPUT", "corrupted note")
    }
    // Identity.import accepts any string, including "" or a truncated key, and derives a valid
    // identity from it. Such an identity can be public knowledge, so anyone could spend the note.
    // createNote always exports exactly 32 random bytes.
    if (typeof data.key !== "string" || !NOTE_KEY.test(data.key)) throw new FairPayError("INVALID_INPUT", "corrupted note")
    return { chainId: data.chainId as number, pool: getAddress(data.pool), identity: Identity.import(data.key) }
}

// ------------------------------------------------------------------ deposit

/** Deposits one denomination into the pool against a fresh note. Store the note before calling. */
export async function depositNote(
    deployment: FairPayDeployment,
    clients: Clients,
    note: Note
): Promise<{ txHash: Hash; index: bigint }> {
    const pool = requirePool(deployment)
    assertNoteMatches(deployment, note)
    await assertChain(deployment, clients)

    const denomination = await clients.publicClient.readContract({
        address: pool,
        abi: fairPoolAbi,
        functionName: "DENOMINATION"
    })
    const allowance = await clients.publicClient.readContract({
        address: deployment.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [clients.walletClient.account.address, pool]
    })
    if (allowance < denomination) {
        const approveHash = await sendSimulated(clients, {
            address: deployment.token,
            abi: erc20Abi,
            functionName: "approve",
            args: [pool, denomination]
        })
        await waitForSent(clients, approveHash)
    }

    const txHash = await sendSimulated(clients, {
        address: pool,
        abi: fairPoolAbi,
        functionName: "deposit",
        args: [note.identity.commitment]
    })
    const receipt = await waitForSent(clients, txHash)
    if (receipt.status !== "success") throw new Error(`deposit reverted: ${txHash}`)
    const [event] = parseEventLogs({ abi: fairPoolAbi, eventName: "Deposit", logs: receipt.logs }).filter(
        (l) => getAddress(l.address) === pool
    )
    if (!event) throw new Error("Deposit event missing")
    return { txHash, index: event.args.index }
}

// ------------------------------------------------------------------ deposit several notes

/** One deposited note: the transaction that deposited it and its index in the pool's tree. */
export type DepositedNote = { txHash: Hash; index: bigint }

/**
 * Progress of `depositNotes`, reported before each wallet prompt so a UI can say what to confirm.
 * `plan` comes first (and again if an atomic batch falls back to separate transactions).
 */
export type DepositProgress =
    | {
          step: "plan"
          /** An approval transaction is needed (the allowance is short). */
          approve: boolean
          /** Deposit transactions: one per MAX_BATCH notes with a batcher, one per note without. */
          deposits: number
          /** True when the wallet will be asked once, for an atomic EIP-5792 batch. */
          atomic: boolean
          /** Wallet confirmations to expect in total. */
          confirmations: number
          /** True when notes go through FairPoolBatcher. */
          batched: boolean
      }
    | { step: "approve"; amount: bigint }
    | { step: "deposit"; tx: number; of: number; notes: number }
    | { step: "atomic"; calls: number }

export type DepositNotesOptions = {
    onProgress?: (progress: DepositProgress) => void
    /** Called once per confirmed transaction with the notes it deposited, before the next one is sent. */
    onDeposited?: (deposited: (DepositedNote & { note: Note })[]) => void
    /**
     * "auto" (default): when the wallet reports EIP-5792 atomic batching as `supported` on this chain,
     * send the approval and every deposit as one atomic batch (one confirmation). "never": always
     * separate transactions. Local (private key) accounts always use separate transactions.
     */
    atomic?: "auto" | "never"
    /** How long to wait for an atomic batch to land, in ms. Default 180 000. */
    atomicTimeout?: number
}

/**
 * Deposits one denomination per note. Store every note before calling: once a transaction is sent,
 * its notes are the only way to spend those deposits.
 *
 * With `deployment.batcher`: one approval for the total (only if the allowance is short), then
 * `FairPoolBatcher.depositMany` per MAX_BATCH notes, so 11 notes take 2 transactions (1 with an
 * existing allowance, or 1 atomic batch on a wallet that supports EIP-5792). Without a batcher:
 * one approval for the total, then one `FairPool.deposit` per note.
 *
 * Returns each note's transaction and index, in the order of `notes`. If a later transaction fails,
 * the notes of earlier ones are already deposited and were reported through `onDeposited`.
 */
export async function depositNotes(
    deployment: FairPayDeployment,
    clients: Clients,
    notes: readonly Note[],
    options: DepositNotesOptions = {}
): Promise<{ deposits: DepositedNote[]; transactions: Hash[] }> {
    const pool = requirePool(deployment)
    if (notes.length === 0) throw new FairPayError("INVALID_INPUT", "no notes to deposit")
    const seen = new Set<bigint>()
    for (const note of notes) {
        assertNoteMatches(deployment, note)
        if (seen.has(note.identity.commitment)) throw new FairPayError("INVALID_INPUT", "the same note appears twice")
        seen.add(note.identity.commitment)
    }
    await assertChain(deployment, clients)
    const { publicClient, walletClient } = clients
    const owner = walletClient.account.address

    const [denomination, maxDeposits, depositCount, paused] = await Promise.all([
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "DENOMINATION" }),
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "maxDeposits" }),
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "depositCount" }),
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "paused" })
    ])
    // Checked up front so the wallet isn't asked to approve for deposits the pool would refuse.
    if (paused) throw new FairPayError("POOL_PAUSED", "the pool is paused and takes no deposits right now")
    if (depositCount + BigInt(notes.length) > maxDeposits) {
        const left = maxDeposits > depositCount ? maxDeposits - depositCount : 0n
        throw new FairPayError("POOL_FULL", `the pool takes ${left} more ${left === 1n ? "deposit" : "deposits"} and this needs ${notes.length}`)
    }

    const batcher = deployment.batcher ? await checkBatcher(deployment, publicClient, pool) : undefined
    const spender = batcher?.address ?? pool
    const total = denomination * BigInt(notes.length)
    const allowance = await publicClient.readContract({
        address: deployment.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, spender]
    })
    const approve = allowance < total
    const chunks: Note[][] = []
    const size = batcher ? Number(batcher.maxBatch) : 1
    for (let i = 0; i < notes.length; i += size) chunks.push(notes.slice(i, i + size))

    const report = options.onProgress ?? (() => undefined)
    const deposits = new Map<bigint, DepositedNote>()
    const transactions: Hash[] = []
    const record = (txHash: Hash, logs: readonly Log[], expected: readonly Note[]) => {
        const found = new Map<bigint, bigint>()
        for (const l of parseEventLogs({ abi: fairPoolAbi, eventName: "Deposit", logs: logs as Log[] })) {
            if (getAddress(l.address) === pool) found.set(l.args.commitment, l.args.index)
        }
        const done = expected.map((note) => {
            const index = found.get(note.identity.commitment)
            if (index === undefined) throw new Error(`Deposit event missing in ${txHash}`)
            deposits.set(note.identity.commitment, { txHash, index })
            return { note, txHash, index }
        })
        options.onDeposited?.(done)
    }
    const depositCall = (chunk: readonly Note[]) =>
        batcher
            ? {
                  address: batcher.address,
                  abi: fairPoolBatcherAbi,
                  functionName: "depositMany" as const,
                  args: [chunk.map((n) => n.identity.commitment)] as const
              }
            : { address: pool, abi: fairPoolAbi, functionName: "deposit" as const, args: [chunk[0]!.identity.commitment] as const }

    // One atomic batch: approve and every deposit, one confirmation.
    const calls = (approve ? 1 : 0) + chunks.length
    if (options.atomic !== "never" && calls > 1 && (await walletSupportsAtomic(clients, deployment.chainId))) {
        report({ step: "plan", approve, deposits: chunks.length, atomic: true, confirmations: 1, batched: !!batcher })
        report({ step: "atomic", calls })
        const batch = [
            ...(approve ? [{ to: deployment.token, abi: erc20Abi, functionName: "approve", args: [spender, total] } as const] : []),
            ...chunks.map((chunk) => {
                const c = depositCall(chunk)
                return { to: c.address, abi: c.abi, functionName: c.functionName, args: c.args }
            })
        ]
        let id: string | undefined
        try {
            ;({ id } = await walletClient.sendCalls({
                account: walletClient.account,
                // viem takes the batch's chain id from here; the chain was checked above.
                chain: walletClient.chain ?? ({ id: deployment.chainId } as never),
                calls: batch as never,
                forceAtomic: true
            }))
        } catch (err) {
            // A rejection means nothing was sent. Anything else: the wallet couldn't take the batch, so
            // fall through to separate transactions. That is safe even if the batch did land after all:
            // a commitment can only be deposited once, so the deposits would revert, not pay twice.
            if (isUserRejection(err)) throw err
        }
        if (id !== undefined) {
            const status = await walletClient.waitForCallsStatus({ id, timeout: options.atomicTimeout ?? 180_000 })
            if (status.status !== "success") throw new Error(`the wallet's batch did not succeed (status ${status.status ?? status.statusCode})`)
            const receipts = status.receipts ?? []
            for (const r of receipts) {
                if (r.status !== "success") throw new Error(`the wallet's batch reverted: ${r.transactionHash}`)
                if (!transactions.includes(r.transactionHash)) transactions.push(r.transactionHash)
                const logs = r.logs as unknown as Log[]
                const inTx = new Set(
                    parseEventLogs({ abi: fairPoolAbi, eventName: "Deposit", logs })
                        .filter((l) => getAddress(l.address) === pool)
                        .map((l) => l.args.commitment)
                )
                const expected = notes.filter((n) => inTx.has(n.identity.commitment) && !deposits.has(n.identity.commitment))
                if (expected.length) record(r.transactionHash, logs, expected)
            }
            const missing = notes.filter((n) => !deposits.has(n.identity.commitment))
            if (missing.length) throw new Error(`Deposit event missing for ${missing.length} of ${notes.length} notes`)
            return { deposits: notes.map((n) => deposits.get(n.identity.commitment)!), transactions }
        }
    }

    report({ step: "plan", approve, deposits: chunks.length, atomic: false, confirmations: calls, batched: !!batcher })
    if (approve) {
        report({ step: "approve", amount: total })
        const hash = await sendSimulated(clients, { address: deployment.token, abi: erc20Abi, functionName: "approve", args: [spender, total] })
        const receipt = await waitForSent(clients, hash)
        if (receipt.status !== "success") throw new Error(`approve reverted: ${hash}`)
        transactions.push(hash)
    }
    for (const [i, chunk] of chunks.entries()) {
        report({ step: "deposit", tx: i + 1, of: chunks.length, notes: chunk.length })
        const hash = await sendSimulated(clients, depositCall(chunk) as Parameters<typeof sendSimulated>[1])
        const receipt = await waitForSent(clients, hash)
        if (receipt.status !== "success") throw new Error(`deposit reverted: ${hash}`)
        transactions.push(hash)
        record(hash, receipt.logs, chunk)
    }
    return { deposits: notes.map((n) => deposits.get(n.identity.commitment)!), transactions }
}

/** Reads the batcher and refuses one that isn't for this pool and token (a misconfigured address). */
async function checkBatcher(deployment: FairPayDeployment, publicClient: PublicClient, pool: Address) {
    const address = getAddress(deployment.batcher!)
    const [batcherPool, batcherToken, maxBatch] = await Promise.all([
        publicClient.readContract({ address, abi: fairPoolBatcherAbi, functionName: "pool" }),
        publicClient.readContract({ address, abi: fairPoolBatcherAbi, functionName: "token" }),
        publicClient.readContract({ address, abi: fairPoolBatcherAbi, functionName: "MAX_BATCH" })
    ])
    if (getAddress(batcherPool) !== pool || getAddress(batcherToken) !== getAddress(deployment.token) || maxBatch === 0n) {
        throw new FairPayError("INVALID_INPUT", "the batcher belongs to a different pool or token")
    }
    return { address, maxBatch }
}

/**
 * True when the wallet says it can run an atomic batch on this chain right now (EIP-5792 `atomic`
 * capability `supported`). `ready` means the wallet would first ask to upgrade the account to a
 * smart account; that is not done implicitly, so it gets separate transactions instead.
 */
export async function walletSupportsAtomic(clients: Pick<Clients, "walletClient">, chainId: number): Promise<boolean> {
    const { walletClient } = clients
    if (walletClient.account.type === "local") return false
    try {
        const caps = await Promise.race([
            walletClient.getCapabilities({ account: walletClient.account, chainId }),
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_000))
        ])
        return (caps as { atomic?: { status?: unknown } } | undefined)?.atomic?.status === "supported"
    } catch {
        // Wallets without EIP-5792 reject the method.
        return false
    }
}

/** True when the wallet user declined the request (EIP-1193 code 4001). */
function isUserRejection(err: unknown) {
    for (let e = err as { code?: unknown; name?: unknown; cause?: unknown } | undefined, i = 0; e && i < 8; e = e.cause as typeof e, i++) {
        if (e.code === 4001 || e.name === "UserRejectedRequestError") return true
    }
    return false
}

// ------------------------------------------------------------------ group

/**
 * Rebuilds the pool's Merkle tree from Deposit events and checks the result against the
 * on-chain root at the same block. A mismatch means the RPC returned incomplete or forged logs.
 */
export async function fetchGroup(
    deployment: FairPayDeployment,
    publicClient: PublicClient,
    options: LogScanOptions = {}
): Promise<Group> {
    const pool = requirePool(deployment)
    const toBlock = await publicClient.getBlockNumber({ cacheTime: 0 })
    const logs = await getLogsChunked(
        deployment.poolDeployBlock ?? 0n,
        toBlock,
        options.chunkSize ?? 100n,
        (fromBlock, to) =>
            publicClient.getContractEvents({ address: pool, abi: fairPoolAbi, eventName: "Deposit", fromBlock, toBlock: to })
    )
    const sorted = logs.map((l) => l.args).sort((a, b) => (a.index! < b.index! ? -1 : 1))
    sorted.forEach((args, i) => {
        if (args.index !== BigInt(i)) throw new FairPayError("GROUP_MISMATCH", `missing deposit at index ${i}`)
    })

    const group = new Group(sorted.map((a) => a.commitment!))
    const [root, count] = await Promise.all([
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "merkleRoot", blockNumber: toBlock }),
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "depositCount", blockNumber: toBlock })
    ])
    if (count !== BigInt(sorted.length) || (sorted.length > 0 && root !== group.root)) {
        throw new FairPayError("GROUP_MISMATCH", "rebuilt tree does not match the on-chain root")
    }
    return group
}

/**
 * Builds the tree from commitments supplied by an indexer (your backend, a subgraph) instead
 * of scanning logs from the deploy block. The indexer is not trusted: the resulting root must
 * be one the pool has recorded on-chain, which only the exact deposit list in order can produce.
 */
export async function groupFromCommitments(
    deployment: FairPayDeployment,
    publicClient: PublicClient,
    commitments: readonly (bigint | string)[]
): Promise<Group> {
    const pool = requirePool(deployment)
    if (commitments.length === 0) throw new FairPayError("GROUP_MISMATCH", "the pool has no deposits")
    let members: bigint[]
    try {
        members = commitments.map((c) => BigInt(c))
    } catch {
        throw new FairPayError("INVALID_INPUT", "commitments must be integers")
    }
    const group = new Group(members)
    const known = await publicClient.readContract({
        address: pool,
        abi: fairPoolAbi,
        functionName: "knownRoots",
        args: [group.root]
    })
    if (!known) throw new FairPayError("GROUP_MISMATCH", "commitments do not produce a root the pool has recorded")
    return group
}

// ------------------------------------------------------------------ private payment

/** What the browser sends to a relayer. Contains no secret: the proof reveals nothing about the note. */
export type PrivatePaymentRequest = {
    chainId: number
    pool: Address
    merchant: Address
    orderRef: Hex
    proof: {
        merkleTreeDepth: string
        merkleTreeRoot: string
        nullifier: string
        message: string
        scope: string
        points: string[]
    }
}

export function paymentMessage(merchant: Address, orderRef: Hex): bigint {
    return BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [merchant, orderRef])))
}

/**
 * Builds a zero-knowledge proof that spends `note` to pay `merchant` for `orderRef`.
 * Runs entirely client-side; the note never leaves this function.
 */
export async function createPrivatePayment(
    deployment: FairPayDeployment,
    publicClient: PublicClient,
    params: { note: Note; merchant: Address; orderRef: Hex; group?: Group },
    options: LogScanOptions = {}
): Promise<PrivatePaymentRequest> {
    const pool = requirePool(deployment)
    const { note, orderRef } = params
    if (!isAddress(params.merchant)) throw new FairPayError("INVALID_INPUT", "merchant is not an address")
    if (!/^0x[0-9a-fA-F]{64}$/.test(orderRef) || BigInt(orderRef) === 0n) {
        throw new FairPayError("INVALID_INPUT", "orderRef must be a non-zero bytes32")
    }
    const merchant = getAddress(params.merchant)
    assertNoteMatches(deployment, note)
    await assertChain(deployment, { publicClient })

    const [isMerchant, scope, onChainMessage] = await Promise.all([
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "isMerchant", args: [merchant] }),
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "SCOPE" }),
        publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "messageFor", args: [merchant, orderRef] })
    ])
    if (!isMerchant) throw new FairPayError("NOT_MERCHANT", `${merchant} is not a registered merchant`)
    const message = paymentMessage(merchant, orderRef)
    if (message !== onChainMessage) throw new FairPayError("INVALID_INPUT", "message encoding differs from the contract")

    const group = params.group ?? (await fetchGroup(deployment, publicClient, options))
    if (group.indexOf(note.identity.commitment) === -1) {
        throw new FairPayError("NOTE_NOT_FOUND", "this note was never deposited in the pool")
    }

    const proof = await generateProof(note.identity, group, message, scope)
    const spent = await publicClient.readContract({
        address: pool,
        abi: fairPoolAbi,
        functionName: "nullifierSpent",
        args: [BigInt(proof.nullifier)]
    })
    if (spent) throw new FairPayError("NOTE_SPENT", "this note has already been spent")

    return {
        chainId: deployment.chainId,
        pool,
        merchant,
        orderRef,
        proof: {
            merkleTreeDepth: String(proof.merkleTreeDepth),
            merkleTreeRoot: String(proof.merkleTreeRoot),
            nullifier: String(proof.nullifier),
            message: String(proof.message),
            scope: String(proof.scope),
            points: proof.points.map(String)
        }
    }
}

/** True once the note has been used for a payment. */
export async function isNoteSpent(deployment: FairPayDeployment, publicClient: PublicClient, note: Note) {
    const pool = requirePool(deployment)
    const scope = await publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "SCOPE" })
    // Semaphore v4: nullifier = Poseidon(hash(scope), secretScalar), where hash() is the same
    // keccak >> 8 the contract applies. Covered by a test against a real proof.
    const hashedScope = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }], [scope]))) >> 8n
    const nullifier = poseidon2([hashedScope, note.identity.secretScalar])
    return publicClient.readContract({ address: pool, abi: fairPoolAbi, functionName: "nullifierSpent", args: [nullifier] })
}

// ------------------------------------------------------------------ helpers

function requirePool(deployment: FairPayDeployment): Address {
    if (!deployment.pool) throw new FairPayError("NO_POOL", "this deployment has no private pool")
    return getAddress(deployment.pool)
}

function assertNoteMatches(deployment: FairPayDeployment, note: Note) {
    if (note.chainId !== deployment.chainId || getAddress(note.pool) !== requirePool(deployment)) {
        throw new FairPayError("INVALID_INPUT", "note belongs to a different pool or chain")
    }
}
