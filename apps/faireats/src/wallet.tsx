import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Clients, FairPayDeployment } from "@fairpay/sdk"
import { erc20Abi } from "@fairpay/sdk"
import {
    createPublicClient,
    createWalletClient,
    custom,
    defineChain,
    http,
    type Address,
    type EIP1193Provider,
    type PublicClient
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { api, type PublicConfig } from "./api"

// The static demo build swaps in a simulated wallet and chain. Constant `undefined` in the real build.
const demo = import.meta.env.VITE_DEMO === "1" ? await import("./demo") : undefined

declare global {
    interface Window {
        ethereum?: EIP1193Provider
    }
}

type Wallet = { kind: "demo" | "browser"; address: Address; clients: Clients }

type Ctx = {
    cfg: PublicConfig
    deployment: FairPayDeployment
    publicClient: PublicClient
    wallet: Wallet | null
    balances: { mon: bigint; usdc: bigint } | null
    chooseDemoWallet: () => Wallet
    connectBrowserWallet: () => Promise<Wallet>
    disconnect: () => void
    refreshBalances: () => Promise<void>
}

const WalletContext = createContext<Ctx | null>(null)
const DEMO_KEY = "faireats.demoKey"
const MODE_KEY = "faireats.walletMode"
let memoryDemoKey: string | null = null

const safeStorage = {
    get: (k: string) => {
        try {
            return localStorage.getItem(k)
        } catch {
            return null
        }
    },
    /** False when the browser refused to store the value (blocked site data, quota). */
    set: (k: string, v: string) => {
        try {
            localStorage.setItem(k, v)
            return true
        } catch {
            return false
        }
    },
    remove: (k: string) => {
        try {
            localStorage.removeItem(k)
        } catch {
            /* ignore */
        }
    }
}
export { safeStorage }

export function WalletProvider({ cfg, children }: { cfg: PublicConfig; children: ReactNode }) {
    const chain = useMemo(
        () =>
            defineChain({
                id: cfg.chainId,
                name: "Monad Testnet",
                nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
                rpcUrls: { default: { http: [cfg.rpcUrl] } },
                blockExplorers: { default: { name: "Monad Explorer", url: cfg.explorer } }
            }),
        [cfg]
    )
    const publicClient = useMemo(
        () => (demo ? demo.publicClient : (createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient)),
        [chain, cfg]
    )
    const deployment = useMemo<FairPayDeployment>(
        () => ({
            chainId: cfg.chainId,
            token: cfg.token,
            fairPay: cfg.fairPay,
            pool: cfg.pool,
            poolDeployBlock: BigInt(cfg.poolDeployBlock)
        }),
        [cfg]
    )
    const [wallet, setWallet] = useState<Wallet | null>(null)
    const [balances, setBalances] = useState<Ctx["balances"]>(null)

    const demoWallet = useCallback((): Wallet => {
        // The demo's wallet is simulated: a fixed fake address and no key.
        if (demo) return demo.demoWallet()
        let key = (safeStorage.get(DEMO_KEY) ?? memoryDemoKey) as `0x${string}` | null
        if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
            key = generatePrivateKey()
            // Without storage the key lives in memory, so the address at least stays the same until reload.
            if (!safeStorage.set(DEMO_KEY, key)) memoryDemoKey = key
        }
        const account = privateKeyToAccount(key)
        const walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) })
        return { kind: "demo", address: account.address, clients: { publicClient, walletClient } }
    }, [chain, cfg, publicClient])

    const chooseDemoWallet = useCallback(() => {
        const w = demoWallet()
        safeStorage.set(MODE_KEY, "demo")
        setWallet(w)
        return w
    }, [demoWallet])

    const connectBrowserWallet = useCallback(async () => {
        if (demo) throw new Error(demo.BROWSER_WALLET_OFF)
        const eth = window.ethereum
        if (!eth) throw new Error("No browser wallet found. Install one, or use the demo wallet.")
        const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Address[]
        if (!address) throw new Error("The wallet did not share an account.")
        const hexId = `0x${cfg.chainId.toString(16)}` as const
        try {
            await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] })
        } catch (err) {
            if ((err as { code?: number }).code !== 4902) throw err
            await eth.request({
                method: "wallet_addEthereumChain",
                params: [
                    {
                        chainId: hexId,
                        chainName: "Monad Testnet",
                        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
                        rpcUrls: [cfg.rpcUrl],
                        blockExplorerUrls: [cfg.explorer]
                    }
                ]
            })
        }
        const walletClient = createWalletClient({ account: address, chain, transport: custom(eth) })
        const w: Wallet = { kind: "browser", address, clients: { publicClient, walletClient: walletClient as Clients["walletClient"] } }
        safeStorage.set(MODE_KEY, "browser")
        setWallet(w)
        return w
    }, [chain, cfg, publicClient])

    const disconnect = useCallback(() => {
        safeStorage.remove(MODE_KEY)
        setWallet(null)
        setBalances(null)
    }, [])

    // Balances that arrive after the wallet changed belong to the old wallet and are dropped.
    const current = useRef<Address | null>(null)
    current.current = wallet?.address ?? null

    const refreshBalances = useCallback(async () => {
        if (!wallet) return
        const address = wallet.address
        const [mon, usdc] = await Promise.all([
            publicClient.getBalance({ address }),
            publicClient.readContract({ address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [address] })
        ])
        if (current.current === address) setBalances({ mon, usdc })
    }, [wallet, publicClient, cfg])

    // A browser wallet can switch account or network at any time; never keep acting for the old one.
    useEffect(() => {
        const eth = window.ethereum
        if (wallet?.kind !== "browser" || !eth?.on) return
        const onAccounts = (accts: unknown) => {
            const next = Array.isArray(accts) ? (accts[0] as Address | undefined) : undefined
            if (!next) {
                disconnect()
                return
            }
            if (next.toLowerCase() === wallet.address.toLowerCase()) return
            setBalances(null)
            const walletClient = createWalletClient({ account: next, chain, transport: custom(eth) })
            setWallet({ kind: "browser", address: next, clients: { publicClient, walletClient: walletClient as Clients["walletClient"] } })
        }
        const onChain = () => void refreshBalances().catch(() => undefined)
        eth.on("accountsChanged", onAccounts as never)
        eth.on("chainChanged", onChain as never)
        return () => {
            eth.removeListener?.("accountsChanged", onAccounts as never)
            eth.removeListener?.("chainChanged", onChain as never)
        }
    }, [wallet, chain, publicClient, disconnect, refreshBalances])

    // Restore the last choice. A browser wallet is only reconnected silently if it already granted access.
    useEffect(() => {
        const mode = safeStorage.get(MODE_KEY)
        // The demo starts with its simulated wallet already chosen.
        if (mode === "demo" || (demo && mode === null)) setWallet(demoWallet())
        if (mode === "browser" && window.ethereum) {
            window.ethereum
                .request({ method: "eth_accounts" })
                .then((accts) => {
                    if ((accts as Address[]).length) void connectBrowserWallet().catch(() => undefined)
                })
                .catch(() => undefined)
        }
    }, [demoWallet, connectBrowserWallet])

    useEffect(() => {
        void refreshBalances().catch(() => undefined)
    }, [refreshBalances])

    const value: Ctx = {
        cfg,
        deployment,
        publicClient,
        wallet,
        balances,
        chooseDemoWallet,
        connectBrowserWallet,
        disconnect,
        refreshBalances
    }
    return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet() {
    const ctx = useContext(WalletContext)
    if (!ctx) throw new Error("useWallet outside WalletProvider")
    return ctx
}

export async function loadConfig() {
    return api.config()
}
