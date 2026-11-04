// Types shared by the server and the browser. The API returns exactly these shapes.
// Money: integer micro-USDC as a JS number. Times: unix ms. Wallets: lowercase 0x strings.

export type Wallet = `0x${string}`

export type Profile = {
    wallet: Wallet
    displayName: string | null
    email: string | null
    bio: string | null
}

export type Me = {
    profile: Profile
    /** Restaurants this wallet owns or works at. */
    restaurants: { id: string; slug: string; name: string; role: Role }[]
}

export type Role = "owner" | "manager" | "chef" | "waiter"

export type Friend = { wallet: Wallet; nickname: string }

export type ActivityItem = {
    id: number
    kind: string
    title: string
    detail: string | null
    link: string | null
    read: boolean
    createdAt: number
    /**
     * The transaction of a public payment this entry reports, for an explorer link. Never set for a
     * confidential payment: its transaction would point back at the payment and undo "hides who paid".
     */
    txHash?: `0x${string}` | null
}

// ------------------------------------------------------------------ public config

export type PublicConfig = {
    chainId: number
    chainName: string
    rpcUrl: string
    explorer: string
    token: Wallet
    fairPay: Wallet
    pool: Wallet
    poolDeployBlock: string
    /** FairPoolBatcher for `pool`: adding several notes takes one approval and one deposit. Absent when not deployed. */
    batcher?: Wallet
    /** FairPayroll, Team pay's payroll escrow. Absent until deployed: the app then shows "coming soon". */
    payroll?: Wallet
    /** The auto-pay keeper's wallet (it only calls claimFor). Absent when KEEPER_KEY isn't set. */
    keeper?: Wallet
    /** Size of one private note, micro-USDC (5 USDC). */
    denomination: number
    relayer: string
    /**
     * False while the relayer's wallet can't cover one relay's gas reservation, so confidential
     * payments would fail: grey them out. Absent when there is no relayer (see `relayer`).
     */
    relayerReady?: boolean
    faucet: boolean
    /** "supabase" when DATABASE_URL is set, "local" for PGlite. Shown in the footer. */
    storage: "supabase" | "local"
}

// ------------------------------------------------------------------ payments

/** What can be paid: a person's share of a bill, or a guest's share of a restaurant order. */
export type PayKind = "bill" | "order"

export type PayTarget = {
    kind: PayKind
    id: string
    /** Who receives the money. */
    recipient: Wallet
    recipientName: string
    amount: number
    tip: number
    paid: number
    /** amount + tip - paid */
    due: number
    /**
     * Ties payments to this share on-chain. Only for a viewer who may pay it now (see
     * routes/pay.ts view); null otherwise, since it would let a link holder look up who paid.
     */
    orderRef: `0x${string}` | null
    status: "owed" | "paid" | "covered"
    /**
     * Whether this can be paid privately right now, and if not, why (shown to the user).
     * Private payments need an allowlisted recipient (verified businesses). They are made of whole
     * 5 USDC notes: when the due amount isn't a multiple of 5, the last note pays a little more and
     * the difference (tip) goes to the recipient. Nothing is stored until a note is verified.
     */
    private: { possible: true; notes: number; tip: number } | { possible: false; reason: string }
    /**
     * Public payments must come from this wallet. Only revealed to that wallet, the bill's creator
     * and its recipient; everyone else sees null with payerLocked true.
     */
    expectedPayer: Wallet | null
    /** True when the share is tied to a wallet, whether or not the viewer may see which. */
    payerLocked: boolean
}

export type SettleResult =
    | { status: "credited"; target: PayTarget }
    | { status: "pending"; reason: string }
    | { status: "rejected"; reason: string }

// ------------------------------------------------------------------ bills

export type SplitType = "equal" | "fixed" | "percent" | "shares" | "items"

export type BillParticipant = {
    id: string
    wallet: Wallet | null
    displayName: string
    amount: number
    tip: number
    paid: number
    status: "owed" | "paid" | "covered"
    /** Private payments show as "Paid privately" with no payer details. */
    paidPrivately: boolean
    paidAt: number | null
    /** A name-only seat nobody has claimed yet; a signed-in link holder can take it. */
    claimable: boolean
    /**
     * The transaction that paid this share publicly, for an explorer link. Only for the creator and
     * participants (it shows the payer's wallet), and never when any part was paid privately.
     */
    txHash?: `0x${string}` | null
}

