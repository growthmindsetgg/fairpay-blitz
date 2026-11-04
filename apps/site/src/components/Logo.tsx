// FairPay logo: the "fair share" mark (a bill drawn as a disc with one quarter lifted out,
// hollow for a confidential share) and the outlined "FairPay" wordmark. Geometry and rules:
// apps/site/public/brand/BRAND.md. The paths are written by apps/site/scripts/make-mark.mjs,
// the same construction as the SVG files in public/brand. Presentation attributes only (no
// inline style), so it is safe under the CSP.

type Tone = "dark" | "light" | "current"

type LogoProps = {
    /** "full" is the horizontal lockup, "mark" is the symbol alone. */
    variant?: "full" | "mark"
    /** "dark" = purple and ink artwork for light backgrounds, "light" = artwork for dark
     *  backgrounds, "current" = one colour taken from CSS `color`. */
    tone?: Tone
    /** Rendered height in px. The mark is square; the lockup width follows its ratio. */
    size?: number
    /** Accessible name. Pass null when the logo sits inside a link or button that already
     *  has its own label, so it is not announced twice. */
    title?: string | null
    className?: string
}

const COLORS: Record<Tone, { main: string; smallShare: string; word: string }> = {
    dark: { main: "#5536F0", smallShare: "#F2A93B", word: "#16112E" },
    light: { main: "#AD9EFF", smallShare: "#F2A93B", word: "#F4F1FF" },
    current: { main: "currentColor", smallShare: "currentColor", word: "currentColor" },
}

// 48-unit grid: a disc r 18 at (22.5, 25.5) with its north-east quarter lifted 3.5 units along
// the diagonal. The hole leaves a 3-unit wall, so the lifted share reads as hollow.
export const SHARE_REST = "M22.5 25.5L40.5 25.5A18 18 0 1 1 22.5 7.5Z"
export const SHARE_PIECE = "M26 22L26 4A18 18 0 0 1 44 22Z"
export const SHARE_HOLE = "M29 19L29 7.3A15 15 0 0 1 40.7 19Z"

// "FairPay" in Bricolage Grotesque (SIL OFL 1.1) at opsz 48, wght 700, outlined to paths.
const WORD = "M130.8 82.5V16.5H145.2V82.5ZM137.7 57.9V46.1H174.4V57.9ZM137.7 28.7V16.5H178.1V28.7ZM194.7 83.9Q190.5 83.9 187 82.3Q183.5 80.7 181.5 77.4Q179.4 74.2 179.4 69.2Q179.4 64.7 181.1 61.7Q182.9 58.8 186.1 56.9Q189.3 55.1 193.6 54Q197.9 52.9 203.1 52.1Q207.1 51.4 209.4 50.9Q211.7 50.4 212.7 49.4Q213.7 48.5 213.7 46.7Q213.7 43.6 211.5 41.7Q209.3 39.8 205.2 39.8Q202.5 39.8 200.1 40.8Q197.7 41.7 196 43.8Q194.3 45.9 193.9 49.3L181.1 46.6Q181.8 41.7 183.9 38.3Q186.1 34.9 189.4 32.7Q192.8 30.6 196.9 29.6Q201 28.6 205.6 28.6Q213.1 28.6 218 31.2Q222.9 33.8 225.4 39Q227.8 44.2 227.8 52.1V61.3Q227.8 64.7 227.9 68.3Q228 71.9 228.1 75.4Q228.3 79 228.5 82.5H215.8Q215.6 79.4 215.4 75.9Q215.3 72.5 215.2 68.7H213.9Q212.8 72.9 210.2 76.4Q207.6 79.8 203.7 81.8Q199.8 83.9 194.7 83.9ZM200.6 73.3Q202.6 73.3 204.6 72.6Q206.7 71.9 208.6 70.4Q210.4 69 211.8 66.7Q213.2 64.4 213.8 61.3L213.7 55.4L216.2 55.5Q214.8 56.8 212.5 57.6Q210.3 58.3 207.8 58.8Q205.2 59.2 202.7 59.7Q200.2 60.2 198.1 61Q196 61.8 194.8 63.2Q193.5 64.6 193.5 67Q193.5 70 195.5 71.7Q197.5 73.3 200.6 73.3ZM237.6 82.5V30H252V82.5ZM244.8 23.6Q240.6 23.6 238.4 21.8Q236.2 20 236.2 16.6Q236.2 13.2 238.4 11.4Q240.6 9.6 244.8 9.6Q249.1 9.6 251.3 11.4Q253.6 13.2 253.6 16.6Q253.6 19.9 251.3 21.8Q249.1 23.6 244.8 23.6ZM262.4 82.5V56.2L262.4 30H274.6L274.5 49.5H276Q276.7 42.1 278.5 37.5Q280.4 33 283.6 30.9Q286.8 28.8 291.3 28.8Q292.6 28.8 294 29Q295.3 29.3 296.9 29.8L296.3 45.4Q294.5 44.5 292.6 44.1Q290.8 43.7 289.2 43.7Q285.5 43.7 282.9 45.6Q280.3 47.5 278.7 51.2Q277.2 54.8 276.8 60.1V82.5ZM313 63.5V52.1H327.3Q334.3 52.1 337.9 49.2Q341.4 46.4 341.4 39.9Q341.4 33.9 338.1 30.9Q334.9 27.9 328.1 27.9H313V16.5H328.8Q334.8 16.5 339.9 17.9Q344.9 19.4 348.5 22.3Q352.1 25.2 354.1 29.6Q356 34 356 40Q356 47.7 352.6 53Q349.1 58.2 342.3 60.9Q335.6 63.5 325.6 63.5ZM302.8 82.5V16.5H317.2V82.5ZM375.2 83.9Q371 83.9 367.5 82.3Q364 80.7 362 77.4Q359.9 74.2 359.9 69.2Q359.9 64.7 361.6 61.7Q363.4 58.8 366.6 56.9Q369.8 55.1 374.1 54Q378.4 52.9 383.6 52.1Q387.6 51.4 389.9 50.9Q392.2 50.4 393.2 49.4Q394.2 48.5 394.2 46.7Q394.2 43.6 392 41.7Q389.8 39.8 385.7 39.8Q383 39.8 380.6 40.8Q378.2 41.7 376.5 43.8Q374.8 45.9 374.4 49.3L361.6 46.6Q362.3 41.7 364.4 38.3Q366.6 34.9 369.9 32.7Q373.3 30.6 377.4 29.6Q381.5 28.6 386.1 28.6Q393.6 28.6 398.5 31.2Q403.4 33.8 405.9 39Q408.3 44.2 408.3 52.1V61.3Q408.3 64.7 408.4 68.3Q408.5 71.9 408.6 75.4Q408.8 79 409 82.5H396.3Q396.1 79.4 395.9 75.9Q395.8 72.5 395.7 68.7H394.4Q393.3 72.9 390.7 76.4Q388.1 79.8 384.2 81.8Q380.3 83.9 375.2 83.9ZM381.1 73.3Q383.1 73.3 385.1 72.6Q387.2 71.9 389.1 70.4Q390.9 69 392.3 66.7Q393.7 64.4 394.3 61.3L394.2 55.4L396.7 55.5Q395.3 56.8 393 57.6Q390.8 58.3 388.3 58.8Q385.7 59.2 383.2 59.7Q380.7 60.2 378.6 61Q376.5 61.8 375.3 63.2Q374 64.6 374 67Q374 70 376 71.7Q378 73.3 381.1 73.3ZM437.4 99.5Q433.7 99.5 429.7 98.9Q425.8 98.2 422.2 96.8Q418.7 95.3 416 93.1L419.9 80.1Q423.2 83.5 427.8 85Q432.4 86.6 436.7 86.6Q442.1 86.6 445.6 84.4Q449 82.3 450.8 78Q452.6 73.7 452.7 67.5L453.2 58.1H451.5Q450.8 64.9 448.6 69.3Q446.4 73.6 442.9 75.6Q439.4 77.6 434.7 77.6Q429 77.6 425.1 74.7Q421.3 71.8 419.4 66Q417.5 60.3 417.5 51.8V30H431.9V48.3Q431.9 57.3 433.9 61.4Q436 65.5 440.3 65.5Q442.6 65.5 444.5 64.2Q446.3 63 447.6 60.6Q448.9 58.3 449.6 54.8Q450.3 51.3 450.3 46.7V30H464.7V68Q464.7 73.7 463.6 78.6Q462.6 83.5 460.5 87.3Q458.4 91.2 455.1 93.9Q451.9 96.7 447.5 98.1Q443.1 99.5 437.4 99.5Z"

