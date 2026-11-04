import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { Clients, FairPayDeployment } from "@fairpay/sdk"
import { erc20Abi } from "@fairpay/sdk"
import {
    createPublicClient,
    createWalletClient,
    custom,
    defineChain,
    getAddress,
    http,
    type Address,
    type Chain,
    type EIP1193Provider,
    type PublicClient
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { createSiweMessage } from "viem/siwe"
import type { Me, PublicConfig, Wallet } from "../../shared/types"
import { api } from "./api"

declare global {
    interface Window {
        ethereum?: EIP1193Provider
    }
}

// ------------------------------------------------------------------ storage that never throws

export const safeStorage = {
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

// ------------------------------------------------------------------ wallet discovery (EIP-6963)

export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string }
export type InjectedWallet = { info: WalletInfo; provider: EIP1193Provider }
export type WalletChoice = InjectedWallet | "test"

export type ConnectedWallet = {
    kind: "test" | "injected"
    address: Address
    /** Shown in the account menu, e.g. "MetaMask" or "Test wallet". */
    name: string
    rdns: string | null
    clients: Clients
    provider: EIP1193Provider | null
}

export type Deployment = FairPayDeployment & { pool: Address; denomination: bigint }

type Ctx = {
    cfg: PublicConfig
    chain: Chain
    deployment: Deployment
    publicClient: PublicClient
    /** Wallets found in this browser. Empty when none is installed. */
    injected: InjectedWallet[]
    wallet: ConnectedWallet | null
    balances: { mon: bigint; usdc: bigint } | null
    refreshBalances: () => Promise<void>
    connect: (choice: WalletChoice) => Promise<ConnectedWallet>
    disconnect: () => void
    /** Asks an injected wallet to switch to (or add) Monad Testnet. No-op for the test wallet. */
    ensureChain: (w?: ConnectedWallet | null) => Promise<void>
    // session
    me: Me | null
    meLoading: boolean
    refreshMe: () => Promise<Me | null>
    signIn: (w?: ConnectedWallet | null) => Promise<Me>
    signOut: () => Promise<void>
    /** True when the connected wallet is not the one the session belongs to. */
    mismatch: boolean
    // picker
    pickerOpen: boolean
    pickerOptions: { signIn: boolean; reason?: string }
    /** Opens the wallet picker. Resolves with the wallet once connected (and signed in when asked), or null if closed. */
    requestConnect: (opts?: { signIn?: boolean; reason?: string }) => Promise<ConnectedWallet | null>
    resolvePicker: (w: ConnectedWallet | null) => void
    faucet: () => Promise<string>
}

const WalletContext = createContext<Ctx | null>(null)
const TEST_KEY = "fairpay.testWalletKey"
const MODE_KEY = "fairpay.walletMode"
let memoryTestKey: string | null = null

function readMode(): { kind: "test" } | { kind: "injected"; rdns: string } | null {
    try {
        const v = JSON.parse(safeStorage.get(MODE_KEY) ?? "null") as { kind?: string; rdns?: unknown } | null
        if (v?.kind === "test") return { kind: "test" }
        if (v?.kind === "injected" && typeof v.rdns === "string") return { kind: "injected", rdns: v.rdns }
    } catch {
        /* ignore */
    }
    return null
}

/** Listens for EIP-6963 announcements; falls back to window.ethereum when nothing announces. */
function useInjectedWallets() {
    const [found, setFound] = useState<InjectedWallet[]>([])
    const [settled, setSettled] = useState(false)
    useEffect(() => {
        const seen = new Map<string, InjectedWallet>()
        const onAnnounce = (e: Event) => {
            const detail = (e as CustomEvent<{ info?: WalletInfo; provider?: EIP1193Provider }>).detail
            if (!detail?.info?.uuid || !detail.provider) return
            const info: WalletInfo = {
                uuid: String(detail.info.uuid),
                name: String(detail.info.name || "Browser wallet").slice(0, 40),
                // Only inline images: an icon URL would be a third-party request.
                icon: typeof detail.info.icon === "string" && detail.info.icon.startsWith("data:image/") ? detail.info.icon : "",
                rdns: String(detail.info.rdns || detail.info.uuid)
            }
            seen.set(info.rdns, { info, provider: detail.provider })
            setFound([...seen.values()])
        }
        window.addEventListener("eip6963:announceProvider", onAnnounce)
        window.dispatchEvent(new Event("eip6963:requestProvider"))
        const t = setTimeout(() => {
            if (seen.size === 0 && window.ethereum) {
                setFound([{ info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" }, provider: window.ethereum }])
            }
            setSettled(true)
        }, 400)
        return () => {
            window.removeEventListener("eip6963:announceProvider", onAnnounce)
            clearTimeout(t)
        }
    }, [])
    return { injected: found, settled }
}

export function WalletProvider({ cfg, children }: { cfg: PublicConfig; children: ReactNode }) {
    const chain = useMemo(
        () =>
            defineChain({
                id: cfg.chainId,
                name: cfg.chainName || "Monad Testnet",
                nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
                rpcUrls: { default: { http: [cfg.rpcUrl] } },
                blockExplorers: { default: { name: "Monad Explorer", url: cfg.explorer } }
            }),
        [cfg]
    )
    const publicClient = useMemo(() => createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient, [chain, cfg])
    const deployment = useMemo<Deployment>(
        () => ({
            chainId: cfg.chainId,
            token: cfg.token,
            fairPay: cfg.fairPay,
            pool: cfg.pool,
            poolDeployBlock: BigInt(cfg.poolDeployBlock || "0"),
            ...(cfg.batcher ? { batcher: cfg.batcher } : {}),
            ...(cfg.payroll ? { payroll: cfg.payroll } : {}),
            denomination: BigInt(cfg.denomination)
        }),
        [cfg]
    )
    const { injected, settled } = useInjectedWallets()
    const [wallet, setWallet] = useState<ConnectedWallet | null>(null)
    const [balances, setBalances] = useState<Ctx["balances"]>(null)
    const [me, setMe] = useState<Me | null>(null)
    const [meLoading, setMeLoading] = useState(true)

    // ---------------------------------------------------------------- session

    const refreshMe = useCallback(async () => {
        try {
            const m = await api.me()
            setMe(m)
            return m
        } finally {
            setMeLoading(false)
        }
    }, [])

    useEffect(() => {
        void refreshMe().catch(() => setMe(null))
    }, [refreshMe])

    // ---------------------------------------------------------------- wallets

    const injectedWallet = useCallback(
        (w: InjectedWallet, address: Address): ConnectedWallet => {
            const walletClient = createWalletClient({ account: address, chain, transport: custom(w.provider) })
            return {
                kind: "injected",
                address: getAddress(address),
                name: w.info.name,
                rdns: w.info.rdns,
                clients: { publicClient, walletClient: walletClient as Clients["walletClient"] },
                provider: w.provider
            }
        },
        [chain, publicClient]
    )

    const testWallet = useCallback((): ConnectedWallet => {
        let key = (safeStorage.get(TEST_KEY) ?? memoryTestKey) as `0x${string}` | null
        if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
            key = generatePrivateKey()
            // Without storage the key lives in memory, so the address stays the same until reload.
            if (!safeStorage.set(TEST_KEY, key)) memoryTestKey = key
        }
        const account = privateKeyToAccount(key)
        const walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) })
        return { kind: "test", address: account.address, name: "Test wallet", rdns: null, clients: { publicClient, walletClient }, provider: null }
    }, [chain, cfg, publicClient])

    const ensureChain = useCallback(
        async (w: ConnectedWallet | null = wallet) => {
            if (!w || w.kind !== "injected" || !w.provider) return
            const hexId = `0x${cfg.chainId.toString(16)}` as const
            const current = (await w.provider.request({ method: "eth_chainId" }).catch(() => null)) as string | null
            if (current && parseInt(current, 16) === cfg.chainId) return
            try {
                await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] })
            } catch (err) {
                const code = (err as { code?: number; data?: { originalError?: { code?: number } } }).code
                const inner = (err as { data?: { originalError?: { code?: number } } }).data?.originalError?.code
                if (code !== 4902 && inner !== 4902) throw err
                await w.provider.request({
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
        },
        [cfg, wallet]
    )

    const connect = useCallback(
        async (choice: WalletChoice) => {
            if (choice === "test") {
                const w = testWallet()
                safeStorage.set(MODE_KEY, JSON.stringify({ kind: "test" }))
                setBalances(null)
                setWallet(w)
                return w
            }
            const accounts = (await choice.provider.request({ method: "eth_requestAccounts" })) as Address[]
            const address = accounts?.[0]
            if (!address) throw new Error("The wallet did not share an account.")
            const w = injectedWallet(choice, address)
            // Sign-in works on any network; payments check again before sending.
            await ensureChain(w).catch(() => undefined)
            safeStorage.set(MODE_KEY, JSON.stringify({ kind: "injected", rdns: choice.info.rdns }))
            setBalances(null)
            setWallet(w)
            return w
        },
        [testWallet, injectedWallet, ensureChain]
    )

    const disconnect = useCallback(() => {
        safeStorage.remove(MODE_KEY)
        setWallet(null)
        setBalances(null)
    }, [])

    // Restore the last choice. An injected wallet is reconnected silently only if it already granted access.
    const restored = useRef(false)
    useEffect(() => {
        if (restored.current || !settled) return
        restored.current = true
        const mode = readMode()
        if (mode?.kind === "test") {
            setWallet(testWallet())
            return
        }
        if (mode?.kind === "injected") {
            const found = injected.find((w) => w.info.rdns === mode.rdns) ?? (injected.length === 1 ? injected[0] : undefined)
            if (!found) return
            found.provider
                .request({ method: "eth_accounts" })
                .then((accts) => {
                    const a = (accts as Address[])[0]
                    if (a) setWallet(injectedWallet(found, a))
                })
                .catch(() => undefined)
        }
    }, [settled, injected, testWallet, injectedWallet])

    // A browser wallet can switch account at any time; never keep acting for the old one.
    useEffect(() => {
        const eth = wallet?.provider
        if (!wallet || wallet.kind !== "injected" || !eth?.on) return
        const onAccounts = (accts: unknown) => {
            const next = Array.isArray(accts) ? (accts[0] as Address | undefined) : undefined
            if (!next) {
                disconnect()
                return
            }
            if (next.toLowerCase() === wallet.address.toLowerCase()) return
            const found = injected.find((w) => w.info.rdns === wallet.rdns)
            if (found) {
                setBalances(null)
                setWallet(injectedWallet(found, next))
            }
        }
        eth.on("accountsChanged", onAccounts as never)
        return () => {
            eth.removeListener?.("accountsChanged", onAccounts as never)
        }
    }, [wallet, injected, injectedWallet, disconnect])

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

    useEffect(() => {
        void refreshBalances().catch(() => undefined)
    }, [refreshBalances])

    // ---------------------------------------------------------------- sign-in (SIWE, EIP-4361)

    const signIn = useCallback(
        async (w: ConnectedWallet | null = wallet) => {
            if (!w) throw new Error("Connect a wallet first.")
            const { nonce } = await api.nonce()
            const message = createSiweMessage({
                address: getAddress(w.address),
                chainId: cfg.chainId,
                domain: window.location.host,
                uri: window.location.origin,
                nonce,
                version: "1",
                issuedAt: new Date(),
                statement: "Sign in to FairPay. Signing is free and sends no transaction."
            })
            const signature = await w.clients.walletClient.signMessage({ account: w.clients.walletClient.account, message })
            const m = await api.verify(message, signature)
            setMe(m)
            setMeLoading(false)
            return m
        },
        [cfg, wallet]
    )

    const signOut = useCallback(async () => {
        try {
            await api.logout()
        } finally {
            setMe(null)
        }
    }, [])

    const mismatch = !!(me && wallet && me.profile.wallet.toLowerCase() !== wallet.address.toLowerCase())

    // ---------------------------------------------------------------- picker

    const [pickerOpen, setPickerOpen] = useState(false)
    const [pickerOptions, setPickerOptions] = useState<Ctx["pickerOptions"]>({ signIn: true })
    const pickerResolve = useRef<((w: ConnectedWallet | null) => void) | null>(null)

    const requestConnect = useCallback((opts: { signIn?: boolean; reason?: string } = {}) => {
        pickerResolve.current?.(null)
        setPickerOptions({ signIn: opts.signIn ?? true, reason: opts.reason })
        setPickerOpen(true)
        return new Promise<ConnectedWallet | null>((resolve) => {
            pickerResolve.current = resolve
        })
    }, [])

    const resolvePicker = useCallback((w: ConnectedWallet | null) => {
        setPickerOpen(false)
        const r = pickerResolve.current
        pickerResolve.current = null
        r?.(w)
    }, [])

    const faucet = useCallback(async () => {
        if (!wallet) throw new Error("Connect a wallet first.")
        const r = await api.faucet(wallet.address.toLowerCase() as Wallet)
        void refreshBalances().catch(() => undefined)
        // Mints take a moment to land; refresh again shortly.
        setTimeout(() => void refreshBalances().catch(() => undefined), 4000)
        const parts = [r?.minted ? `${r.minted} test USDC` : "test USDC", r?.gasSent && Number(r.gasSent) > 0 ? `${r.gasSent} MON for gas` : ""]
        return `Sent ${parts.filter(Boolean).join(" and ")} to your wallet. It can take a few seconds to show.`
    }, [wallet, refreshBalances])

    const value: Ctx = {
        cfg,
        chain,
        deployment,
        publicClient,
        injected,
        wallet,
        balances,
        refreshBalances,
        connect,
        disconnect,
        ensureChain,
        me,
        meLoading,
        refreshMe,
        signIn,
        signOut,
        mismatch,
        pickerOpen,
        pickerOptions,
        requestConnect,
        resolvePicker,
        faucet
    }
    return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet() {
    const ctx = useContext(WalletContext)
    if (!ctx) throw new Error("useWallet outside WalletProvider")
    return ctx
}

/** The signed-in user, or null when signed out (also null while the session is loading). */
export function useMe(): Me | null {
    return useWallet().me
}

/** Session state with loading flag and actions, for pages that gate on sign-in. */
export function useSession() {
    const { me, meLoading, refreshMe, signIn, signOut, requestConnect, mismatch } = useWallet()
    return { me, loading: meLoading, refresh: refreshMe, signIn, signOut, requestConnect, mismatch }
}

/** Lowercase wallet of the session, for comparing with API data (which is lowercase). */
export const sameWallet = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
