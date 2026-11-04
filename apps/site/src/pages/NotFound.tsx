import { Link } from "react-router-dom"
import { APP_URL } from "../data"
import { TableArt } from "../components/TableArt"
import { PAGE_META } from "../meta"

export function NotFoundPage() {
    const meta = PAGE_META["/404"]
    return (
        <>
            <title>{meta.title}</title>
            <meta name="robots" content="noindex" />
            <section className="wrap notfound">
                <TableArt seats={["empty", "empty", "empty", "empty"]} table="404" className="table-art notfound-table" />
                <div>
                    <h1>This table isn't set</h1>
                    <p className="lead">The page you asked for doesn't exist. Nothing was paid.</p>
                    <div className="cta-row">
                        <Link className="btn-primary" to="/">
                            Go to the home page
                        </Link>
                        <a className="btn-secondary" href={APP_URL}>
                            Open FairPay
                        </a>
                    </div>
                </div>
            </section>
        </>
    )
}
