import { StrictMode } from "react"
import { createRoot, hydrateRoot } from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import { App } from "./App"
import { wakeAppServer } from "./lib/wake"
import "./styles.css"

wakeAppServer()

const root = document.getElementById("root")!
const app = (
    <StrictMode>
        <BrowserRouter>
            <App />
        </BrowserRouter>
    </StrictMode>
)

// Built pages are prerendered (scripts/prerender.mjs), so hydrate them. The dev server serves
// an empty root, so render from scratch there.
if (root.firstElementChild) hydrateRoot(root, app)
else createRoot(root).render(app)
