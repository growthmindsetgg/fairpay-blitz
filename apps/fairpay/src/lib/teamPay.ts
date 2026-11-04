// Team pay in the browser: the restaurant owner pays a staff member straight from their connected
// wallet with one USDC transfer, then asks the FairPay server to record it. The server checks the
// transfer on-chain before it records anything (server/routes/teamPay.ts); nothing here is trusted.

import { erc20Abi as sdkErc20Abi, sendSimulated, type Clients } from "@fairpay/sdk"
import { erc20Abi, getAddress, type Hash } from "viem"
import type { TeamPayout, Wallet } from "../../shared/types"
import { ApiError, teamPayApi } from "./api"
import { usdc } from "./format"
import { NeedFundsError, PaymentRejectedError } from "./payments"
import { safeStorage, type Deployment } from "./wallet"

export const TEAM_PAY_STEPS = ["Check your balance", "Confirm in your wallet", "Verify on Monad"]

// Monad charges the full gas limit (the SDK's estimate plus 15%). A USDC transfer uses about 35k to
// 52k gas; slightly generous, so the check only stops a wallet that would fail anyway.
const TRANSFER_GAS = 80_000n

const mon3 = (wei: bigint) => (Number(wei / 10n ** 12n) / 1e6).toFixed(3)

async function assertFunds(d: Deployment, clients: Clients, amount: bigint) {
    const address = clients.walletClient.account.address
    const [mon, bal, fees] = await Promise.all([
        clients.publicClient.getBalance({ address }),
        clients.publicClient.readContract({ address: d.token, abi: sdkErc20Abi, functionName: "balanceOf", args: [address] }),
        clients.publicClient.estimateFeesPerGas()
    ])
    if (bal < amount) {
        throw new NeedFundsError("usdc", `Your wallet has ${usdc(Number(bal))}, and this payment needs ${usdc(Number(amount))}. Get test USDC, then try again.`)
    }
    const need = TRANSFER_GAS * (fees.maxFeePerGas ?? 0n)
    if (mon === 0n || mon < need) {
        throw new NeedFundsError("gas", `This payment needs about ${mon3(need)} MON for gas, and your wallet has ${mon3(mon)}. Get test funds, then try again.`)
    }
}

// ------------------------------------------------------------------ sent but not recorded yet

// A sent payout is remembered until the server records it (or refuses it for good), so a reload or
// a lost connection leads to "check again" instead of paying the same person twice.
export type SentPayout = { restaurantId: string; wallet: Wallet; name: string; amount: number; note: string | null; txHash: Hash; at: number }

const sentKey = (d: Deployment) => `fairpay.teampay.${d.chainId}`
const HASH = /^0x[0-9a-fA-F]{64}$/
const WALLET = /^0x[0-9a-f]{40}$/

function loadSent(d: Deployment): SentPayout[] {
    try {
        const raw: unknown = JSON.parse(safeStorage.get(sentKey(d)) ?? "[]")
        if (!Array.isArray(raw)) return []
        return raw.filter(
            (p): p is SentPayout =>
                typeof p === "object" &&
                p !== null &&
                typeof p.restaurantId === "string" &&
                typeof p.wallet === "string" &&
                WALLET.test(p.wallet) &&
                typeof p.name === "string" &&
                Number.isSafeInteger(p.amount) &&
                p.amount > 0 &&
                (p.note === null || typeof p.note === "string") &&
                typeof p.txHash === "string" &&
                HASH.test(p.txHash) &&
                typeof p.at === "number"
        )
    } catch {
        return []
    }
}

function saveSent(d: Deployment, fn: (list: SentPayout[]) => SentPayout[]) {
    return safeStorage.set(sentKey(d), JSON.stringify(fn(loadSent(d))))
}

export const sentPayouts = (d: Deployment, restaurantId: string) => loadSent(d).filter((p) => p.restaurantId === restaurantId)
export const forgetSent = (d: Deployment, txHash: Hash) => saveSent(d, (l) => l.filter((p) => p.txHash.toLowerCase() !== txHash.toLowerCase()))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Asks the server to record a sent payout, again while the chain hasn't confirmed it. */
async function recordLoop(p: SentPayout): Promise<TeamPayout> {
    const body = { wallet: p.wallet, amount: p.amount, note: p.note, txHash: p.txHash }
    for (let i = 0; i < 45; i++) {
        let r: Awaited<ReturnType<typeof teamPayApi.record>> | null = null
        try {
            r = await teamPayApi.record(p.restaurantId, body)
        } catch (err) {
            // The server couldn't reach the chain, or we couldn't reach the server: the transfer is
            // still out there, so keep asking (it stays remembered).
            const transient = err instanceof ApiError && (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504)
            if (!transient || i === 44) throw err
        }
        if (r?.status === "recorded") return r.payout
        if (r?.status === "rejected") throw new PaymentRejectedError(r.reason)
        await sleep(2000)
    }
    throw new ApiError(504, "The payment was sent but is taking longer than usual to confirm.")
}

async function recordTracked(d: Deployment, p: SentPayout) {
    try {
        const payout = await recordLoop(p)
        forgetSent(d, p.txHash)
        return payout
    } catch (err) {
        // A final answer about this transaction: asking again won't change it.
        if (err instanceof PaymentRejectedError) forgetSent(d, p.txHash)
        if (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 409)) forgetSent(d, p.txHash)
        throw err
    }
}

/** Asks the server again about one remembered payout. */
export const retrySent = (d: Deployment, p: SentPayout) => recordTracked(d, p)

// ------------------------------------------------------------------ paying

/**
 * Pays `amount` micro-USDC from the connected wallet to a staff member with one ERC-20 transfer
 * (simulated first, gas close to the estimate), then waits for FairPay to verify and record it.
 * `onStep(index, detail?)` follows TEAM_PAY_STEPS. The caller makes sure the wallet is the owner's.
 */
export async function payStaff(
    d: Deployment,
    clients: Clients,
    p: { restaurantId: string; wallet: Wallet; name: string; amount: number; note: string | null },
    onStep: (index: number, detail?: string) => void
) {
    if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new Error("Enter an amount to pay.")
    onStep(0)
    const amount = BigInt(p.amount)
    await assertFunds(d, clients, amount)
    onStep(1, `Your wallet asks once: send ${usdc(p.amount)} to ${p.name}.`)
    const txHash = await sendSimulated(clients, {
        address: d.token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [getAddress(p.wallet), amount]
    })
    const sent: SentPayout = { ...p, txHash, at: Date.now() }
    saveSent(d, (l) => [...l.filter((x) => x.txHash !== txHash), sent])
    onStep(2, "Waiting for 2 confirmations, usually a few seconds.")
    return { payout: await recordTracked(d, sent), txHash }
}
