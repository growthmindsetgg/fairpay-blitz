import deployment from "../../../../packages/contracts/deployments/monadTestnet.json"

// True only in the static demo build (VITE_DEMO=1). Vite inlines the value at build time, so in the
// real build every `if (DEMO)` branch is dead code and the minifier drops it.
export const DEMO = import.meta.env.VITE_DEMO === "1"

/**
 * The real privacy pool on Monad Testnet, whose explorer page lists its private payments: the one
 * explorer link the demo shows, labelled as real. The address comes from the deployment record.
 */
export const REAL_POOL_URL = `https://testnet.monadexplorer.com/address/${deployment.pool}`
