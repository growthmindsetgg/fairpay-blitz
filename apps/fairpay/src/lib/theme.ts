import { useCallback, useEffect, useState } from "react"

/**
 * The theme switch: System (follow the OS, the default), Light or Dark. The choice lives in
 * localStorage and shows up as data-theme="light|dark" on <html> (absent for System); the CSS
 * keys every dark rule on it (see the top of styles/tokens.css).
 *
 * public/theme-init.js applies the stored choice before first paint (the CSP allows only
 * same-origin scripts, so it can't be inline). Keep its key and values in step with this file.
 */
export type ThemeChoice = "system" | "light" | "dark"

export const THEME_KEY = "fairpay.theme"
export const THEME_CHOICES: ThemeChoice[] = ["system", "light", "dark"]
export const THEME_LABEL: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" }

export function readTheme(): ThemeChoice {
    try {
        const v = localStorage.getItem(THEME_KEY)
        return v === "light" || v === "dark" ? v : "system"
    } catch {
        return "system"
    }
}

export function applyTheme(choice: ThemeChoice) {
    const root = document.documentElement
    if (choice === "system") root.removeAttribute("data-theme")
    else root.setAttribute("data-theme", choice)
}

function storeTheme(choice: ThemeChoice) {
    try {
        if (choice === "system") localStorage.removeItem(THEME_KEY)
        else localStorage.setItem(THEME_KEY, choice)
    } catch {
        // Private mode or blocked storage: the choice lasts for this page only.
    }
}

const listeners = new Set<(c: ThemeChoice) => void>()

export function setTheme(choice: ThemeChoice) {
    storeTheme(choice)
    applyTheme(choice)
    listeners.forEach((l) => l(choice))
}

/** The current choice and a setter; every switch on the page (sidebar, phone header) stays in step. */
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
    const [choice, setChoice] = useState<ThemeChoice>(readTheme)
    useEffect(() => {
        listeners.add(setChoice)
        // Another tab changed it.
        const onStorage = (e: StorageEvent) => {
            if (e.key !== THEME_KEY && e.key !== null) return
            const c = readTheme()
            applyTheme(c)
            setChoice(c)
        }
        window.addEventListener("storage", onStorage)
        return () => {
            listeners.delete(setChoice)
            window.removeEventListener("storage", onStorage)
        }
    }, [])
    return [choice, useCallback((c: ThemeChoice) => setTheme(c), [])]
}