const LOCKUP_W = 464.7
const LOCKUP_H = 99.5
// Places the 48-grid mark in the lockup: diameter 1.5 x cap height, centred on the cap midline.
const MARK_IN_LOCKUP = "translate(-4.5 -4.5) scale(2.25)"

// Below 24px the 3-unit wall of the hollow share falls near 1px, so the share is drawn solid
// saffron, as on the favicon.
const HOLLOW_MIN_PX = 24

function Mark({ tone, hollow }: { tone: Tone; hollow: boolean }) {
    const c = COLORS[tone]
    return (
        <>
            <path className="fp-logo__rest" fill={c.main} d={SHARE_REST} />
            {hollow ? (
                <path className="fp-logo__share" fill={c.main} fillRule="evenodd" d={SHARE_PIECE + SHARE_HOLE} />
            ) : (
                <path className="fp-logo__share fp-logo__share--solid" fill={c.smallShare} d={SHARE_PIECE} />
            )}
        </>
    )
}

export default function Logo({ variant = "full", tone = "dark", size = 28, title = "FairPay", className }: LogoProps) {
    const full = variant === "full"
    const hollow = size >= HOLLOW_MIN_PX
    const width = full ? Math.round((size * LOCKUP_W) / LOCKUP_H * 100) / 100 : size
    const a11y = title
        ? ({ role: "img", "aria-label": title } as const)
        : ({ "aria-hidden": true, focusable: "false" } as const)
    const cls = ["fp-logo", className].filter(Boolean).join(" ")

    if (!full) {
        return (
            <svg className={cls} viewBox="0 0 48 48" width={size} height={size} {...a11y}>
                <Mark tone={tone} hollow={hollow} />
            </svg>
        )
    }
    return (
        <svg className={cls} viewBox={`0 0 ${LOCKUP_W} ${LOCKUP_H}`} width={width} height={size} {...a11y}>
            <g transform={MARK_IN_LOCKUP}>
                <Mark tone={tone} hollow={hollow} />
            </g>
            <path className="fp-logo__word" fill={COLORS[tone].word} d={WORD} />
        </svg>
    )
}
