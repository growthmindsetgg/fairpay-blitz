import { Link } from "react-router-dom"
import { useTitle } from "../components/Page"

export function NotFound() {
    useTitle("Page not found")
    return (
        <div className="content">
            <div className="notfound">
                <h1 className="page-title">We couldn't find that page</h1>
                <p className="muted">The link may be mistyped or out of date. If someone sent it to you, ask them for a fresh link.</p>
                <div className="row">
                    <Link to="/" className="btn btn-primary">
                        Go home
                    </Link>
                    <Link to="/business/faireats" className="btn btn-secondary">
                        FairEats restaurants
                    </Link>
                </div>
            </div>
        </div>
    )
}
