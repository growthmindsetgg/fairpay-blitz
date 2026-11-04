// Withdrawals without a node: the message matches FairPool's abi.encode(recipient, WITHDRAW_REF),
// the hand-written ABI matches the compiled contract once it has `withdraw`, support detection
// tells an old pool from a network error, and bad input is refused before any RPC call.
import { existsSync, readFileSync } from "node:fs"
import {
    createPublicClient,
    custom,
    decodeFunctionData,
    encodeAbiParameters,
    encodeFunctionResult,
    keccak256,
    toHex,
    zeroAddress,
    type Address,
    type Hex,
    type PublicClient
} from "viem"
import { monadTestnet } from "viem/chains"
import { formatAbiItem } from "viem/utils"
import { describe, expect, it } from "vitest"
import {
    createNote,
    createWithdrawal,
    fairPoolAbi,
    FairPayError,
    poolSupportsWithdraw,
    withdrawMessage,
    withdrawNote,
    WITHDRAW_REF,
    type Clients,
    type FairPayDeployment
} from "../src/index.js"

const POOL: Address = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0"
const USER: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
const deployment: FairPayDeployment = {
    chainId: monadTestnet.id,
    token: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    fairPay: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    pool: POOL,
    poolDeployBlock: 0n
}
// Any RPC use means validation let something through.
const noRpc = new Proxy({}, { get: () => { throw new Error("no RPC expected") } }) as unknown as PublicClient
const noWallet = noRpc as unknown as Clients["walletClient"]

/** A public client whose node runs `call` for every eth_call. */
function node(call: (functionName: string, args: readonly unknown[]) => unknown) {
    const request = async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === "eth_chainId") return toHex(monadTestnet.id)
        if (method !== "eth_call") throw new Error(`unexpected ${method}`)
        const [tx] = params as [{ data: Hex }]
        const { functionName, args } = decodeFunctionData({ abi: fairPoolAbi, data: tx.data })
        const result = call(functionName, args ?? [])
        return encodeFunctionResult({ abi: fairPoolAbi, functionName, result } as never)
    }
    return createPublicClient({ chain: monadTestnet, transport: custom({ request }), pollingInterval: 5 }) as PublicClient
}
// What a node answers for a function the contract doesn't have: an empty revert.
const reverts = () => {
    throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" })
}

describe("withdraw message", () => {
    it("WITHDRAW_REF is keccak256(\"FairPool.withdraw\")", () => {
        expect(WITHDRAW_REF).toBe(keccak256(toHex("FairPool.withdraw")))
    })

    it("equals uint256(keccak256(abi.encode(recipient, WITHDRAW_REF)))", () => {
        const expected = BigInt(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [USER, WITHDRAW_REF])))
        expect(withdrawMessage(USER)).toBe(expected)
        // Checksum or not, the same address gives the same message.
        expect(withdrawMessage(USER.toLowerCase() as Address)).toBe(expected)
        expect(withdrawMessage("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC")).not.toBe(expected)
    })

    it("refuses something that isn't a usable address", () => {
        expect(() => withdrawMessage("0x1234" as Address)).toThrow(FairPayError)
        expect(() => withdrawMessage("not an address" as Address)).toThrow(/not an address/)
        expect(() => withdrawMessage(zeroAddress)).toThrow(/zero address/)
    })
})

const artifact = new URL("../../contracts/artifacts/contracts/FairPool.sol/FairPool.json", import.meta.url)
const compiledPool = existsSync(artifact) ? (JSON.parse(readFileSync(artifact, "utf8")).abi as { type: string; name?: string }[]) : []
const hasWithdraw = compiledPool.some((x) => x.type === "function" && x.name === "withdraw")

