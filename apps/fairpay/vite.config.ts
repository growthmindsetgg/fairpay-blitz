import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
    plugins: [react()],
    server: { port: 5174, proxy: { "/api": "http://127.0.0.1:8788" } },
    preview: { port: 4174 },
    build: { target: "es2022", chunkSizeWarningLimit: 4000, outDir: "dist" }
})
