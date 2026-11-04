// The browser's "add to private balance" flow (topUp in src/lib/payments.ts) with the SDK's
// depositNotes replaced by a script: notes are saved before anything is sent, progress speaks in
// transactions rather than notes, and only notes that can never hold funds are dropped on failure.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DepositNotesOptions, Note } from "@fairpay/sdk"

const store = new Map<string, string>()
vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k)
})

type Script = (notes: readonly Note[], options: DepositNotesOptions, saved: () => string[]) => Promise<void>
let script: Script = async () => undefined
vi.mock("@fairpay/sdk", async (importOriginal) => {
    const real = await importOriginal<typeof import("@fairpay/sdk")>()
    return {
        ...real,
        depositNotes: async (_d: unknown, _c: unknown, notes: readonly Note[], options: DepositNotesOptions) => {
            await script(notes, options, () => JSON.parse(store.get(KEY) ?? "[]").map((n: { note: string }) => n.note))
            return { deposits: [], transactions: [] }
        }
    }
})

const { topUp, loadNotes, NeedFundsError } = await import("../src/lib/payments")
const { serializeNote } = await import("@fairpay/sdk")

const deployment = {
    chainId: 10143,
    token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    fairPay: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    pool: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    batcher: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    poolDeployBlock: 0n,
    denomination: 5_000_000n
} as const
const KEY = `fairpay.notes.10143.${deployment.pool.toLowerCase()}`
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const

const clients = (mon = 10n ** 18n) =>
    ({
        publicClient: {
            getBalance: async () => mon,
            readContract: async () => 10n ** 12n,
            estimateFeesPerGas: async () => ({ maxFeePerGas: 100_000_000_000n, maxPriorityFeePerGas: 1n })
        },
        walletClient: { account: { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", type: "local" } }
    }) as never

const rejection = () => Object.assign(new Error("User rejected the request."), { code: 4001 })
const plan = { step: "plan", approve: true, deposits: 1, atomic: false, confirmations: 2, batched: true } as const

beforeEach(() => store.clear())

describe("topUp", () => {
    it("saves every note before the first wallet prompt and marks them deposited", async () => {
        const progress: { summary: string; detail: string; steps: string[] }[] = []
        script = async (notes, o, saved) => {
            expect(saved()).toEqual(notes.map(serializeNote))
            o.onProgress!(plan)
            o.onProgress!({ step: "approve", amount: 55_000_000n })
            o.onProgress!({ step: "deposit", tx: 1, of: 1, notes: 11 })
            o.onDeposited!(notes.map((note, i) => ({ note, txHash: HASH(1), index: BigInt(i) })))
        }
        await topUp(deployment, clients(), 11, (p) => progress.push(p))
        const notes = loadNotes(deployment)
        expect(notes).toHaveLength(11)
        expect(notes.every((n) => n.depositTx === HASH(1))).toBe(true)

        const last = progress.at(-1)!
        expect(last.summary).toBe("Approve once, then confirm one deposit.")
        expect(last.steps).toEqual(["Check your balance", "Approve USDC", "Deposit 11 notes"])
        expect(progress.map((p) => p.detail)).toContain("Transaction 1 of 2: allow 55.00 USDC. Confirm in your wallet.")
        expect(last.detail).toBe("Transaction 2 of 2: deposit 11 notes. Confirm in your wallet.")
    })

    it("says so when the wallet batches everything into one confirmation", async () => {
        let summary = ""
        script = async (notes, o) => {
            o.onProgress!({ ...plan, atomic: true, confirmations: 1 })
            o.onProgress!({ step: "atomic", calls: 2 })
            o.onDeposited!(notes.map((note, i) => ({ note, txHash: HASH(2), index: BigInt(i) })))
        }
        await topUp(deployment, clients(), 3, (p) => (summary = p.summary))
        expect(summary).toBe("Confirm once in your wallet: it approves and deposits together.")
    })

    it("on a declined prompt, drops only the notes that were never sent", async () => {
        script = async (notes, o) => {
            o.onProgress!({ ...plan, deposits: 2, confirmations: 3 })
            o.onProgress!({ step: "approve", amount: 125_000_000n })
            o.onProgress!({ step: "deposit", tx: 1, of: 2, notes: 20 })
            o.onDeposited!(notes.slice(0, 20).map((note, i) => ({ note, txHash: HASH(3), index: BigInt(i) })))
            o.onProgress!({ step: "deposit", tx: 2, of: 2, notes: 5 })
            throw rejection()
        }
        await expect(topUp(deployment, clients(), 25, () => undefined)).rejects.toMatchObject({ code: 4001 })
        const notes = loadNotes(deployment)
        expect(notes).toHaveLength(20)
        expect(notes.every((n) => n.depositTx === HASH(3))).toBe(true)
    })

    it("keeps unconfirmed notes when a sent transaction's outcome is unknown", async () => {
        script = async (_notes, o) => {
            o.onProgress!(plan)
            o.onProgress!({ step: "approve", amount: 10_000_000n })
            o.onProgress!({ step: "deposit", tx: 1, of: 1, notes: 2 })
            throw new Error("Timed out while waiting for transaction")
        }
        await expect(topUp(deployment, clients(), 2, () => undefined)).rejects.toThrow("Timed out")
        expect(loadNotes(deployment).filter((n) => !n.depositTx)).toHaveLength(2)
    })

    it("drops the notes when the deposit is refused before any prompt (full pool)", async () => {
        script = async () => {
            throw Object.assign(new Error("the pool takes 1 more deposit and this needs 3"), { code: "POOL_FULL" })
        }
        await expect(topUp(deployment, clients(), 3, () => undefined)).rejects.toMatchObject({ code: "POOL_FULL" })
        expect(loadNotes(deployment)).toHaveLength(0)
    })

    it("asks for MON before saving anything when the wallet can't cover the gas", async () => {
        script = async () => {
            throw new Error("should not be called")
        }
        // 11 notes through the batcher: about 2.7M gas at 100 gwei, about 0.27 MON.
        const err = await topUp(deployment, clients(10n ** 17n), 11, () => undefined).catch((e: unknown) => e)
        expect(err).toBeInstanceOf(NeedFundsError)
        expect((err as Error).message).toMatch(/needs about 0\.2\d\d MON/)
        expect(loadNotes(deployment)).toHaveLength(0)
    })
})
