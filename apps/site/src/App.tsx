import { lazy } from "react"
import { Route, Routes } from "react-router-dom"
import { Layout } from "./components/Layout"
import { LandingPage } from "./pages/Landing"
import { NotFoundPage } from "./pages/NotFound"
import { AboutPage } from "./pages/About"
import { GuideLayout } from "./pages/guide/GuideLayout"

// Guide pages are separate chunks, so none of them loads on the landing page.
const Overview = lazy(() => import("./pages/guide/Overview"))
const Start = lazy(() => import("./pages/guide/Start"))
const Demo = lazy(() => import("./pages/guide/Demo"))
const HowItWorks = lazy(() => import("./pages/guide/HowItWorks"))
const Security = lazy(() => import("./pages/guide/Security"))
const Run = lazy(() => import("./pages/guide/Run"))
const Test = lazy(() => import("./pages/guide/Test"))
const Deploy = lazy(() => import("./pages/guide/Deploy"))
const Sdk = lazy(() => import("./pages/guide/Sdk"))
const Faq = lazy(() => import("./pages/guide/Faq"))

export function App() {
    return (
        <Layout>
            <Routes>
                <Route path="/" element={<LandingPage />} />
                <Route path="/guide" element={<GuideLayout />}>
                    <Route index element={<Overview />} />
                    <Route path="start" element={<Start />} />
                    <Route path="demo" element={<Demo />} />
                    <Route path="how-it-works" element={<HowItWorks />} />
                    <Route path="security" element={<Security />} />
                    <Route path="run" element={<Run />} />
                    <Route path="test" element={<Test />} />
                    <Route path="deploy" element={<Deploy />} />
                    <Route path="sdk" element={<Sdk />} />
                    <Route path="faq" element={<Faq />} />
                </Route>
                <Route path="/about" element={<AboutPage />} />
                <Route path="*" element={<NotFoundPage />} />
            </Routes>
        </Layout>
    )
}
