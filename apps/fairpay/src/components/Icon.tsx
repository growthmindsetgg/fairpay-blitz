// A small stroke icon set drawn for FairPay (24-unit grid, 1.75 stroke, currentColor).
// Decorative by default; pass `label` when an icon is the only content of a control.

const PATHS = {
    home: "M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z",
    plus: "M12 5v14M5 12h14",
    inbox: "M4 13.5 6.5 5h11L20 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 13.5h4.5l1 2.5h5l1-2.5H20",
    users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c1.9.7 3.2 2.5 3.5 5.2",
    bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
    store: "M4 9.5 5.5 4h13L20 9.5M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5 12v8h14v-8M10 20v-5h4v5",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6",
    copy: "M9 9h10v11H9zM5 15V4h10",
    check: "M5 12.5 10 17l9-10",
    external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    chevronDown: "M6 9l6 6 6-6",
    chevronRight: "M9 6l6 6-6 6",
    chevronLeft: "M15 6l-6 6 6 6",
    close: "M6 6l12 12M18 6 6 18",
    wallet: "M4 7a2 2 0 0 1 2-2h12v4M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2zM16 14.5h1",
    lock: "M6.5 11h11v9h-11zM9 11V8a3 3 0 0 1 6 0v3",
    alert: "M12 4 2.5 20h19zM12 10v4.5M12 17.5v.01",
    receipt: "M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21zM9 8h6M9 12h6M9 16h3",
    activity: "M3 12h4l3-7 4 14 3-7h4",
    logout: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h10",
    trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
    menu: "M4 7h16M4 12h16M4 17h16",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8v.01",
    drop: "M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5z",
    split: "M12 3v6M12 9l-6 6v6M12 9l6 6v6"
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 20, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
    return (
        <svg
            className={className ? `icon ${className}` : "icon"}
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            role={label ? "img" : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
            focusable="false"
        >
            <path d={PATHS[name]} />
        </svg>
    )
}