export type Bill = {
    id: string
    creator: Wallet
    recipient: Wallet
    recipientName: string
    title: string
    note: string | null
    total: number
    splitType: SplitType
    status: "open" | "settled" | "cancelled"
    source: "manual" | "restaurant_order"
    orderId: string | null
    /** Only included for the creator and participants. */
    shareUrl: string | null
    createdAt: number
    settledAt: number | null
    participants: BillParticipant[]
    /** The signed-in viewer's own participant id, if any. */
    myParticipantId: string | null
}

export type CreateBillInput = {
    title: string
    note?: string
    total: number
    splitType: Exclude<SplitType, "items">
    /**
     * The creator is always a participant (status 'covered' for their own part).
     * value: fixed micro-USDC for 'fixed', basis points for 'percent', a whole number for 'shares',
     * ignored for 'equal'. alreadyPaid marks someone who settled outside FairPay.
     */
    participants: { wallet?: Wallet; displayName: string; value?: number; alreadyPaid?: boolean }[]
    /** The creator's own value in the same unit. */
    creatorValue?: number
}

export type BillSummary = {
    id: string
    title: string
    total: number
    status: Bill["status"]
    role: "creator" | "participant"
    myDue: number
    paidCount: number
    participantCount: number
    createdAt: number
    /** The viewer's own seat on this bill (pay it with PayShare kind "bill"), if they have one. */
    myParticipantId?: string | null
    /** The viewer created this open bill and nobody has paid in FairPay yet, so it can be cancelled. */
    canCancel?: boolean
}

// ------------------------------------------------------------------ FairEats

export type Restaurant = {
    id: string
    slug: string
    name: string
    tagline: string | null
    description: string | null
    cuisine: string | null
    address: string | null
    city: string | null
    state: string
    gstin: string | null
    fssai: string | null
    gstRateBps: number
    serviceChargeBps: number
    payoutWallet: Wallet
    coverImage: string | null
    hours: string | null
    isDemo: boolean
    /** FairPool allowlists the payout wallet, so guests can pay privately. */
    privatePayments: boolean
    tables: { total: number; available: number }
}

export type Chef = {
    id: string
    name: string
    title: string | null
    bio: string | null
    specialty: string | null
    years: number | null
    photo: string | null
    onDuty: boolean
}

export type MenuItem = {
    id: string
    name: string
    description: string | null
    category: string
    price: number
    image: string | null
    veg: boolean
    spice: number
    prepMinutes: number
    available: boolean
    sac: string
    sort: number
}

export type Table = {
    id: string
    label: string
    seats: number
    status: "available" | "occupied" | "reserved" | "closed"
    orderId: string | null
}

export type StaffMember = { wallet: Wallet; role: Exclude<Role, "owner">; displayName: string; addedAt: number }

export type StorefrontView = { restaurant: Restaurant; menu: MenuItem[]; chefs: Chef[]; tables: Table[] }

export type CreateOrderInput = {
    tableId: string
    guests: number
    paymentMode: "one_pays" | "split"
    /** guest is 1-based and only matters for 'split' item-based shares. */
    items: { id: string; qty: number; guest: number }[]
    /** For 'split': divide by what each guest ordered ("items") or evenly ("equal"). */
    splitBy?: "items" | "equal"
    /** Optional names per guest, index 0 = guest 1. */
    guestNames?: string[]
}

export type OrderShare = {
    id: string
    guest: number
    label: string
    amount: number
    tip: number
    paid: number
    status: "owed" | "paid"
    paidPrivately: boolean
}

export type Order = {
    id: string
    restaurant: { id: string; slug: string; name: string }
    table: { id: string; label: string } | null
    guests: number
    paymentMode: "one_pays" | "split"
    status: "awaiting_payment" | "paid" | "cooking" | "ready" | "served" | "cancelled"
    items: { itemId: string; name: string; unitPrice: number; qty: number; guest: number; sac: string }[]
    subtotal: number
    serviceCharge: number
    cgst: number
    sgst: number
    igst: number
    roundOff: number
    total: number
    gstRateBps: number
    shares: OrderShare[]
    chef: Chef | null
    /** Estimated time the food is ready, once paid. */
    estReadyAt: number | null
    /** Minutes, computed by the server when the order was viewed. */
    waitMinutes: number | null
    /**
     * Only while awaiting payment: the wait in minutes if the order were paid now, by the same rule
     * as estReadyAt (longest prep time plus 4 minutes per order ahead in the kitchen).
     */
    expectedWaitMinutes?: number
    /** A sample order seeded with the demo restaurant. Its shares were marked paid; no payment was made. */
    demo?: boolean
    invoiceNo: string | null
    invoiceUrl: string
    splitBillId: string | null
    createdAt: number
    paidAt: number | null
    cookingStartedAt: number | null
    readyAt: number | null
    servedAt: number | null
}

