// A simulated Monad: balances, a privacy pool and a list of transactions, all in the demo store.
// The exported payment functions have the same shapes as the @fairpay/sdk ones the app uses, so
// payments.ts runs its real code path with these swapped in. Nothing here touches a network,
// builds a proof or loads proving files.

import { FairPayError, type Clients, type FairPayDeployment, type Note, type PrivatePaymentRequest } from "@fairpay/sdk"
import { getAddress, keccak256, toHex, type Address, type Hash, type Hex, type PublicClient } from "viem"
import { parseNote } from "./notes"
import { DEMO_MARKER, DEMO_RELAYER, DENOMINATION, GAS_PER_TX, START_MON, START_USDC } from "./config"
import { store as defaultStore, type DemoState, type DemoStore, type DemoTx } from "./store"

// ------------------------------------------------------------------ helpers

export const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function randomBytes(n: number) {
    const b = new Uint8Array(n)
    crypto.getRandomValues(b)
    return b
}

/** A random 32-byte hex string. Valid-looking, but simulated: it exists on no chain. */
export const fakeHash = (): Hash => toHex(randomBytes(32)) as Hash

export function uuid() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
    const b = randomBytes(16)
    b[6] = (b[6]! & 0x0f) | 0x40
    b[8] = (b[8]! & 0x3f) | 0x80
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** A short label for a simulated hash, like "demo·3f9a". */
export const shortDemoId = (hash: string) => `demo·${hash.slice(2, 6)}`

const key = (a: string) => a.toLowerCase()

/** The demo's stand-in for a note's nullifier: deterministic per note, reveals nothing useful. */
export const demoNullifier = (commitment: bigint | string) =>
    BigInt(keccak256(toHex(`${DEMO_MARKER}:nullifier:${String(commitment)}`))).toString()

function balanceOf(s: DemoState, address: string) {
    const k = key(address)
    s.chain.balances[k] ??= { usdc: START_USDC, mon: START_MON.toString() }
    return s.chain.balances[k]
}

function chargeGas(s: DemoState, address: string) {
    const b = balanceOf(s, address)
    const mon = BigInt(b.mon)
    if (mon < GAS_PER_TX) throw new Error("insufficient funds for gas")
    b.mon = (mon - GAS_PER_TX).toString()
}

function record(s: DemoState, tx: Omit<DemoTx, "hash" | "at">, now: number) {
    const hash = fakeHash()
    s.chain.txs[hash] = { ...tx, hash, at: now }
    return hash
}

// ------------------------------------------------------------------ the ledger

export function createChain(store: DemoStore = defaultStore, now: () => number = Date.now) {
    return {
        store,
        balances(address: string) {
            const s = store.read()
            const b = s.chain.balances[key(address)]
            return { usdc: BigInt(b?.usdc ?? START_USDC), mon: b ? BigInt(b.mon) : START_MON }
        },
        tx(hash: string): DemoTx | undefined {
            return store.read().chain.txs[key(hash)]
        },
        commitments() {
            return [...store.read().chain.commitments]
        },
        isSpent(nullifier: string) {
            return store.read().chain.nullifiers.includes(nullifier)
        },

        /** Simulated faucet: tops the wallet up to at least 50 USDC and 0.15 MON. */
        faucet(address: Address) {
            return store.update((s) => {
                const b = balanceOf(s, address)
                const minted = Math.max(0, START_USDC - b.usdc)
                const gas = START_MON > BigInt(b.mon) ? START_MON - BigInt(b.mon) : 0n
                b.usdc += minted
                b.mon = (BigInt(b.mon) + gas).toString()
                if (minted > 0) record(s, { kind: "faucet", from: address, payer: address, to: address, amount: minted }, now())
                return { minted: String(minted / 1_000_000), gasSent: (Number(gas) / 1e18).toFixed(3) }
            })
        },

        deposit(from: Address, commitment: string) {
            return store.update((s) => {
                const b = balanceOf(s, from)
                if (b.usdc < DENOMINATION) throw new Error("Transfer amount exceeds balance: insufficient balance for a 5 USDC note.")
                chargeGas(s, from)
                b.usdc -= DENOMINATION
                s.chain.commitments.push(commitment)
                return record(s, { kind: "deposit", from, payer: from, to: "pool", amount: DENOMINATION }, now())
            })
        },

        payPublic(from: Address, merchant: Address, amount: number, orderRef: string) {
            return store.update((s) => {
                const b = balanceOf(s, from)
                if (b.usdc < amount) throw new Error("Transfer amount exceeds balance: insufficient balance.")
                chargeGas(s, from)
                b.usdc -= amount
                balanceOf(s, merchant).usdc += amount
                return record(s, { kind: "public", from, payer: from, to: getAddress(merchant), amount, orderRef: key(orderRef) }, now())
            })
        },

        /** What the pool contract would do with a relayed proof: check it, spend the nullifier, pay. */
        payPrivate(request: PrivatePaymentRequest) {
            return store.update((s) => {
                const nullifier = request.proof.nullifier
                if (s.chain.nullifiers.includes(nullifier)) throw new FairPayError("NOTE_SPENT", "NullifierSpent")
                if (!s.chain.commitments.length) throw new FairPayError("GROUP_MISMATCH", "UnknownRoot")
                s.chain.nullifiers.push(nullifier)
                balanceOf(s, request.merchant).usdc += DENOMINATION
                return record(
                    s,
                    {
                        kind: "private",
                        from: DEMO_RELAYER,
                        payer: "pool",
                        to: getAddress(request.merchant),
                        amount: DENOMINATION,
                        orderRef: key(request.orderRef)
                    },
                    now()
                )
            })
        }
    }
}

