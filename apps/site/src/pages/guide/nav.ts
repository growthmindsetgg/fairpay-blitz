// The guide's pages in reading order. The sidebar, prev/next links,
// "On this page" lists, per-route meta and the sitemap are all generated from this list.

export type TocItem = { id: string; label: string; level: 2 | 3 }

export type GuidePage = {
    path: string
    title: string
    /** Short label for the sidebar. */
    nav: string
    group: "Start" | "Understand" | "Build" | "Reference"
    type: "Overview" | "Tutorial" | "Explanation" | "How-to" | "Reference"
    description: string
    toc: TocItem[]
}

export const GROUPS = ["Start", "Understand", "Build", "Reference"] as const

export const GUIDE: GuidePage[] = [
    {
        path: "/guide",
        title: "The FairPay guide",
        nav: "Overview",
        group: "Start",
        type: "Overview",
        description:
            "What FairPay and FairEats are, how to start using the app, and where to go if you want to run it, build on it or decide whether to trust it.",
        toc: [{ id: "what-it-is", label: "What FairPay is", level: 2 }]
    },
    {
        path: "/guide/start",
        title: "Get started with the app",
        nav: "Get started",
        group: "Start",
        type: "Tutorial",
        description:
            "Sign in with a browser wallet or the built-in test wallet, get test USDC, split a bill, pay publicly or privately, and set up a restaurant on FairEats.",
        toc: [
            { id: "sign-in", label: "1. Sign in", level: 2 },
            { id: "test-usdc", label: "2. Get test USDC", level: 2 },
            { id: "create-bill", label: "3. Create a bill", level: 2 },
            { id: "pay", label: "4. Pay your share", level: 2 },
            { id: "public-or-private", label: "Public or private", level: 3 },
            { id: "faireats", label: "5. FairEats for restaurants", level: 2 },
            { id: "guests", label: "6. Order at a table", level: 2 }
        ]
    },
    {
        path: "/guide/demo",
        title: "Try the simulated demo",
        nav: "Simulated demo",
        group: "Start",
        type: "Tutorial",
        description:
            "Order for a table of three in the simulated restaurant demo, which runs in your browser with no wallet, pay one share publicly and one privately, then watch the kitchen start.",
        toc: []
    },
    {
        path: "/guide/how-it-works",
        title: "How it works",
        nav: "How it works",
        group: "Understand",
        type: "Explanation",
        description:
            "How a table pays, step by step, and how private payments hide the payer's wallet with a zero-knowledge proof and a relayer.",
        toc: [
            { id: "how-a-table-pays", label: "How a table pays", level: 2 },
            { id: "private-payments", label: "Private payments, explained simply", level: 2 },
            { id: "everyday-version", label: "An everyday version", level: 3 },
            { id: "in-fairpay-terms", label: "In FairPay terms", level: 3 },
            { id: "habits", label: "Habits that keep it private", level: 3 }
        ]
    },
    {
        path: "/guide/security",
        title: "Security and limitations",
        nav: "Security and limitations",
        group: "Understand",
        type: "Explanation",
        description:
            "What FairPay's design guarantees, who you trust and for what, its known limitations, and what would be needed before anything like mainnet.",
        toc: [
            { id: "guarantees", label: "What the design guarantees", level: 2 },
            { id: "trust", label: "Who you trust, and for what", level: 2 },
            { id: "limitations", label: "Known limitations", level: 2 },
            { id: "before-mainnet", label: "Before anything like mainnet", level: 2 },
            { id: "about-the-demo", label: "About the demo on this site", level: 2 },
            { id: "reporting", label: "Reporting", level: 2 }
        ]
    },
    {
        path: "/guide/run",
        title: "Run it locally",
        nav: "Run it locally",
        group: "Build",
        type: "How-to",
        description: "Run the FairPay app, the standalone FairEats app or this website on your own computer, with testnet-only settings.",
        toc: [
            { id: "you-need", label: "You need", level: 2 },
            { id: "fairpay-app", label: "Run the FairPay app", level: 2 },
            { id: "set-up", label: "Run the standalone FairEats app", level: 2 },
            { id: "production-build", label: "Production build of FairEats locally", level: 2 },
            { id: "build-site", label: "Build this website and the demo locally", level: 2 }
        ]
    },
    {
        path: "/guide/test",
        title: "Run the tests",
        nav: "Run the tests",
        group: "Build",
        type: "How-to",
        description: "Run the contract, SDK, FairEats and FairPay app test suites.",
        toc: [
            { id: "you-need", label: "You need", level: 2 },
            { id: "suites", label: "Run each suite", level: 2 }
        ]
    },
    {
        path: "/guide/deploy",
        title: "Deploy",
        nav: "Deploy",
        group: "Build",
        type: "How-to",
        description: "Deploy the FairPay app on Render with Supabase for data, and publish this static website on Vercel.",
        toc: [
            { id: "you-need", label: "You need", level: 2 },
            { id: "deploy", label: "Deploy the apps on Render", level: 2 },
            { id: "after-live", label: "After it is live", level: 3 },
            { id: "deploy-site", label: "Publish this website on Vercel", level: 2 }
        ]
    },
    {
        path: "/guide/sdk",
        title: "Use the SDK",
        nav: "Use the SDK",
        group: "Build",
        type: "Reference",
        description:
            "Install @fairpay/sdk, create share references, pay publicly or privately, run a relayer, and verify payments against the chain.",
        toc: [
            { id: "you-need", label: "You need", level: 2 },
            { id: "install", label: "Install", level: 2 },
            { id: "clients", label: "Set up clients", level: 2 },
            { id: "create-reference", label: "1. Backend: create the share reference", level: 2 },
            { id: "pay-publicly", label: "2a. Browser: pay publicly", level: 2 },
            { id: "pay-privately", label: "2b. Browser: pay privately", level: 2 },
            { id: "relayer-route", label: "3. Backend: the relayer route", level: 2 },
            { id: "verify", label: "4. Backend: verify before releasing the order", level: 2 },
            { id: "api", label: "API at a glance", level: 2 },
            { id: "errors", label: "Errors", level: 2 }
        ]
    },
    {
        path: "/guide/faq",
        title: "FAQ and glossary",
        nav: "FAQ and glossary",
        group: "Reference",
        type: "Reference",
        description: "Short answers about the app, the simulated demo, private payments and testnet funds, and a glossary of the terms used across FairPay.",
        toc: [
            { id: "faq", label: "FAQ", level: 2 },
            { id: "glossary", label: "Glossary", level: 2 }
        ]
    }
]

export const guidePage = (path: string) => GUIDE.find((p) => p.path === path)