/** Tax invoice (or bill of supply when the restaurant has no GSTIN). Public via its share link. */
export type Invoice = {
    kind: "tax_invoice" | "bill_of_supply"
    invoiceNo: string | null
    issuedAt: number
    supplier: {
        name: string
        address: string | null
        city: string | null
        state: string
        stateCode: string | null
        gstin: string | null
        fssai: string | null
    }
    placeOfSupply: string
    table: string | null
    lines: { name: string; sac: string; qty: number; rate: number; taxable: number }[]
    subtotal: number
    serviceCharge: number
    serviceChargeBps: number
    taxableValue: number
    cgst: { rateBps: number; amount: number }
    sgst: { rateBps: number; amount: number }
    igst: { rateBps: number; amount: number }
    roundOff: number
    total: number
    amountInWords: string
    paymentMode: Order["paymentMode"]
    payments: { label: string; amount: number; private: boolean; txHash: string | null; at: number }[]
    status: Order["status"]
    orderId: string
    shareUrl: string
    /** The invoice of a seeded demo order: marked paid without any payment, so `payments` is empty. */
    demo?: boolean
}

// ------------------------------------------------------------------ FairEats: the owner's money view

/** Money received in one period, micro-USDC. `received` includes the tips. */
export type MoneyTotals = { received: number; public: number; private: number; tips: number; count: number }

/** GET /restaurants/:id/money (owner only). */
export type MoneySummary = {
    payout: {
        wallet: Wallet
        /** FairPool.isMerchant for the payout wallet; null when the chain couldn't be asked. */
        privatePayments: boolean | null
    }
    /** Today and the last 7 days are counted in India time (the restaurants' time zone). */
    totals: { today: MoneyTotals; week: MoneyTotals; all: MoneyTotals }
    /** Money that reached a payout wallet but wasn't credited: the owner's refund notes. Newest first. */
    attention: MoneyNotice[]
}

export type MoneyNotice = {
    id: number
    kind: "refund" | "not_counted"
    title: string
    detail: string | null
    txHash: `0x${string}` | null
    at: number
}

/**
 * One credited payment, as the restaurant's receipt. A confidential payment never names its payer
 * or its guest's seat. `proof` is null when the share was paid partly in public and partly
 * confidentially: its transactions would tie the public payer to the confidential part.
 */
export type MoneyPayment = {
    id: number
    /** When FairPay verified and credited it. */
    at: number
    kind: "public" | "private"
    /** What arrived on-chain, tip included. */
    amount: number
    /** The part of `amount` above the share's price: the last confidential note's extra. */
    tip: number
    order: { id: string; invoiceNo: string | null; table: string | null }
    /** The guest's share label. Null for a confidential payment. */
    share: string | null
    /** The paying wallet of a public payment. Null for a confidential one and when `proof` is withheld. */
    payer: Wallet | null
    recipient: Wallet
    /** The PaymentReceived event FairPay verified. */
    proof: { chainId: number; txHash: `0x${string}`; logIndex: number; blockNumber: number; orderRef: `0x${string}` } | null
}

export type MoneyPaymentPage = { payments: MoneyPayment[]; next: string | null }

export type MoneyInvoice = {
    orderId: string
    invoiceNo: string
    issuedAt: number
    table: string | null
    total: number
    kind: "tax_invoice" | "bill_of_supply"
    url: string
}

export type MoneyInvoicePage = { invoices: MoneyInvoice[]; next: string | null }

/** POST /restaurants/:id/money/payments/:paymentId/recheck: verifyPaymentTx run again now. */
export type RecheckResult = { status: "verified" | "pending" | "rejected"; reason: string | null; checkedAt: number }

// ------------------------------------------------------------------ FairEats: dashboard stats

