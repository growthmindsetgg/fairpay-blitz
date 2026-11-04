// Typed client for the FairPay server (PLATFORM.md, "API"). Every request carries the session
// cookie; every mutation carries `x-fairpay: 1`, which the server requires to block CSRF.

import type {
    ActivityItem,
    Bill,
    BillSummary,
    Chef,
    CreateBillInput,
    CreateOrderInput,
    Friend,
    Invoice,
    Me,
    MenuItem,
    MoneyInvoicePage,
    MoneyPaymentPage,
    MoneySummary,
    Order,
    PayKind,
    PayTarget,
    Profile,
    PublicConfig,
    RecheckResult,
    Restaurant,
    RestaurantStats,
    Role,
    SettleResult,
    StaffMember,
    StatsRange,
    StorefrontView,
    Table,
    Wallet
} from "../../shared/types"

export const API_BASE = "/api"

/** An error answer from the server. `message` is the server's own sentence, safe to show. */
export class ApiError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
        this.name = "ApiError"
    }
}

const UNREACHABLE = "We couldn't reach FairPay. Check your connection and try again."

/**
 * True when the request didn't get an answer from the FairPay server itself: no connection, a
 * gateway error, or a page that isn't JSON. On free hosting this is what a sleeping server looks
 * like while it starts (about a minute), so the app waits and asks again (src/main.tsx).
 */
export function isUnreachable(e: unknown) {
    return e instanceof ApiError && (e.status === 0 || e.status === 502 || e.status === 503 || e.status === 504 || e.message === UNREACHABLE)
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

type Opts = {
    /** Raw body (image upload). Sent as-is instead of JSON. */
    raw?: Blob
    signal?: AbortSignal
}

async function request<T>(method: Method, path: string, body?: unknown, opts: Opts = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" }
    if (method !== "GET") headers["x-fairpay"] = "1"
    let payload: BodyInit | undefined
    if (opts.raw) {
        payload = opts.raw
        if (opts.raw.type) headers["content-type"] = opts.raw.type
    } else if (body !== undefined) {
        headers["content-type"] = "application/json"
        payload = JSON.stringify(body)
    }
    let res: Response
    try {
        res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload, credentials: "include", signal: opts.signal })
    } catch (err) {
        if ((err as { name?: string }).name === "AbortError") throw err
        throw new ApiError(0, UNREACHABLE)
    }
    const text = await res.text()
    let data: unknown = undefined
    if (text) {
        try {
            data = JSON.parse(text)
        } catch {
            // The server only answers in JSON. Anything else (an HTML "waking up" page from the
            // host, or a proxy error page) means the request never reached FairPay.
            if (res.ok || res.status >= 502) throw new ApiError(res.ok ? 503 : res.status, UNREACHABLE)
            throw new ApiError(res.status, defaultMessage(res.status))
        }
    }
    if (!res.ok) {
        const msg = (data as { error?: unknown } | undefined)?.error
        throw new ApiError(res.status, typeof msg === "string" && msg ? msg : defaultMessage(res.status))
    }
    return data as T
}

function defaultMessage(status: number) {
    if (status === 401) return "Sign in to continue."
    if (status === 403) return "You don't have access to this."
    if (status === 404) return "We couldn't find that. The link may be wrong or out of date."
    if (status === 429) return "Too many requests in a short time. Wait a minute and try again."
    if (status >= 500) return "FairPay had a problem answering. Try again in a moment."
    return `Request failed (${status}).`
}

const enc = encodeURIComponent
const q = (params: Record<string, string | undefined | null>) => {
    const s = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) s.set(k, v)
    const str = s.toString()
    return str ? `?${str}` : ""
}

/** Accepts either a bare array or `{ [key]: array }`, so small shape differences don't break a page. */
function list<T>(data: unknown, key: string): T[] {
    if (Array.isArray(data)) return data as T[]
    const v = (data as Record<string, unknown> | null | undefined)?.[key]
    return Array.isArray(v) ? (v as T[]) : []
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, { signal })
const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body)
const put = <T>(path: string, body: unknown = {}) => request<T>("PUT", path, body)
const del = <T>(path: string) => request<T>("DELETE", path)

