// Private note helpers. A note is a bearer secret for one 5 USDC deposit in the FairPay pool.
// Kept as a seam so the rest of the app never imports note code from the SDK directly.

export { createNote, parseNote, serializeNote, type Note } from "@fairpay/sdk"
