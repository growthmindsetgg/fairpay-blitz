// Everything the demo build swaps in. Loaded only when VITE_DEMO is "1", through a dynamic
// import in api.ts, wallet.tsx, payments.ts and main.tsx, so the real bundle contains none of it.
// No file under src/demo may import a value from the app's own files: those files await this
// module at the top level, so such an import would deadlock.

export { demoCall } from "./server"
export * as sim from "./chain"
export { DemoBanner } from "./DemoBanner"
export { DemoExplorer } from "./DemoExplorer"
export { DEMO_COOK_MS, DEMO_KITCHEN_PIN, DEMO_MARKER, DEMO_WALLET, REAL } from "./config"
export { shortDemoId } from "./chain"

export * from "./lifecycle"
