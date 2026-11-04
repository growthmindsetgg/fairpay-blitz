// The FairPay app's server runs on a free host that sleeps after a quiet spell and takes up to a
// minute to wake. Every page of the website asks it for /api/health once on load, so it is
// already starting while the visitor reads, before they press "Open app". The request stays on
// this origin (the website forwards /api to the server), sends no cookies, and its answer is
// ignored.

export function wakeAppServer() {
    // The dev server has no /api.
    if (import.meta.env.DEV) return
    try {
        void fetch("/api/health", { credentials: "omit", cache: "no-store" }).catch(() => undefined)
    } catch {
        // Nothing to do: the app shows "Starting the server…" if it is still asleep.
    }
}