export type DemoChain = ReturnType<typeof createChain>

/** The chain the demo app uses. */
export const chain = createChain()

// ------------------------------------------------------------------ viem-shaped read client

/**
 * Answers the two reads the pages make (MON balance, token balance). Any other call fails loudly
 * instead of reaching for an RPC.
 */
export function demoPublicClient(c: DemoChain = chain): PublicClient {
    const client = {
        chain: { id: 10143 },
        async getChainId() {
            return 10143
        },
        async getBalance({ address }: { address: Address }) {
            return c.balances(address).mon
        },
        async readContract({ functionName, args }: { functionName: string; args?: readonly unknown[] }) {
            if (functionName === "balanceOf") return c.balances(String(args?.[0])).usdc
            throw new Error(`The demo has no simulated "${functionName}" read.`)
        },
        async waitForTransactionReceipt() {
            return { status: "success" }
        }
    }
    return client as unknown as PublicClient
}

/** Wallet clients for the demo wallet: an account address and nothing that can sign. */
export function demoClients(address: Address, c: DemoChain = chain): Clients {
    return {
        publicClient: demoPublicClient(c),
        walletClient: { account: { address, type: "json-rpc" }, chain: { id: 10143 } } as unknown as Clients["walletClient"]
    }
}

// ------------------------------------------------------------------ @fairpay/sdk stand-ins

const commitmentOf = (note: Note) => String(note.identity.commitment)

/** Same shape as the SDK's depositNote. About 0.7 s. */
export async function depositNote(_d: FairPayDeployment, clients: Clients, note: Note): Promise<{ txHash: Hash; index: bigint }> {
    await pause(700)
    const before = chain.commitments().length
    const txHash = chain.deposit(clients.walletClient.account.address, commitmentOf(note)) as Hash
    return { txHash, index: BigInt(before) }
}

/** Same shape as the SDK's payPublic, plus a step callback. About 1.3 s. */
export async function payPublic(
    _d: FairPayDeployment,
    clients: Clients,
    params: { merchant: Address; amount: bigint; orderRef: Hex },
    onStep?: (s: string) => void
): Promise<{ txHash: Hash }> {
    await pause(600) // the simulated wallet "confirms" by itself
    onStep?.("Sending the payment…")
    await pause(700)
    const txHash = chain.payPublic(clients.walletClient.account.address, params.merchant, Number(params.amount), params.orderRef) as Hash
    return { txHash }
}

/** Stands in for the Merkle group. The demo checks membership against the simulated pool instead. */
export type DemoGroup = { members: string[] }

export async function groupFromCommitments(_d: FairPayDeployment, _pc: PublicClient, commitments: readonly (bigint | string)[]) {
    if (commitments.length === 0) throw new FairPayError("GROUP_MISMATCH", "the pool has no deposits")
    const onChain = new Set(chain.commitments())
    if (!commitments.every((c) => onChain.has(String(c)))) {
        throw new FairPayError("GROUP_MISMATCH", "commitments do not produce a root the pool has recorded")
    }
    return { members: commitments.map(String) } satisfies DemoGroup as never
}

export async function isNoteSpent(_d: FairPayDeployment, _pc: PublicClient, note: Note) {
    return chain.isSpent(demoNullifier(note.identity.commitment))
}

/**
 * Same shape as the SDK's createPrivatePayment. No proof is built: it waits about 1.2 s so the
 * step is visible, and returns a request whose "proof" only carries the simulated nullifier.
 */
export async function createPrivatePayment(
    d: FairPayDeployment,
    _pc: PublicClient,
    params: { note: Note; merchant: Address; orderRef: Hex; group?: unknown }
): Promise<PrivatePaymentRequest> {
    const commitment = commitmentOf(params.note)
    if (!chain.commitments().includes(commitment)) throw new FairPayError("NOTE_NOT_FOUND", "this note was never deposited in the pool")
    await pause(1200)
    const nullifier = demoNullifier(commitment)
    if (chain.isSpent(nullifier)) throw new FairPayError("NOTE_SPENT", "this note has already been spent")
    return {
        chainId: d.chainId,
        pool: getAddress(d.pool!),
        merchant: getAddress(params.merchant),
        orderRef: params.orderRef,
        proof: {
            merkleTreeDepth: "0",
            merkleTreeRoot: "0",
            nullifier,
            message: "0",
            scope: "0",
            points: ["0", "0", "0", "0", "0", "0", "0", "0"]
        }
    }
}

/** Reads a stored note's commitment, or null for an unreadable one. */
export function noteCommitment(serialized: string) {
    try {
        return String(parseNote(serialized).identity.commitment)
    } catch {
        return null
    }
}
