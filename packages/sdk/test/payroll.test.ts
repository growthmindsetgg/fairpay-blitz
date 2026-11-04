// FairPayroll helpers without a node: the hand-written ABI matches the compiled contract, and the
// write helpers refuse bad input before any wallet is asked to sign.
import { existsSync, readFileSync } from "node:fs"
import { formatAbiItem } from "viem/utils"
import { describe, expect, it } from "vitest"
import { approveShifts, fairPayrollAbi, FairPayError, PAY_PERIOD, payPeriodName, setPaySchedule, shiftIdFor, type Clients, type PayrollDeployment } from "../src/index.js"

const artifact = new URL("../../contracts/artifacts/contracts/FairPayroll.sol/FairPayroll.json", import.meta.url)

// Only the shape that matters on the wire: names, types, indexed flags, outputs and struct fields.
type Item = { type: string; name?: string; inputs?: { type: string; indexed?: boolean }[]; outputs?: { type: string; components?: { name: string; type: string }[] }[]; stateMutability?: string }
const sig = (x: Item) =>
    [x.type, formatAbiItem(x as never), JSON.stringify((x.inputs ?? []).map((i) => !!i.indexed)), JSON.stringify((x.outputs ?? []).map((o) => [o.type, o.components?.map((c) => `${c.name}:${c.type}`)])), x.stateMutability ?? ""].join(" | ")

const d: PayrollDeployment = {
    chainId: 10143,
    token: "0x00000000000000000000000000000000000000a1",
    fairPay: "0x00000000000000000000000000000000000000a2",
    payroll: "0x00000000000000000000000000000000000000a4"
}
// Any RPC use means validation let something through.
const noClients = new Proxy({}, { get: () => { throw new Error("no RPC expected") } }) as unknown as Clients
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const
const E = "0x00000000000000000000000000000000000000e1"

describe("FairPayroll ABI", () => {
    it.skipIf(!existsSync(artifact))("matches the compiled artifact (plus the token's two errors it bubbles up)", () => {
        const compiled = (JSON.parse(readFileSync(artifact, "utf8")).abi as Item[]).filter((x) => x.type !== "constructor")
        const ours = new Set((fairPayrollAbi as readonly Item[]).map(sig))
        const theirs = new Set(compiled.map(sig))
        expect([...theirs].filter((s) => !ours.has(s))).toEqual([])
        expect([...ours].filter((s) => !theirs.has(s)).map((s) => s.split(" | ")[1])).toEqual([
            "ERC20InsufficientAllowance(address,uint256,uint256)",
            "ERC20InsufficientBalance(address,uint256,uint256)"
        ])
    })
})

describe("payroll helpers", () => {
    it("names periods and derives shift ids", () => {
        expect(payPeriodName(86_400n)).toBe("day")
        expect(payPeriodName(PAY_PERIOD.month)).toBe("month")
        expect(payPeriodName(31n * 86_400n)).toBeNull()
        expect(shiftIdFor("ps_abcdefgh")).toBe(shiftIdFor("ps_abcdefgh"))
        expect(shiftIdFor("ps_abcdefgh")).not.toBe(shiftIdFor("ps_abcdefgi"))
        expect(() => shiftIdFor("short")).toThrow(FairPayError)
    })

    it("refuses bad shift batches before asking the wallet", async () => {
        await expect(approveShifts(d, noClients, [])).rejects.toThrow(/no shifts/)
        const many = Array.from({ length: 51 }, (_, i) => ({ employee: E as `0x${string}`, shiftId: id(i + 1), amount: 1n }))
        await expect(approveShifts(d, noClients, many)).rejects.toThrow(/at most 50/)
        await expect(approveShifts(d, noClients, [{ employee: E, shiftId: id(1), amount: 1n }, { employee: E, shiftId: id(1), amount: 2n }])).rejects.toThrow(/twice/)
        await expect(approveShifts(d, noClients, [{ employee: E, shiftId: id(0), amount: 1n }])).rejects.toThrow(/non-zero/)
        await expect(approveShifts(d, noClients, [{ employee: E, shiftId: id(1), amount: 0n }])).rejects.toThrow(/positive/)
        await expect(approveShifts(d, noClients, [{ employee: d.payroll, shiftId: id(1), amount: 1n }])).rejects.toThrow(/payroll contract/)
    })

    it("refuses bad schedules before asking the wallet", async () => {
        await expect(setPaySchedule(d, noClients, { employee: E, amountPerPeriod: 1n, period: 3600n })).rejects.toThrow(/period/)
        await expect(setPaySchedule(d, noClients, { employee: E, amountPerPeriod: 0n, period: "week" })).rejects.toThrow(/out of range/)
        await expect(setPaySchedule(d, noClients, { employee: "0x0000000000000000000000000000000000000000", amountPerPeriod: 1n, period: "day" })).rejects.toThrow(/zero address/)
    })
})