export type RestaurantInput = Partial<
    Pick<
        Restaurant,
        | "name"
        | "tagline"
        | "description"
        | "cuisine"
        | "address"
        | "city"
        | "state"
        | "gstin"
        | "fssai"
        | "gstRateBps"
        | "serviceChargeBps"
        | "payoutWallet"
        | "coverImage"
        | "hours"
    >
> & { tables?: { count: number; seats: number } | number; seats?: number }

export type ManageView = {
    restaurant: Restaurant
    menu: MenuItem[]
    chefs: Chef[]
    tables: Table[]
    staff: StaffMember[]
    role: Role
}

export type FaucetResult = { minted?: string; gasSent?: string; txHash?: string }

export const api = {
    // ---------------------------------------------------------------- config, auth, profile
    config: () => get<PublicConfig>("/config"),
    nonce: () => get<{ nonce: string }>("/auth/nonce"),
    verify: (message: string, signature: `0x${string}`) => post<Me>("/auth/verify", { message, signature }),
    logout: () => post<unknown>("/auth/logout"),
    /** The signed-in user, or null when signed out (401). */
    me: async (): Promise<Me | null> => {
        try {
            return await get<Me>("/me")
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) return null
            throw err
        }
    },
    updateMe: (body: { displayName?: string | null; email?: string | null; bio?: string | null }) => put<Profile>("/me", body),
    profile: (wallet: Wallet) => get<{ wallet: Wallet; displayName: string | null }>(`/profiles/${enc(wallet)}`),

    friends: () => get<unknown>("/friends").then((d) => list<Friend>(d, "friends")),
    addFriend: (wallet: Wallet, nickname: string) => post<unknown>("/friends", { wallet, nickname }),
    removeFriend: (wallet: Wallet) => del<unknown>(`/friends/${enc(wallet)}`),

    activity: () => get<unknown>("/activity").then((d) => list<ActivityItem>(d, "items")),
    markActivityRead: (ids?: number[]) => post<unknown>("/activity/read", ids ? { ids } : {}),

    // ---------------------------------------------------------------- payments
    payTarget: (kind: PayKind, id: string, token?: string | null) => get<PayTarget>(`/pay/${kind}/${enc(id)}${q({ t: token })}`),
    settle: (kind: PayKind, id: string, txHash: `0x${string}`, token?: string | null) =>
        post<SettleResult>(`/pay/${kind}/${enc(id)}/settle${q({ t: token })}`, { txHash }),
    /** Hands a private payment (proof only, never the note) to the FairPay relayer. */
    relay: (request: unknown) => post<{ txHash: `0x${string}` }>("/relay", request),
    commitments: () => get<unknown>("/pool/commitments").then((d) => list<string>(d, "commitments").map(String)),
    faucet: (address: Wallet) => post<FaucetResult>("/faucet", { address }),

    // ---------------------------------------------------------------- bills
    createBill: (input: CreateBillInput) => post<Bill>("/bills", input),
    bills: () => get<unknown>("/bills").then((d) => list<BillSummary>(d, "bills")),
    bill: (id: string) => get<Bill>(`/bills/${enc(id)}`),
    billByToken: (token: string) => get<Bill>(`/b/${enc(token)}`),
    claimSeat: (billId: string, participantId: string, t: string) => post<Bill>(`/bills/${enc(billId)}/claim`, { participantId, t }),
    releaseSeat: (billId: string, participantId: string) => post<Bill>(`/bills/${enc(billId)}/seats/${enc(participantId)}/release`),
    cancelBill: (id: string) => post<Bill>(`/bills/${enc(id)}/cancel`),
    remindBill: (id: string) => post<{ reminded?: number }>(`/bills/${enc(id)}/remind`),
    requests: () =>
        get<{ incoming?: BillSummary[]; outgoing?: BillSummary[] }>("/requests").then((d) => ({
            incoming: d?.incoming ?? [],
            outgoing: d?.outgoing ?? []
        })),

    // ---------------------------------------------------------------- FairEats: restaurants
    restaurants: () => get<unknown>("/restaurants").then((d) => list<Restaurant>(d, "restaurants")),
    storefront: (slug: string) => get<StorefrontView>(`/restaurants/${enc(slug)}`),
    createRestaurant: (input: RestaurantInput) => post<Restaurant>("/restaurants", input),
    updateRestaurant: (id: string, input: RestaurantInput) => put<Restaurant>(`/restaurants/${enc(id)}`, input),
    manage: (id: string) => get<ManageView>(`/restaurants/${enc(id)}/manage`),

    addMenuItem: (id: string, item: Partial<MenuItem>) => post<MenuItem>(`/restaurants/${enc(id)}/menu`, item),
    updateMenuItem: (id: string, itemId: string, item: Partial<MenuItem>) =>
        put<MenuItem>(`/restaurants/${enc(id)}/menu/${enc(itemId)}`, item),
    deleteMenuItem: (id: string, itemId: string) => del<unknown>(`/restaurants/${enc(id)}/menu/${enc(itemId)}`),

    addChef: (id: string, chef: Partial<Chef>) => post<Chef>(`/restaurants/${enc(id)}/chefs`, chef),
    updateChef: (id: string, chefId: string, chef: Partial<Chef>) => put<Chef>(`/restaurants/${enc(id)}/chefs/${enc(chefId)}`, chef),
    deleteChef: (id: string, chefId: string) => del<unknown>(`/restaurants/${enc(id)}/chefs/${enc(chefId)}`),

    addTable: (id: string, table: Partial<Table>) => post<Table>(`/restaurants/${enc(id)}/tables`, table),
    updateTable: (id: string, tableId: string, table: Partial<Table>) => put<Table>(`/restaurants/${enc(id)}/tables/${enc(tableId)}`, table),
    deleteTable: (id: string, tableId: string) => del<unknown>(`/restaurants/${enc(id)}/tables/${enc(tableId)}`),
    setTableStatus: (id: string, tableId: string, status: Table["status"]) =>
        put<Table>(`/restaurants/${enc(id)}/tables/${enc(tableId)}/status`, { status }),

    staff: (id: string) => get<unknown>(`/restaurants/${enc(id)}/staff`).then((d) => list<StaffMember>(d, "staff")),
    addStaff: (id: string, wallet: Wallet, role: StaffMember["role"]) => post<StaffMember>(`/restaurants/${enc(id)}/staff`, { wallet, role }),
    removeStaff: (id: string, wallet: Wallet) => del<unknown>(`/restaurants/${enc(id)}/staff/${enc(wallet)}`),

    /** PNG, JPEG or WebP up to 1 MB. Returns the image URL to store on the item. */
    // Owner only (server/routes/money.ts).
    money: (id: string) => get<MoneySummary>(`/restaurants/${enc(id)}/money`),
    moneyPayments: (id: string, before?: string | null) => get<MoneyPaymentPage>(`/restaurants/${enc(id)}/money/payments${q({ before })}`),
    moneyInvoices: (id: string, before?: string | null) => get<MoneyInvoicePage>(`/restaurants/${enc(id)}/money/invoices${q({ before })}`),
    recheckPayment: (id: string, paymentId: number) => post<RecheckResult>(`/restaurants/${enc(id)}/money/payments/${paymentId}/recheck`),
    /** A plain link (cookies go with it), so the browser downloads the file itself. */
    moneyCsvUrl: (id: string) => `${API_BASE}/restaurants/${enc(id)}/money/payments.csv`,
    // Any staff; `money` is filled in for the owner only (server/routes/stats.ts).
    restaurantStats: (id: string, range: StatsRange) => get<RestaurantStats>(`/restaurants/${enc(id)}/stats${q({ range })}`),

    uploadImage: (id: string, file: Blob) => request<{ url: string }>("POST", `/restaurants/${enc(id)}/images`, undefined, { raw: file }),

    // ---------------------------------------------------------------- FairEats: orders
    createOrder: (input: CreateOrderInput) => post<{ order: Order; token: string }>("/orders", input),
    order: (id: string, token?: string | null) => get<Order>(`/orders/${enc(id)}${q({ t: token })}`),
    splitOrder: (id: string, participants: { wallet?: Wallet; displayName: string }[], token?: string | null) =>
        post<Bill>(`/orders/${enc(id)}/split-bill${q({ t: token })}`, { participants }),
    restaurantOrders: (id: string, status?: string) =>
        get<unknown>(`/restaurants/${enc(id)}/orders${q({ status })}`).then((d) => list<Order>(d, "orders")),
    setOrderStatus: (id: string, status: Order["status"]) => post<Order>(`/orders/${enc(id)}/status`, { status }),
    invoice: (token: string) => get<Invoice>(`/i/${enc(token)}`)
}

