// Applies the saved theme (System / Light / Dark, see src/lib/theme.ts) before the first paint,
// so a Dark choice on a light OS never flashes white. A file, not an inline script: the CSP
// only allows same-origin scripts.
try {
    var t = localStorage.getItem("fairpay.theme")
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t)
} catch (e) {}
