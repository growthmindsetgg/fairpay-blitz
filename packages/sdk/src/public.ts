import { getAddress, isAddress, type Address, type Hash, type Hex } from "viem"
import { erc20Abi, fairPayAbi } from "./abi.js"
import { assertChain, sendSimulated, waitForSent, type Clients } from "./chain.js"
import { FairPayError, type FairPayDeployment } from "./config.js"

/**
 * Public payment: transfers `amount` from the connected wallet to `merchant` through FairPay,
 * tagged with `orderRef`. Approves only the exact amount, never an unlimited allowance.
 */
export async function payPublic(
    deployment: FairPayDeployment,
    clients: Clients,
    params: { merchant: Address; amount: bigint; orderRef: Hex }
): Promise<{ txHash: Hash }> {
    const { amount, orderRef } = params
    if (!isAddress(params.merchant)) throw new FairPayError("INVALID_INPUT", "merchant is not an address")
    if (amount <= 0n) throw new FairPayError("INVALID_INPUT", "amount must be positive")
    // Checked before the approval: FairPay would reject these only after the payer had already
    // paid gas for an approve transaction.
    if (typeof orderRef !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(orderRef) || BigInt(orderRef) === 0n) {
        throw new FairPayError("INVALID_INPUT", "orderRef must be a non-zero bytes32")
    }
    const merchant = getAddress(params.merchant)
    if (merchant === getAddress(deployment.fairPay)) throw new FairPayError("INVALID_INPUT", "merchant cannot be the FairPay contract")
    await assertChain(deployment, clients)

    const owner = clients.walletClient.account.address
    const allowance = await clients.publicClient.readContract({
        address: deployment.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, deployment.fairPay]
    })
    if (allowance < amount) {
        const approveHash = await sendSimulated(clients, {
            address: deployment.token,
            abi: erc20Abi,
            functionName: "approve",
            args: [deployment.fairPay, amount]
        })
        await waitForSent(clients, approveHash)
    }

    const txHash = await sendSimulated(clients, {
        address: deployment.fairPay,
        abi: fairPayAbi,
        functionName: "directPay",
        args: [merchant, amount, orderRef]
    })
    return { txHash }
}
