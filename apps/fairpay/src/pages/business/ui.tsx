// Small pieces shared by the FairEats pages. App-wide components (Money, PayShare, ...) come from
// src/components; these are restaurant-specific.

import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import type { MenuItem, Order, Table } from "../../../shared/types"
import { Icon } from "../../components/Icon"
import { mediaUrl } from "../../lib/base"
import { errorText, fe } from "./client"

export { usdc, shortHex, isWallet, percent, plural } from "../../lib/format"
export { Loading } from "../../components"

// ------------------------------------------------------------------ money and time

/** "12.5" → 12_500_000. Whole cents only, as the server requires. null when not a valid price. */
export function parsePrice(input: string, max = 100_000): number | null {
    const s = input.trim()
    if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null
    const [w, f = ""] = s.split(".")
    const micro = Number(w) * 1_000_000 + Number(f.padEnd(2, "0")) * 10_000
    return micro > 0 && micro <= max * 1_000_000 ? micro : null
}

export function microToInput(micro: number) {
    const cents = Math.round(micro / 10_000)
    return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`
}

const IST = "Asia/Kolkata"

export function istDate(ms: number) {
    return new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" }).format(ms)
}

export function istDateTime(ms: number) {
    return new Intl.DateTimeFormat("en-IN", {
        timeZone: IST,
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    }).format(ms)
}

export function istTime(ms: number) {
    return new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: true }).format(ms)
}

/** Start of today in India, as unix ms (for "today's orders"). */
export function startOfTodayIst(now = Date.now()) {
    const offset = 330 * 60_000
    const local = now + offset
    return local - (local % 86_400_000) - offset
}

export function minutesSince(ms: number, now = Date.now()) {
    return Math.max(0, Math.floor((now - ms) / 60_000))
}

export function waitText(minutes: number) {
    if (minutes <= 0) return "Any moment now"
    if (minutes === 1) return "About 1 minute"
    return `About ${minutes} minutes`
}

// Links work both at "/" and under the website's "/pay/" (src/lib/base.ts).
export { absoluteUrl, toPath } from "../../lib/base"

// ------------------------------------------------------------------ labels

export const TABLE_STATUS: Record<Table["status"], string> = {
    available: "Free",
    occupied: "Occupied",
    reserved: "Reserved",
    closed: "Closed"
}

export const ORDER_STATUS: Record<Order["status"], string> = {
    awaiting_payment: "Awaiting payment",
    paid: "Paid",
    cooking: "Cooking",
    ready: "Ready",
    served: "Served",
    cancelled: "Cancelled"
}

export const SPICE_LABEL = ["Not spicy", "Mild", "Medium", "Hot"]

// ------------------------------------------------------------------ small visual pieces

/** Indian food-label convention: green square-dot for veg, brown triangle for non-veg. Shape, not only colour. */
export function VegMark({ veg }: { veg: boolean }) {
    return (
        <span className={`fe-veg ${veg ? "is-veg" : "is-nonveg"}`} role="img" aria-label={veg ? "Vegetarian" : "Non-vegetarian"}>
            <svg viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <rect x="0.75" y="0.75" width="12.5" height="12.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
                {veg ? <circle cx="7" cy="7" r="3.2" fill="currentColor" /> : <path d="M7 3.4 L10.6 10 H3.4 Z" fill="currentColor" />}
            </svg>
        </span>
    )
}

export function SpiceMark({ level }: { level: number }) {
    if (level <= 0) return null
    return (
        <span className="fe-spice" role="img" aria-label={`${SPICE_LABEL[level] ?? "Spicy"} spice`} title={SPICE_LABEL[level]}>
            {Array.from({ length: 3 }, (_, i) => (
                <svg key={i} viewBox="0 0 10 14" aria-hidden="true" focusable="false" className={i < level ? "on" : "off"}>
                    <path d="M5 1.5c.6 1.2 1.6 1.7 2.6 2.4C9 5 9.3 6.6 9 8.4 8.5 11 6.8 12.8 5 12.8S1.5 11 1 8.4C.7 6.6 1 5 2.4 3.9 3.4 3.2 4.4 2.7 5 1.5Z" />
                </svg>
            ))}
        </span>
    )
}

/** A status chip. "violet" is Confidential: an ink chip with a lock, never the purple accent. */
export function Chip({ tone = "plain", children }: { tone?: "plain" | "basil" | "violet" | "saffron" | "muted" | "chili"; children: ReactNode }) {
    return (
        <span className={`fe-chip fe-chip--${tone}`}>
            {tone === "violet" ? <Icon name="lock" size={13} /> : <span className="fe-chip-dot" aria-hidden="true" />}
            {children}
        </span>
    )
}

export function TableChip({ status }: { status: Table["status"] }) {
    const tone = status === "available" ? "basil" : status === "occupied" ? "saffron" : "muted"
    return <Chip tone={tone}>{TABLE_STATUS[status]}</Chip>
}

/** A dish image, or a plain placeholder plate when there is none. Always lazy, always sized. */
export function DishImage({ item, className = "" }: { item: Pick<MenuItem, "image" | "name">; className?: string }) {
    const [broken, setBroken] = useState(false)
    if (!item.image || broken)
        return (
            <div className={`fe-dish-img fe-dish-img--empty ${className}`} aria-hidden="true">
                <svg viewBox="0 0 48 48" focusable="false">
                    <circle cx="24" cy="24" r="17" fill="none" stroke="currentColor" strokeWidth="2" />
                    <circle cx="24" cy="24" r="10" fill="currentColor" opacity="0.35" />
                </svg>
            </div>
        )
    return (
        <div className={`fe-dish-img ${className}`}>
            <img src={mediaUrl(item.image)} alt={item.name} loading="lazy" decoding="async" width={480} height={360} onError={() => setBroken(true)} />
        </div>
    )
}

export function Avatar({ src, name, size = 64 }: { src: string | null; name: string; size?: number }) {
    const [broken, setBroken] = useState(false)
    const initials = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]?.toUpperCase())
        .join("")
    return src && !broken ? (
        <img
            className="fe-avatar"
            src={mediaUrl(src)}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            style={{ width: size, height: size }}
            onError={() => setBroken(true)}
        />
    ) : (
        <span className="fe-avatar fe-avatar--initials" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.36 }}>
            {initials || "?"}
        </span>
    )
}

export function Alert({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "info" | "ok" }) {
    return (
        <p className={`fe-alert fe-alert--${tone}`} role={tone === "error" ? "alert" : "status"}>
            {children}
        </p>
    )
}

// ------------------------------------------------------------------ hooks

/** Calls fn now and every `ms` while `active`; skips ticks while the tab is hidden, catches up on return. */
export function usePoll(fn: () => void | Promise<unknown>, ms: number, active = true) {
    const ref = useRef(fn)
    ref.current = fn
    useEffect(() => {
        if (!active) return
        let stopped = false
        const tick = () => {
            if (!stopped && document.visibilityState !== "hidden") void ref.current()
        }
        void ref.current()
        const t = setInterval(tick, ms)
        const onVis = () => {
            if (document.visibilityState === "visible") tick()
        }
        document.addEventListener("visibilitychange", onVis)
        return () => {
            stopped = true
            clearInterval(t)
            document.removeEventListener("visibilitychange", onVis)
        }
    }, [ms, active])
}

/** Re-renders every `ms` so relative times stay current. */
export function useNow(ms: number) {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), ms)
        return () => clearInterval(t)
    }, [ms])
    return now
}

// ------------------------------------------------------------------ image upload

export const MAX_IMAGE_BYTES = 1_048_576
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"]

/** Checks size and the file's first bytes before uploading, so a wrong file fails fast and clearly. */
export async function checkImage(file: File): Promise<string | null> {
    if (file.size > MAX_IMAGE_BYTES) return `That image is ${(file.size / 1_048_576).toFixed(1)} MB. The limit is 1 MB.`
    if (file.size === 0) return "That file is empty."
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    const webp =
        String.fromCharCode(head[0], head[1], head[2], head[3]) === "RIFF" &&
        String.fromCharCode(head[8], head[9], head[10], head[11]) === "WEBP"
    if (!(png || jpeg || webp) || (file.type && !IMAGE_TYPES.includes(file.type)))
        return "Use a PNG, JPEG or WebP image."
    return null
}

/**
 * Pick → check → preview → upload. The parent gets the stored URL ("/api/images/<id>") through
 * onChange, and null when the image is removed.
 */
export function ImagePicker({
    restaurantId,
    value,
    onChange,
    label,
    shape = "wide",
    onBusy
}: {
    restaurantId: string
    value: string | null
    onChange: (url: string | null) => void
    label: string
    shape?: "wide" | "square"
    onBusy?: (busy: boolean) => void
}) {
    const id = useId()
    const input = useRef<HTMLInputElement>(null)
    const [preview, setPreview] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(
        () => () => {
            if (preview) URL.revokeObjectURL(preview)
        },
        [preview]
    )

    async function pick(file: File | undefined) {
        if (!file) return
        setError(null)
        const problem = await checkImage(file)
        if (problem) {
            setError(problem)
            if (input.current) input.current.value = ""
            return
        }
        setPreview(URL.createObjectURL(file))
        setBusy(true)
        onBusy?.(true)
        try {
            const { url } = await fe.uploadImage(restaurantId, file)
            onChange(url)
        } catch (e) {
            setError(errorText(e))
            setPreview(null)
        } finally {
            setBusy(false)
            onBusy?.(false)
            if (input.current) input.current.value = ""
        }
    }

    const shown = preview ?? value
    return (
        <div className={`fe-picker fe-picker--${shape}`}>
            <span className="fe-label" id={`${id}-l`}>
                {label}
            </span>
            <div className="fe-picker-row">
                <div className="fe-picker-frame" aria-hidden={shown ? undefined : true}>
                    {shown ? <img src={mediaUrl(shown)} alt={`Preview: ${label.toLowerCase()}`} /> : <span>No image</span>}
                    {busy && <span className="fe-picker-busy">Uploading…</span>}
                </div>
                <div className="fe-picker-actions">
                    <input
                        ref={input}
                        id={`${id}-f`}
                        className="fe-file"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        aria-describedby={`${id}-h${error ? ` ${id}-e` : ""}`}
                        onChange={(e) => void pick(e.target.files?.[0])}
                        disabled={busy}
                    />
                    <label htmlFor={`${id}-f`} className="btn btn-secondary btn-sm" aria-disabled={busy || undefined}>
                        {shown ? "Replace image" : "Choose image"}
                    </label>
                    {shown && !busy && (
                        <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            onClick={() => {
                                setPreview(null)
                                onChange(null)
                            }}
                        >
                            Remove
                        </button>
                    )}
                    <span className="fe-hint" id={`${id}-h`}>
                        PNG, JPEG or WebP, up to 1 MB.
                    </span>
                </div>
            </div>
            {error && (
                <span className="fe-field-error" id={`${id}-e`} role="alert">
                    {error}
                </span>
            )}
        </div>
    )
}
