# FairPay logo and colours

## Concept: fair share

The mark is a bill drawn as a disc with one quarter lifted out along the diagonal: your
share of it. FairPay splits a bill into shares, and each person pays their own.

At 24px and up the lifted quarter is hollow. A confidential share is paid, but who paid it
isn't shown. Below 24px the quarter turns solid saffron, so it still reads as a separate
piece.

The mark identifies FairPay. It does not explain zero-knowledge proofs and it does not vouch
for anything, so never pair it with "secure", "trusted" or audit language.

The table illustration (a round table from above with four chairs, used for the landing
page's hero table, the privacy flow and og.png) is drawn from `src/components/tablePlan.ts`.
It is not a logo.

## Files

| File | Use |
|---|---|
| `fairpay-logo.svg` | Lockup for light backgrounds (purple mark, ink wordmark) |
| `fairpay-logo-light.svg` | Lockup for dark backgrounds (lavender mark, pale wordmark) |
| `fairpay-logo-mono.svg` | Lockup in one colour (`currentColor`) |
| `fairpay-mark.svg` | Symbol for light backgrounds |
| `fairpay-mark-light.svg` | Symbol for dark backgrounds |
| `fairpay-mark-mono.svg` | Symbol in one colour (`currentColor`) |
| `../favicon.svg` | Favicon: a white disc and a saffron share on a purple tile (also `apps/fairpay/public/favicon.svg`) |
| `src/components/Logo.tsx` | The same artwork inline in React (and `apps/fairpay/src/components/Logo.tsx`) |

`currentColor` only takes a colour when the SVG is inline (for example through `Logo.tsx`).
In an `<img>` tag the mono files render black.

Every file uses flat fills and presentation attributes only. They contain no `<style>`,
fonts, scripts, raster images or external references, so they work under the CSP.

## Construction

The master grid is 48 × 48 units.

- **Bill:** a disc with r = 18, centred at (22.5, 25.5).
- **Share:** the north-east quarter, moved 3.5 units up and 3.5 units right, so the gap
  between the share and the rest is 3.5 units on both straight edges.
- **Hollow:** the share minus a hole inset by 3 units from its two straight edges and its
  arc (r = 15), cut out with `fill-rule="evenodd"`. That leaves a 3-unit wall.
- **Bounds:** the artwork runs from (4.5, 4) to (44, 43.5), so it sits about 4 units from
  every edge of the artboard.

`scripts/make-mark.mjs` builds every path from these numbers and writes both `Logo.tsx`
files, the six SVGs here, both favicons and `tablePlan.ts`. Change the construction there,
never by hand, then run `npm run og -w site` to redraw `og.png` and `apple-touch-icon.png`.

### Wordmark

- **Typeface:** "FairPay" in Bricolage Grotesque (SIL Open Font License 1.1) at opsz 48,
  wght 700, wdth 100, converted to paths, so the logo needs no font.
- **Spacing:** the font's own kerning, tracking −0.006em, and an extra −0.01em on r–P.

### Lockup

The lockup places the 48-unit mark with `translate(-4.5 -4.5) scale(2.25)` in a 464.7 ×
99.5 viewBox (1 em = 100 units, cap height 66). The width is about 4.67 × the height.

## Clear space

Keep clear space on every side of at least a quarter of the mark's width. At the 28px
header size that is about 6px.

## Minimum sizes

| Artwork | Minimum | Notes |
|---|---|---|
| Symbol with hollow share | 24px | The wall is 1.5px at 24px. |
| Symbol, solid saffron share | 16px | `Logo.tsx` switches to this automatically below 24px. |
| Favicon tile | 16px | Separate drawing, see below |
| Lockup | 20px tall (about 93px wide) | Recommended header size: 26 to 28px tall. |

## Favicon

Drawn separately on a 32-unit tile: a disc r = 11 at (14.6, 17.4), its quarter lifted 2.4
units. The tile is purple #5536F0 with rx = 7, the disc white and the share saffron
#F2A93B, with no hole. The tile keeps the mark visible on light and dark tab strips without
media queries, which matters because the CSP blocks `<style>` inside the SVG.

## Colour

The palette is close to Monad's public primary purple (#6E54FF), so it says "built on
Monad". It must never say "made by Monad": no Monad logo, no "official", and the line
"Independent project. Not affiliated with or endorsed by the Monad Foundation." on the site.

Each colour has one job:

| Meaning | Light | Dark |
|---|---|---|
| Action (filled buttons, current nav, focus) | `--accent` #6E54FF, white text 4.80:1 | same |
| Purple text and links | `--accent-ink` #5536F0 (6.62:1 on white) | #AD9EFF (7.84:1 on surface) |
| Verified on-chain | `--verified-ink` #17633F on #E1F3E9 (6.29:1) | #6FD3A0 on #15302A (7.73:1) |
| Owed, warning | `--warn-ink` #7A4A0E on #FFF2DB (6.74:1), dot #B8731A | #FFC870 on #33260F (9.65:1) |
| Confidential | ink chip #221C3D, white text, cyan lock #7FDFF0 (10.54:1) | pale chip #E6E2F5, ink text, lock #00718A (4.44:1) |
| Confidential in charts | teal #008DA6 | #1E9AB0 |
| Error | `--error` #B42318 on #FDEBE9 (5.71:1) | #FF8A7A on #3A1717 (6.97:1) |

Confidential differs from the purple accent in lightness as well as hue, so the two stay
apart under every colour-vision type (OKLab ΔE ≥ 32). Saffron #F2A93B appears only in the
logo's small share, the favicon and the FairEats food illustrations. The FSSAI veg and
non-veg marks keep their legal greens and browns.

Logo colours:

| Part | On light (#F6F4FE or white) | On dark (#0E0A1C) | One colour |
|---|---|---|---|
| Disc and share | Purple #5536F0 (6.08:1 on #F6F4FE) | Lavender #AD9EFF (8.45:1) | Any single colour |
| Wordmark | Ink #16112E | #F4F1FF | Same colour |
| Small solid share (under 24px) | Saffron #F2A93B | Saffron #F2A93B | Same colour |

## Motion (optional)

Motion is CSS only. `Logo.tsx` puts these classes on each part:

- `fp-logo__rest` on the disc
- `fp-logo__share` on the lifted share (`fp-logo__share--solid` when it is drawn solid)
- `fp-logo__word` on the wordmark

For a "bill settled" moment, the share can slide back into the disc (translate −3.5, 3.5 in
mark units) over 240ms with `cubic-bezier(.2,.7,.2,1)`, once. Under
`prefers-reduced-motion: reduce`, show the final state with no movement. Do not animate the
header logo.

## Do

- Use the files or `Logo.tsx` as they are. Scale them proportionally.
- Use the light-background artwork on #F6F4FE or white and the dark-background artwork on
  #0E0A1C or other dark surfaces.
- Give the logo its own accessible name ("FairPay"). If it sits inside a link that already
  has a label, mark it as decorative (`title={null}`).

## Don't

- Don't redraw the wordmark in live text or another typeface.
- Don't stretch, rotate, outline, add shadows or gradients, or put the logo inside a
  shield, padlock or badge.
- Don't close the gap, move the share to another quarter, or fill it in at 24px and above.
- Don't use the Monad logo, its rotated-square shape or its name styling next to the mark.
- Don't use the logo to imply an audit, a certification, a partnership or production
  readiness. FairPay is unaudited and runs on Monad Testnet only.