/** The periods the dashboard counts, in India time: today, the last 7 or 30 days (today included), this month. */
export type StatsRange = "today" | "7d" | "30d" | "mtd"

/**
 * GET /restaurants/:id/stats?range= (any staff: the same people who see the restaurant's orders).
 * Orders count in the range they were placed in. "Paid" means paid, cooking, ready or served; the
 * demo restaurant's sample orders, marked paid without any payment, are left out.
 */
export type RestaurantStats = {
    range: StatsRange
    /** First and last instant counted, unix ms. */
    from: number
    to: number
    /** Paid orders' totals (GST and service charge included, tips not), micro-USDC. */
    revenue: number
    /** Paid orders. */
    orders: number
    /** Every order placed, whatever happened to it. */
    placed: number
    awaitingPayment: number
    /** revenue / orders, rounded to a micro-USDC; 0 without orders. */
    averageOrder: number
    /** Covers: the guests on paid orders. */
    guests: number
    /** Orders cancelled by staff or given up unpaid after 15 minutes, and what they would have been. */
    cancelled: { count: number; value: number }
    /** Most ordered dishes on paid orders, by quantity. Revenue is the dishes' prices, before GST. */
    topDishes: { itemId: string; name: string; qty: number; revenue: number }[]
    /** Paid orders by the hour they were placed, India time: 24 entries, midnight first. */
    hours: number[]
    /** One entry per India-time day in the range, oldest first. `day` is YYYY-MM-DD. */
    days: { day: string; start: number; revenue: number; orders: number }[]
    turnover: {
        /** Average minutes from placing an order to paying it in full. */
        toPaidMinutes: number | null
        /** Average minutes from placing an order to serving it. */
        toServedMinutes: number | null
        served: number
        /** Paid orders at a table divided by the restaurant's tables. */
        turnsPerTable: number | null
    }
    /**
     * Owner only (null for everyone else), as the Payments tab: what reached the payout wallet for
     * these orders, split by kind. Both include tips; `tips` is the part above the price.
     */
    money: { public: number; confidential: number; tips: number; payments: number } | null
}

// ------------------------------------------------------------------ Team pay (owner pays staff)

/**
 * One payment from a restaurant's owner to a staff member: a plain USDC transfer straight from the
 * owner's wallet, verified on-chain by the server (server/routes/teamPay.ts). Public on Monad:
 * the owner's wallet, the staff wallet and the amount. Name and role are as they were when paid.
 */
export type TeamPayout = {
    id: number
    /** When FairPay verified and recorded it. */
    at: number
    amount: number
    note: string | null
    recipient: { wallet: Wallet; name: string; role: StaffMember["role"] }
    payer: Wallet
    proof: { chainId: number; txHash: `0x${string}`; logIndex: number; blockNumber: number }
}

/** A staff member as Team pay lists them, with what they have been paid here. */
export type TeamMember = StaffMember & { paidTotal: number; payCount: number; lastPaidAt: number | null }

/** GET /restaurants/:id/team-pay (owner only). */
export type TeamPayView = { owner: Wallet; staff: TeamMember[]; payouts: TeamPayout[]; next: string | null }

/** GET /restaurants/:id/team-pay/payouts and /team-pay/mine. */
export type TeamPayoutPage = { payouts: TeamPayout[]; next: string | null }

/** POST /restaurants/:id/team-pay. "pending" comes with 202: ask again. `duplicate`: it was already recorded. */
export type TeamPayRecordResult =
    | { status: "recorded"; payout: TeamPayout; duplicate: boolean }
    | { status: "pending"; reason: string }
    | { status: "rejected"; reason: string }

// ------------------------------------------------------------------ Team pay part 2: payroll escrow

/**
 * The restaurant owner's escrow on FairPayroll, read from the chain by the server. Amounts are
 * micro-USDC; times are milliseconds. The escrow belongs to the owner's wallet, so restaurants with
 * the same owner share it.
 */
export type EscrowAccount = {
    /** Held in the escrow for the owner. */
    balance: number
    /** Withdrawable (or spendable on shifts) now. */
    available: number
    /** Set aside for staff or owed to them. The owner can't withdraw it. */
    owed: number
    /** What the owner must add for all pay to be set aside up to now. */
    shortfall: number
    /** Schedule pay is set aside up to this time. */
    fundedUntil: number
    /** When the free balance runs out at today's rates; null without schedules. */
    runwayUntil: number | null
    /** What all running schedules cost per day. */
    payPerDay: number
}

