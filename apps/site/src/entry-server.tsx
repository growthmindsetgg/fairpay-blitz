import { StrictMode } from "react"
import { prerenderToNodeStream } from "react-dom/static"
import { StaticRouter } from "react-router"
import { App } from "./App"

export { PAGE_META, ROUTES } from "./meta"

async function renderOnce(url: string): Promise<string> {
    const { prelude } = await prerenderToNodeStream(
        <StrictMode>
            <StaticRouter location={url}>
                <App />
            </StaticRouter>
        </StrictMode>,
        // Keep every Suspense boundary inline, so the HTML needs no inline script to reveal it.
        { progressiveChunkSize: Number.MAX_SAFE_INTEGER }
    )
    const chunks: Buffer[] = []
    for await (const chunk of prelude) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    return Buffer.concat(chunks).toString("utf8")
}

/**
 * Render one route to HTML. Used only at build time. The first pass loads the lazy guide chunks;
 * the second renders with them resolved, so nothing suspends and no reveal script is emitted.
 */
export async function render(url: string): Promise<string> {
    await renderOnce(url)
    return renderOnce(url)
}