export type Api = typeof api

// ---------------------------------------------------------------- FairEats: Team pay
// Owner only (server/routes/teamPay.ts), except `mine`: a staff member's own payouts.
// Types are imported inline so this block stands on its own.
type TeamPayView = import("../../shared/types").TeamPayView
type TeamPayoutPage = import("../../shared/types").TeamPayoutPage
type TeamPayRecordResult = import("../../shared/types").TeamPayRecordResult

export const teamPayApi = {
    view: (id: string) => get<TeamPayView>(`/restaurants/${enc(id)}/team-pay`),
    payouts: (id: string, before?: string | null) => get<TeamPayoutPage>(`/restaurants/${enc(id)}/team-pay/payouts${q({ before })}`),
    mine: (id: string, before?: string | null) => get<TeamPayoutPage>(`/restaurants/${enc(id)}/team-pay/mine${q({ before })}`),
    /** Records a transfer the owner's wallet sent. "pending" (202): ask again shortly with the same body. */
    record: (id: string, body: { wallet: Wallet; amount: number; note: string | null; txHash: `0x${string}` }) =>
        post<TeamPayRecordResult>(`/restaurants/${enc(id)}/team-pay`, body),
    /** A plain link (cookies go with it), so the browser downloads the file itself. */
    csvUrl: (id: string) => `${API_BASE}/restaurants/${enc(id)}/team-pay/payouts.csv`
}

