import { getAddress, type Address } from "viem"
import type { PublicConfig } from "../api"
// The live contract addresses, from the deployment record the contracts package writes.
import deployment from "../../../../packages/contracts/deployments/monadTestnet.json"

/** Marker for checking that no demo code reaches the real bundle (grep the build for it). */
export const DEMO_MARKER = "faireats-demo-mode-simulated"

const USDC = 1_000_000

/** The demo wallet: an obviously fake address. It has no key; nothing ever signs. */
export const DEMO_WALLET: Address = getAddress("0x00000000000000000000000000000000000de111")
/** The simulated restaurant's receiving address. */
export const DEMO_MERCHANT: Address = getAddress("0x00000000000000000000000000000000005aff07")
/** The simulated relayer that submits private payments. */
export const DEMO_RELAYER: Address = getAddress("0x0000000000000000000000000000000000000e1a")

export const DEMO_KITCHEN_PIN = "demo-kitchen"
/** The demo shortens the 60 second cook timer so a walk-through stays short. */
export const DEMO_COOK_MS = 20_000
export const DENOMINATION = 5 * USDC
export const START_USDC = 50 * USDC
export const START_MON = 150_000_000_000_000_000n // 0.15 MON
export const GAS_PER_TX = 2_000_000_000_000_000n // 0.002 MON
export const OTHER_DEPOSITS = 23
export const SEED_NOTES = 2

/** The real public deployment on Monad Testnet. Used only for labelled links to real contracts. */
export const REAL = {
    chainId: 10143,
    explorer: "https://testnet.monadexplorer.com",
    token: getAddress(deployment.token),
    fairPay: getAddress(deployment.fairPay),
    pool: getAddress(deployment.pool),
    verifier: getAddress(deployment.verifier)
}

/** Where the app's explorer links go in the demo: a local page that explains the simulated receipt. */
export const demoExplorerBase = (baseUrl: string) => `${baseUrl.replace(/\/$/, "")}/explorer`

export const restaurant = {
    name: "Saffron Table",
    tagline: "Order at the table, split it your way, pay without showing your wallet.",
    tables: 12
}

export const MAX_GUESTS = 8

export function demoConfig(baseUrl: string): PublicConfig {
    return {
        chainId: REAL.chainId,
        // Never contacted: the demo replaces every client that would use it.
        rpcUrl: "simulated:",
        explorer: demoExplorerBase(baseUrl),
        token: REAL.token,
        fairPay: REAL.fairPay,
        pool: REAL.pool,
        poolDeployBlock: "0",
        denomination: String(DENOMINATION),
        merchant: DEMO_MERCHANT,
        maxGuests: MAX_GUESTS,
        restaurant
    }
}

// Same menu and prices as server/menu.ts. Every price is a whole number of 5 USDC notes.
export const menu = [
    { id: "pakora", name: "Onion pakora", description: "Crisp gram-flour fritters, tamarind chutney", category: "Small plates", price: 5 * USDC },
    { id: "burrata", name: "Burrata & peaches", description: "Charred peach, basil oil, black pepper", category: "Small plates", price: 10 * USDC },
    { id: "tacos", name: "Mushroom tacos", description: "Oyster mushroom, salsa macha, lime", category: "Small plates", price: 10 * USDC },
    { id: "biryani", name: "Saffron biryani", description: "Slow-cooked rice, fried onion, raita", category: "Mains", price: 15 * USDC },
    { id: "ramen", name: "Miso ramen", description: "White miso broth, soft egg, chili oil", category: "Mains", price: 15 * USDC },
    { id: "risotto", name: "Lemon risotto", description: "Parmesan, lemon zest, crispy sage", category: "Mains", price: 20 * USDC },
    { id: "kulfi", name: "Pistachio kulfi", description: "Cardamom, rose, crushed pistachio", category: "Sweet", price: 5 * USDC },
    { id: "lassi", name: "Mango lassi", description: "Alphonso mango, yoghurt, a pinch of salt", category: "Drinks", price: 5 * USDC },
    { id: "chai", name: "Masala chai", description: "Assam tea, ginger, cardamom", category: "Drinks", price: 5 * USDC }
]
export const menuById = new Map(menu.map((m) => [m.id, m]))