describe("FairPool ABI", () => {
    it.skipIf(!hasWithdraw)("withdraw, withdrawMessage, WITHDRAW_REF, Withdrawal and ZeroRecipient match the compiled contract", () => {
        const names = new Set(["withdraw", "withdrawMessage", "WITHDRAW_REF", "Withdrawal", "ZeroRecipient"])
        const sig = (x: unknown) => formatAbiItem(x as never)
        const theirs = compiledPool.filter((x) => x.name && names.has(x.name)).map(sig).sort()
        const ours = (fairPoolAbi as readonly { name?: string }[]).filter((x) => x.name && names.has(x.name)).map(sig).sort()
        expect(ours).toEqual(theirs)
    })
})

describe("poolSupportsWithdraw", () => {
    it("is true for a pool that answers WITHDRAW_REF", async () => {
        expect(await poolSupportsWithdraw(deployment, node(() => WITHDRAW_REF))).toBe(true)
    })

    it("is false for a pool deployed before withdrawals (the call reverts) or a different constant", async () => {
        expect(await poolSupportsWithdraw(deployment, node(reverts))).toBe(false)
        expect(await poolSupportsWithdraw(deployment, node(() => keccak256(toHex("something else"))))).toBe(false)
    })

    it("throws on a network failure instead of calling the pool old", async () => {
        const down = createPublicClient({
            chain: monadTestnet,
            transport: custom({ request: async () => { throw new Error("fetch failed") } }),
            pollingInterval: 5
        }) as PublicClient
        await expect(poolSupportsWithdraw(deployment, down)).rejects.toThrow()
    })

    it("needs a pool", async () => {
        await expect(poolSupportsWithdraw({ ...deployment, pool: undefined }, noRpc)).rejects.toThrow(/no private pool/)
    })
})

describe("withdrawing a note", () => {
    const note = createNote(deployment)

    it("refuses a bad recipient or a note for another pool before any RPC call", async () => {
        const base = { walletClient: noWallet, publicClient: noRpc, deployment, note }
        await expect(withdrawNote({ ...base, recipient: "0x1234" as Address })).rejects.toThrow(/not an address/)
        await expect(withdrawNote({ ...base, recipient: zeroAddress })).rejects.toThrow(/zero address/)
        await expect(withdrawNote({ ...base, recipient: POOL })).rejects.toThrow(/can't be the pool/)
        const foreign = createNote({ ...deployment, pool: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9" })
        await expect(withdrawNote({ ...base, note: foreign, recipient: USER })).rejects.toThrow(/different pool/)
        await expect(withdrawNote({ ...base, deployment: { ...deployment, pool: undefined }, recipient: USER })).rejects.toThrow(/no private pool/)
        await expect(createWithdrawal(deployment, noRpc, { note, recipient: zeroAddress })).rejects.toThrow(FairPayError)
    })

    it("says NO_WITHDRAW for a pool deployed before withdrawals, before building a proof", async () => {
        const old = node((fn) => (fn === "SCOPE" ? 1n : reverts()))
        await expect(createWithdrawal(deployment, old, { note, recipient: USER })).rejects.toMatchObject({ code: "NO_WITHDRAW" })
    })

    it("refuses when the pool's message encoding differs from the SDK's", async () => {
        const odd = node((fn) => (fn === "SCOPE" ? 1n : fn === "withdrawMessage" ? 42n : reverts()))
        await expect(createWithdrawal(deployment, odd, { note, recipient: USER })).rejects.toThrow(/message encoding differs/)
    })

    it("checks the message the pool computes for this recipient", async () => {
        const seen: unknown[] = []
        const good = node((fn, args) => {
            if (fn === "SCOPE") return 1n
            if (fn === "withdrawMessage") {
                seen.push(args[0])
                return withdrawMessage(args[0] as Address)
            }
            return reverts()
        })
        // An empty group: the encoding check passes, then the note is not in the pool.
        const { Group } = await import("@semaphore-protocol/group")
        await expect(createWithdrawal(deployment, good, { note, recipient: USER.toLowerCase() as Address, group: new Group([]) })).rejects.toMatchObject({
            code: "NOTE_NOT_FOUND"
        })
        expect(seen).toEqual([USER])
    })
})
