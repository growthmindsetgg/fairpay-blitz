import { useCallback, useEffect, useRef, useState, type RefObject } from "react"

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)"

/** False on the server and on the first client render, then the real value (keeps hydration stable). */
export function usePrefersReducedMotion() {
    const [reduced, setReduced] = useState(false)
    useEffect(() => {
        if (typeof window.matchMedia !== "function") return
        const mq = window.matchMedia(REDUCED_QUERY)
        const on = () => setReduced(mq.matches)
        on()
        mq.addEventListener("change", on)
        return () => mq.removeEventListener("change", on)
    }, [])
    return reduced
}

export type CopyState = "idle" | "copied" | "manual"

/**
 * Copy text to the clipboard. On failure, select the given element's text so the visitor can
 * press Ctrl+C, and report "manual". The state returns to idle after a few seconds.
 */
export function useCopy() {
    const [state, setState] = useState<CopyState>("idle")
    const [key, setKey] = useState<string | null>(null)
    const timer = useRef<number | undefined>(undefined)

    useEffect(() => () => window.clearTimeout(timer.current), [])

    const copy = useCallback(async (text: string, select?: HTMLElement | null, id: string | null = null) => {
        window.clearTimeout(timer.current)
        setKey(id)
        try {
            if (!navigator.clipboard) throw new Error("no clipboard")
            await navigator.clipboard.writeText(text)
            setState("copied")
            timer.current = window.setTimeout(() => setState("idle"), 2000)
        } catch {
            if (select) {
                const range = document.createRange()
                range.selectNodeContents(select)
                const sel = window.getSelection()
                sel?.removeAllRanges()
                sel?.addRange(range)
            }
            setState("manual")
            timer.current = window.setTimeout(() => setState("idle"), 4000)
        }
    }, [])

    return { state, key, copy }
}

/**
 * The id of the heading being read: the last of `ids` whose top has scrolled above a line just
 * under the sticky header. One passive scroll listener, throttled with requestAnimationFrame.
 */
export function useActiveHeading(ids: string[], offset = 120) {
    const [active, setActive] = useState<string | undefined>(ids[0])
    const joined = ids.join("|")

    useEffect(() => {
        const list = joined ? joined.split("|") : []
        if (!list.length) return
        let frame = 0
        const measure = () => {
            frame = 0
            let current = list[0]
            for (const id of list) {
                const el = document.getElementById(id)
                if (el && el.getBoundingClientRect().top <= offset) current = id
            }
            // At the very bottom of the page, the last heading is the one being read.
            if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
                const last = list[list.length - 1]
                const el = document.getElementById(last)
                if (el && el.getBoundingClientRect().top < window.innerHeight) current = last
            }
            setActive(current)
        }
        const onScroll = () => {
            if (!frame) frame = window.requestAnimationFrame(measure)
        }
        measure()
        // A new page's headings can arrive with a lazy chunk, and a hash jump can land after it.
        const later = [150, 500, 1200].map((ms) => window.setTimeout(onScroll, ms))
        window.addEventListener("scroll", onScroll, { passive: true })
        window.addEventListener("resize", onScroll)
        window.addEventListener("hashchange", onScroll)
        return () => {
            later.forEach((t) => window.clearTimeout(t))
            window.removeEventListener("scroll", onScroll)
            window.removeEventListener("resize", onScroll)
            window.removeEventListener("hashchange", onScroll)
            if (frame) window.cancelAnimationFrame(frame)
        }
    }, [joined, offset])

    return active
}

/** True once the page has scrolled past `y` pixels. */
export function useScrolledPast(y = 8) {
    const [past, setPast] = useState(false)
    useEffect(() => {
        let frame = 0
        const measure = () => {
            frame = 0
            setPast(window.scrollY > y)
        }
        const onScroll = () => {
            if (!frame) frame = window.requestAnimationFrame(measure)
        }
        measure()
        window.addEventListener("scroll", onScroll, { passive: true })
        return () => {
            window.removeEventListener("scroll", onScroll)
            if (frame) window.cancelAnimationFrame(frame)
        }
    }, [y])
    return past
}

/** Close a <details> element on Escape (returning focus to its summary) and on a click outside. */
export function useDismissableDetails(ref: RefObject<HTMLDetailsElement | null>) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const el = ref.current
            if (e.key !== "Escape" || !el?.open) return
            el.open = false
            el.querySelector("summary")?.focus()
        }
        const onClick = (e: MouseEvent) => {
            const el = ref.current
            if (el?.open && e.target instanceof Node && !el.contains(e.target)) el.open = false
        }
        document.addEventListener("keydown", onKey)
        document.addEventListener("click", onClick)
        return () => {
            document.removeEventListener("keydown", onKey)
            document.removeEventListener("click", onClick)
        }
    }, [ref])
}
