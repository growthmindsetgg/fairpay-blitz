// Payments are only credited once they have enough confirmations. These tests run the
// real createChain + SDK verifyPaymentTx against a tiny fake JSON-RPC server on localhost, so they
// check what the server actually asks the chain, without any network.

import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChain, paymentConfirmations } from "../server/chain.js"
import { TEST_DEPLOYMENT, txHash } from "./helpers.js"

const BLOCK_HASH = `0x${"b".repeat(64)}`
const hex = (n: number) => `0x${n.toString(16)}`

let server: Server
let url = ""
/** The chain's head; the payment is mined in block 100. */
let head = 100

beforeAll(async () => {
    server = createServer((req, res) => {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
            const calls = JSON.parse(body) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[]
            const answer = (call: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: call.id, result: rpc(call.method, call.params) })
            res.setHeader("content-type", "application/json")
            res.end(JSON.stringify(Array.isArray(calls) ? calls.map(answer) : answer(calls)))
        })
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

function rpc(method: string, params: unknown[]): unknown {
    switch (method) {
        case "eth_chainId":
            return hex(TEST_DEPLOYMENT.chainId)
        case "eth_blockNumber":
            return hex(head)
        case "eth_getTransactionReceipt":
            return {
                transactionHash: params[0],
                transactionIndex: "0x0",
                blockHash: BLOCK_HASH,
                blockNumber: hex(100),
                from: `0x${"1".repeat(40)}`,
                to: TEST_DEPLOYMENT.fairPay,
                cumulativeGasUsed: "0x5208",
                gasUsed: "0x5208",
                effectiveGasPrice: "0x1",
                contractAddress: null,
                logs: [],
                logsBloom: `0x${"0".repeat(512)}`,
                status: "0x1",
                type: "0x2"
            }
        case "eth_getBlockByNumber":
            return {
                hash: BLOCK_HASH,
                number: hex(100),
                parentHash: `0x${"a".repeat(64)}`,
                timestamp: "0x1",
                gasLimit: "0x1",
                gasUsed: "0x0",
                baseFeePerGas: "0x1",
                transactions: [],
                uncles: []
            }
        default:
            throw new Error(`unexpected RPC call ${method}`)
    }
}

const params = () => ({
    txHash: txHash(),
    orderRef: `0x${"c".repeat(64)}` as `0x${string}`,
    merchant: "0x5555555555555555555555555555555555555555" as `0x${string}`,
    amount: 5_000_000n
})

describe("payment confirmations", () => {
    it("waits for 2 confirmations on Monad testnet, none on a local chain, and can be configured", () => {
        expect(paymentConfirmations({}, 10143)).toBe(2n)
        expect(paymentConfirmations({}, 31337)).toBe(0n)
        expect(paymentConfirmations({ PAYMENT_CONFIRMATIONS: "5" }, 10143)).toBe(5n)
        expect(paymentConfirmations({ PAYMENT_CONFIRMATIONS: " " }, 10143)).toBe(2n)
        expect(() => paymentConfirmations({ PAYMENT_CONFIRMATIONS: "two" }, 10143)).toThrow(/whole number/)
    })

    it("answers pending for a payment in the newest block, and checks it once one more block is on top", async () => {
        const { chain } = createChain({ deployment: TEST_DEPLOYMENT, rpcUrl: url, minConfirmations: 2n })
        head = 100
        expect(await chain.verify(params())).toEqual({ status: "pending", confirmations: 1n })
        head = 101
        // Confirmed: now the receipt itself is checked (this fake one carries no payment).
        expect(await chain.verify(params())).toEqual({ status: "rejected", reason: "no matching PaymentReceived event" })
    })

    it("defaults to 2 confirmations when none are given", async () => {
        const { chain } = createChain({ deployment: TEST_DEPLOYMENT, rpcUrl: url })
        head = 100
        expect((await chain.verify(params())).status).toBe("pending")
    })
})