// ---------------------------------------------------------------- FairEats: Team pay escrow
// The payroll escrow (server/routes/payroll.ts). Owner only, except the `mine` calls. Every call
// answers 503 while the server's deployment has no payroll contract.
type EscrowView = import("../../shared/types").EscrowView
type MyEscrowView = import("../../shared/types").MyEscrowView
type EscrowEventPage = import("../../shared/types").EscrowEventPage
type PayrollShift = import("../../shared/types").PayrollShift
type ShiftApproveResult = import("../../shared/types").ShiftApproveResult

export const escrowApi = {
    view: (id: string) => get<EscrowView>(`/restaurants/${enc(id)}/team-pay/escrow`),
    history: (id: string, before?: string | null) => get<EscrowEventPage>(`/restaurants/${enc(id)}/team-pay/escrow/history${q({ before })}`),
    addShift: (id: string, body: { wallet: Wallet; workDate: string; minutes: number | null; note: string | null; amount: number }) =>
        post<PayrollShift>(`/restaurants/${enc(id)}/team-pay/shifts`, body),
    removeShift: (id: string, shiftId: string) => del<{ ok: true }>(`/restaurants/${enc(id)}/team-pay/shifts/${enc(shiftId)}`),
    /** Records an approveShifts transaction once it verifies. "pending" (202): ask again shortly. */
    approveShifts: (id: string, txHash: `0x${string}`) => post<ShiftApproveResult>(`/restaurants/${enc(id)}/team-pay/shifts/approve`, { txHash }),
    setMember: (id: string, wallet: Wallet, body: { shiftRate?: number | null; autoPay?: boolean }) =>
        put<{ wallet: Wallet; shiftRate: number | null; autoPay: boolean }>(`/restaurants/${enc(id)}/team-pay/members/${enc(wallet)}`, body),
    mine: (id: string) => get<MyEscrowView>(`/restaurants/${enc(id)}/team-pay/escrow/mine`),
    mineHistory: (id: string, before?: string | null) => get<EscrowEventPage>(`/restaurants/${enc(id)}/team-pay/escrow/mine/history${q({ before })}`)
}
