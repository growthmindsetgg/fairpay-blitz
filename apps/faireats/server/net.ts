import { isIP } from "node:net"

/**
 * The key rate limits are counted under. IPv4-mapped IPv6 becomes plain IPv4, and IPv6 is cut to
 * its /64: one host usually owns a whole /64, so per-address limits would be free to bypass.
 */
export function ipKey(ip: string): string {
    let a = ip.trim()
    if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1)
    const zone = a.indexOf("%")
    if (zone !== -1) a = a.slice(0, zone)
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a)
    if (mapped) a = mapped[1]!
    const kind = isIP(a)
    if (kind === 4) return a
    if (kind !== 6) return "unknown"
    return expandIpv6(a).slice(0, 4).join(":") + "::/64"
}

function expandIpv6(a: string): string[] {
    let s = a.toLowerCase()
    // A trailing dotted quad (::1.2.3.4) is two hextets.
    const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
    if (v4) {
        const [b0, b1, b2, b3] = v4.slice(1).map(Number) as [number, number, number, number]
        s = s.slice(0, v4.index) + ((b0 << 8) | b1).toString(16) + ":" + ((b2 << 8) | b3).toString(16)
    }
    const [head, tail] = s.split("::") as [string, string | undefined]
    const h = head ? head.split(":") : []
    const t = tail ? tail.split(":") : []
    const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill("0")
    return [...h, ...fill, ...t].map((x) => x.padStart(4, "0"))
}

/**
 * The client address when the server sits behind `trustedHops` reverse proxies that each append
 * to X-Forwarded-For. Only the entries those proxies wrote are believed; anything to their left
 * came from the client and is ignored. With no trusted proxies the socket address is used.
 */
export function clientAddress(remote: string | undefined, forwardedFor: string | undefined, trustedHops: number): string {
    const socket = remote ?? "unknown"
    if (trustedHops <= 0 || !forwardedFor) return socket
    const hops = forwardedFor.split(",").map((s) => s.trim())
    if (hops.length < trustedHops) return socket
    const candidate = hops[hops.length - trustedHops]!
    return isIP(candidate) ? candidate : socket
}
