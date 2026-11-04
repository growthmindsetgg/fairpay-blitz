import { GUIDE } from "./pages/guide/nav"

// Per-route head content. Pages render these as React 19 <title>/<meta> for client-side
// navigation, and scripts/prerender.mjs writes them into each route's static HTML.

export type PageMeta = { title: string; description: string; noindex?: boolean }

export const PAGE_META: Record<string, PageMeta> = {
    "/": {
        title: "FairPay · split bills with friends, pay restaurants privately",
        description:
            "FairPay splits bills between friends and checks every payment on Monad. FairEats restaurants take orders at the table, split the bill and issue GST invoices, with optional private payments. Testnet only, unaudited."
    },
    "/about": {
        title: "About FairPay · an independent testnet project",
        description:
            "What FairPay is, who it is not (it is independent of the Monad Foundation), why it runs only on Monad Testnet with test USDC, the live contracts on the explorer, and what the website and the app store."
    },
    "/404": {
        title: "Page not found · FairPay",
        description: "The page you asked for doesn't exist. Nothing was paid.",
        noindex: true
    },
    ...Object.fromEntries(
        GUIDE.map((p) => [
            p.path,
            { title: p.path === "/guide" ? "Guide · FairPay" : `${p.title} · FairPay guide`, description: p.description }
        ])
    )
}

/** Every prerendered route except the 404 page, in sitemap order. */
export const ROUTES = ["/", ...GUIDE.map((p) => p.path), "/about"]
