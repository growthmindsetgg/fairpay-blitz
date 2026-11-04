import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// `--mode demo` (or VITE_DEMO=1) builds the static demo: served under /app/, with a simulated
// server and chain in the browser, written to dist-demo. Any other mode is the real app.
export default defineConfig(({ mode }) => {
    const demo = mode === "demo" || process.env.VITE_DEMO === "1"
    return {
        base: demo ? "/app/" : "/",
        plugins: [
            react(),
            // The demo tab says it is a simulation, so it is never mistaken for the real FairPay app.
            {
                name: "demo-title",
                transformIndexHtml: (html: string) =>
                    demo ? html.replace("<title>Saffron Table · FairEats</title>", "<title>Simulated demo · Saffron Table · FairEats</title>") : html
            }
        ],
        // Always a string literal, so `import.meta.env.VITE_DEMO === "1"` folds to a constant and the
        // real build drops every demo branch and its dynamic import.
        // The demo never reads .env files: it needs no settings and must not pick up any.
        envDir: demo ? "src/demo" : undefined,
        define: { "import.meta.env.VITE_DEMO": JSON.stringify(demo ? "1" : "") },
        server: {
            port: demo ? 5180 : 5173,
            proxy: demo ? undefined : { "/api": "http://127.0.0.1:8787" }
        },
        preview: { port: demo ? 5180 : 4173 },
        build: { target: "es2022", chunkSizeWarningLimit: 4000, outDir: demo ? "dist-demo" : "dist" }
    }
})