/** One person's position with this owner (FairPayroll.employeeInfo). */
export type EscrowPosition = {
    /** What a claim would pay now. */
    claimable: number
    /** Everything owed up to now. */
    earned: number
    /** Earned but not funded yet (earned - claimable). */
    shortfall: number
    /** Unpaid pay from completed periods of the running schedule. */
    scheduleEarned: number
    /** Debt from a schedule that ended while the escrow was short. */
    debt: number
    /** When the running schedule's next period completes; null without one. */
    nextPayAt: number | null
}

export type PayPeriodName = "day" | "week" | "month"

/** A running schedule (FairPayroll.scheduleOf). "month" is a fixed 30 days. */
export type EscrowSchedule = { amountPerPeriod: number; period: PayPeriodName; start: number }

export type PayrollShift = {
    id: string
    wallet: Wallet
    name: string
    /** YYYY-MM-DD, the day worked. */
    workDate: string
    minutes: number | null
    note: string | null
    amount: number
    /** bytes32 sent to approveShifts; unique per owner. */
    shiftId: `0x${string}`
    status: "pending" | "approved"
    createdAt: number
    /** The verified ShiftApproved event, once approved. */
    approved: { at: number; txHash: `0x${string}`; blockNumber: number; logIndex: number } | null
}

/** A team member in the escrow view, or someone who left with escrow pay. */
export type EscrowMember = {
    wallet: Wallet
    name: string | null
    role: StaffMember["role"] | null
    onStaff: boolean
    position: EscrowPosition
    schedule: EscrowSchedule | null
    /** When this person's last schedule ended; a new one can't start earlier. */
    endedAt: number | null
    /** The owner's default amount per shift. */
    shiftRate: number | null
    /** The keeper claims for this person when they have something claimable. */
    autoPay: boolean
    /** Shifts entered and not approved yet. */
    pending: { count: number; amount: number }
}

export type EscrowEventKind =
    | "funded"
    | "withdrawn"
    | "shift_approved"
    | "schedule_set"
    | "schedule_ended"
    | "claimed"
    | "shortfall"
    | "underfunded"
    | "debt_backed"
    | "debt_repaid"
    | "resigned"

/** One FairPayroll event from the indexer (confirmed blocks only), with its proof. */
export type EscrowEvent = {
    id: number
    kind: EscrowEventKind
    /** The block's time. */
    at: number
    amount: number
    /** The staff member it is about, if any. Name from the current staff list. */
    employee: { wallet: Wallet; name: string | null } | null
    /** A claim sent by someone other than the employee (the auto-pay keeper). */
    autoPaid: boolean
    /** Event-specific numbers, e.g. period and start for schedule_set, settled and debt for schedule_ended. */
    detail: Record<string, number>
    proof: { chainId: number; txHash: `0x${string}`; logIndex: number; blockNumber: number }
}

export type EscrowEventPage = { events: EscrowEvent[]; next: string | null }

/** GET /restaurants/:id/team-pay/escrow (owner only). */
export type EscrowView = {
    contract: Wallet
    employer: Wallet
    account: EscrowAccount
    members: EscrowMember[]
    pendingShifts: PayrollShift[]
    approvedShifts: PayrollShift[]
    /** What to add now to set pay aside for the next N days at today's rates (fundingNeeded). */
    suggestions: { days: number; amount: number }[]
    /** Whether auto-pay can run (the server has a keeper wallet). */
    keeper: boolean
    /** Other restaurants with the same owner wallet, which share this escrow. */
    sharedWith: number
    readAt: number
} & EscrowEventPage

/** GET /restaurants/:id/team-pay/escrow/mine (the staff member's own position). */
export type MyEscrowView = {
    contract: Wallet
    employer: Wallet
    position: EscrowPosition
    schedule: EscrowSchedule | null
    autoPay: boolean
    shifts: PayrollShift[]
    readAt: number
} & EscrowEventPage

/** POST /restaurants/:id/team-pay/shifts/approve. "pending" comes with 202: ask again. */
export type ShiftApproveResult =
    | { status: "recorded"; shifts: PayrollShift[] }
    | { status: "pending"; reason: string }
    | { status: "rejected"; reason: string }
