// FairEats calls used by the business pages. Everything goes through D's `api` client
// (src/lib/api.ts), except the few calls it lacks, which use the same rules here: same-origin,
// cookies included, and `x-fairpay: 1` on every mutation (the server's CSRF guard).

import type { Chef, MenuItem, StaffMember, Wallet } from "../../../shared/types"
import { ApiError, api, type ManageView, type RestaurantInput } from "../../lib/api"

export { ApiError }
export type { ManageView, RestaurantInput }

/** POST with a JSON body. Only for calls D's client doesn't have. */
async function post<T>(path: string, body: unknown): Promise<T> {
    let res: Response
    try {
        res = await fetch(`/api${path}`, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json", "x-fairpay": "1" },
            body: JSON.stringify(body),
            credentials: "include"
        })
    } catch {
        throw new ApiError(0, "We couldn't reach FairPay. Check your connection and try again.")
    }
    const text = await res.text()
    let data: unknown
    try {
        data = text ? JSON.parse(text) : undefined
    } catch {
        data = undefined
    }
    if (!res.ok) {
        const msg = (data as { error?: unknown } | undefined)?.error
        throw new ApiError(res.status, typeof msg === "string" && msg ? msg : `Request failed (${res.status}).`)
    }
    return data as T
}

export type MenuInput = Pick<MenuItem, "name" | "description" | "category" | "price" | "image" | "veg" | "spice" | "prepMinutes" | "available"> & {
    sort?: number
}

export type ChefInput = Pick<Chef, "name" | "title" | "bio" | "specialty" | "years" | "photo" | "onDuty">

export type SplitParticipant = { wallet?: Wallet; displayName: string }

export const fe = {
    restaurants: api.restaurants,
    storefront: api.storefront,
    register: (input: RestaurantInput) => api.createRestaurant(input),
    update: (id: string, patch: RestaurantInput) => api.updateRestaurant(id, patch),
    manage: (id: string) => api.manage(id),

    addItem: (id: string, item: MenuInput) => api.addMenuItem(id, item),
    updateItem: (id: string, itemId: string, item: Partial<MenuInput>) => api.updateMenuItem(id, itemId, item),
    deleteItem: (id: string, itemId: string) => api.deleteMenuItem(id, itemId),

    addChef: (id: string, chef: ChefInput) => api.addChef(id, chef),
    updateChef: (id: string, chefId: string, chef: Partial<ChefInput>) => api.updateChef(id, chefId, chef),
    deleteChef: (id: string, chefId: string) => api.deleteChef(id, chefId),

    addTable: (id: string, t: { label: string; seats: number }) => api.addTable(id, t),
    updateTable: (id: string, tableId: string, t: { label?: string; seats?: number }) => api.updateTable(id, tableId, t),
    deleteTable: (id: string, tableId: string) => api.deleteTable(id, tableId),
    setTableStatus: api.setTableStatus,

    staff: api.staff,
    /** Local: D's addStaff doesn't send displayName, which the schema requires. */
    addStaff: (id: string, s: { wallet: Wallet; role: StaffMember["role"]; displayName: string }) =>
        post<StaffMember>(`/restaurants/${encodeURIComponent(id)}/staff`, s),
    removeStaff: api.removeStaff,

    uploadImage: api.uploadImage,

    money: api.money,
    moneyPayments: api.moneyPayments,
    moneyInvoices: api.moneyInvoices,
    recheckPayment: api.recheckPayment,
    moneyCsvUrl: api.moneyCsvUrl,
    stats: api.restaurantStats,

    orders: (id: string, status?: string) => api.restaurantOrders(id, status),
    setOrderStatus: api.setOrderStatus,

    placeOrder: api.createOrder,
    order: (orderId: string, token: string | null) => api.order(orderId, token),
    splitBill: (orderId: string, token: string | null, participants: SplitParticipant[]) =>
        api.splitOrder(orderId, participants, token) as Promise<unknown>,
    invoice: api.invoice
}

/** split-bill returns the new bill; accept a Bill, `{ billId }` or `{ bill }`. */
export function billIdFrom(res: unknown): string | null {
    if (!res || typeof res !== "object") return null
    const r = res as { id?: unknown; billId?: unknown; bill?: { id?: unknown } }
    if (typeof r.billId === "string") return r.billId
    if (r.bill && typeof r.bill.id === "string") return r.bill.id
    if (typeof r.id === "string") return r.id
    return null
}

export function errorText(e: unknown) {
    return e instanceof Error ? e.message : "Something went wrong. Try again."
}
