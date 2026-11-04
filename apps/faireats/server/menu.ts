// The menu lives on the server. Clients send item ids and quantities only; prices never come
// from the browser. Every price is a whole number of 5 USDC notes so any guest's share can be
// paid privately.

export type MenuItem = {
    id: string
    name: string
    description: string
    category: "Small plates" | "Mains" | "Sweet" | "Drinks"
    /** micro-USDC (6 decimals) */
    price: number
}

const USDC = 1_000_000

export const restaurant = {
    name: "Saffron Table",
    tagline: "Order at the table, split it your way, pay without showing your wallet.",
    tables: 12
}

export const menu: MenuItem[] = [
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
