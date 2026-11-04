import { APP_HOST } from "../data"

// Screenshots of the real FairPay app, so visitors see the product itself. Files live in
// public/shots, made from a local run with seeded demo data: desktop at 1440×900 (served at
// 1440w and 960w), phone at 390×844 @2x (served at 780w and 390w). Every image has its width and height, so nothing shifts.

type Desk = "home" | "bill" | "new-bill" | "storefront" | "order" | "kitchen" | "invoice"
type Phone = "home" | "bill" | "new-bill" | "order" | "invoice" | "storefront" | "kitchen"

/** A desktop screenshot in a quiet browser frame that shows the app's real address. */
export function BrowserShot({
    name,
    alt,
    sizes = "(min-width: 1264px) 1200px, calc(100vw - 32px)",
    eager = false,
    path = "",
    className = ""
}: {
    name: Desk
    alt: string
    sizes?: string
    eager?: boolean
    /** Shown after the host in the address bar, e.g. "/bills/…". Decorative. */
    path?: string
    className?: string
}) {
    return (
        <div className={`shot-browser ${className}`.trim()}>
            <div className="shot-bar" aria-hidden="true">
                <span className="shot-url">
                    {APP_HOST}
                    <span className="shot-path">{path}</span>
                </span>
            </div>
            <img
                src={`/shots/app-${name}-960.webp`}
                srcSet={`/shots/app-${name}-960.webp 960w, /shots/app-${name}-1440.webp 1440w`}
                sizes={sizes}
                width={1440}
                height={900}
                alt={alt}
                loading={eager ? "eager" : "lazy"}
                decoding="async"
                fetchPriority={eager ? "high" : undefined}
            />
        </div>
    )
}

/** A phone screenshot in a plain ink bezel. */
export function PhoneShot({
    name,
    alt,
    sizes = "260px",
    eager = false,
    className = ""
}: {
    name: Phone
    alt: string
    sizes?: string
    eager?: boolean
    className?: string
}) {
    return (
        <div className={`shot-phone ${className}`.trim()}>
            <img
                src={`/shots/phone-${name}-390.webp`}
                srcSet={`/shots/phone-${name}-390.webp 390w, /shots/phone-${name}-780.webp 780w`}
                sizes={sizes}
                width={390}
                height={844}
                alt={alt}
                loading={eager ? "eager" : "lazy"}
                decoding="async"
                fetchPriority={eager ? "high" : undefined}
            />
        </div>
    )
}
