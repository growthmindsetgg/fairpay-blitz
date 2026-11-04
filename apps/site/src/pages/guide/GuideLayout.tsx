import { Suspense, useEffect, useRef } from "react"
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom"
import { GROUPS, GUIDE, guidePage, type GuidePage, type TocItem } from "./nav"
import { PAGE_META } from "../../meta"
import { useActiveHeading, useDismissableDetails } from "../../lib/hooks"

// Section anchors on /guide, mapped to the guide page that holds each section.
const LEGACY: Record<string, string> = {
    "try-the-demo": "/guide/demo",
    "how-a-table-pays": "/guide/how-it-works#how-a-table-pays",
    "private-payments": "/guide/how-it-works#private-payments",
    "run-locally": "/guide/run",
    "run-tests": "/guide/test",
    deploy: "/guide/deploy",
    "deploy-site": "/guide/deploy#deploy-site",
    "use-the-sdk": "/guide/sdk",
    security: "/guide/security",
    faq: "/guide/faq#faq",
    glossary: "/guide/faq#glossary"
}

// Group labels are plain text, not headings, so the page's h1 is the first heading in the
// document. Each list is named by its label instead.
function SideNav({ idPrefix }: { idPrefix: string }) {
    const { pathname } = useLocation()
    return (
        <>
            {GROUPS.map((g) => (
                <div key={g} className="side-group">
                    <p className="side-label" id={`${idPrefix}-${g.toLowerCase()}`}>
                        {g}
                    </p>
                    <ul aria-labelledby={`${idPrefix}-${g.toLowerCase()}`}>
                        {GUIDE.filter((p) => p.group === g).map((p) => (
                            <li key={p.path}>
                                <Link to={p.path} aria-current={pathname === p.path ? "page" : undefined}>
                                    {p.nav}
                                </Link>
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </>
    )
}

function TocList({ items, active, onPick }: { items: TocItem[]; active?: string; onPick?: () => void }) {
    return (
        <ul className="toc-list">
            {items.map((t) => (
                <li key={t.id} className={t.level === 3 ? "is-h3" : undefined}>
                    <a href={`#${t.id}`} aria-current={active === t.id ? "true" : undefined} onClick={onPick}>
                        {t.label}
                    </a>
                </li>
            ))}
        </ul>
    )
}

/** The phone "On this page" bar, with a reading-progress line moved by the visitor's own scroll. */
function PhoneToc({ page, active }: { page: GuidePage; active?: string }) {
    const box = useRef<HTMLDetailsElement>(null)
    const bar = useRef<HTMLSpanElement>(null)
    useDismissableDetails(box)

    useEffect(() => {
        let frame = 0
        const measure = () => {
            frame = 0
            const article = document.getElementById("top")
            const el = bar.current
            if (!article || !el) return
            const r = article.getBoundingClientRect()
            const total = r.height - window.innerHeight
            const p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 1
            el.style.transform = `scaleX(${p})`
        }
        const onScroll = () => {
            if (!frame) frame = window.requestAnimationFrame(measure)
        }
        measure()
        window.addEventListener("scroll", onScroll, { passive: true })
        window.addEventListener("resize", onScroll)
        return () => {
            window.removeEventListener("scroll", onScroll)
            window.removeEventListener("resize", onScroll)
            if (frame) window.cancelAnimationFrame(frame)
        }
    }, [page.path])

    const current = page.toc.find((t) => t.id === active) ?? page.toc[0]
    const close = () => {
        if (box.current) box.current.open = false
    }
    const label = `On this page · ${current.label}`
    return (
        <details className="toc-phone" ref={box}>
            <summary aria-label={label}>
                <span className="toc-phone-text">
                    On this page <span aria-hidden="true">·</span> <span className="toc-phone-current">{current.label}</span>
                </span>
            </summary>
            <nav aria-label="On this page">
                <TocList items={page.toc} active={active} onPick={close} />
            </nav>
            <span className="toc-progress" ref={bar} aria-hidden="true" />
        </details>
    )
}

export function GuideLayout() {
    const { pathname, hash } = useLocation()
    const navigate = useNavigate()
    const path = pathname.replace(/\/$/, "") || "/guide"
    const page = guidePage(path) ?? GUIDE[0]
    const meta = PAGE_META[page.path]
    const index = GUIDE.indexOf(page)
    const prev = GUIDE[index - 1]
    const next = GUIDE[index + 1]
    const active = useActiveHeading(
        page.toc.map((t) => t.id),
        120
    )
    const pages = useRef<HTMLDetailsElement>(null)

    useEffect(() => {
        if (pages.current) pages.current.open = false
    }, [pathname])

    // Section anchors on /guide itself, such as /guide#use-the-sdk, go to the page that holds that section.
    useEffect(() => {
        if (page.path !== "/guide" || !hash) return
        const target = LEGACY[decodeURIComponent(hash.slice(1))]
        if (target) navigate(target, { replace: true })
    }, [page.path, hash, navigate])

    return (
        <div className="wrap guide-grid">
            <title>{meta.title}</title>
            <meta name="description" content={meta.description} />

            <nav className="g-side" aria-label="Guide">
                <SideNav idPrefix="side" />
            </nav>

            <div className="g-main">
                {page.toc.length > 0 && <PhoneToc page={page} active={active} />}

                <article className="guide" id="top">
                    <details className="pages-phone" ref={pages}>
                        <summary>All guide pages</summary>
                        <nav aria-label="Guide pages">
                            <SideNav idPrefix="pages" />
                        </nav>
                    </details>

                    <header className="g-intro">
                        <nav className="crumbs" aria-label="Breadcrumb">
                            <ol>
                                <li>
                                    <Link to="/guide">Guide</Link>
                                </li>
                                <li>{page.group}</li>
                            </ol>
                        </nav>
                        <h1>{page.title}</h1>
                        <p className="g-type">{page.type}</p>
                    </header>

                    <Suspense fallback={null}>
                        <Outlet />
                    </Suspense>

                    <nav className="prevnext" aria-label="Previous and next pages">
                        {prev ? (
                            <Link className="pn pn-prev" to={prev.path}>
                                <span className="pn-label">Previous</span>
                                <span className="pn-title">{prev.title}</span>
                            </Link>
                        ) : (
                            <span />
                        )}
                        {next && (
                            <Link className="pn pn-next" to={next.path}>
                                <span className="pn-label">Next</span>
                                <span className="pn-title">{next.title}</span>
                            </Link>
                        )}
                    </nav>
                </article>
            </div>

            <aside className="g-rail">
                {page.toc.length > 0 && (
                    <nav aria-label="On this page" className="rail-nav">
                        <p className="rail-title">On this page</p>
                        <TocList items={page.toc} active={active} />
                        <p className="rail-top">
                            <a href="#top">Back to top</a>
                        </p>
                    </nav>
                )}
            </aside>
        </div>
    )
}
