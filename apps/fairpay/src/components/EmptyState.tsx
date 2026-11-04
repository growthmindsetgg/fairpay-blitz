import type { ReactNode } from "react"
import { Icon, type IconName } from "./Icon"

/** What to show when a list is empty: say what goes here and what to do next. */
export function EmptyState({
    title,
    children,
    action,
    icon
}: {
    title: string
    children?: ReactNode
    /** Usually a primary button or link. */
    action?: ReactNode
    icon?: IconName
}) {
    return (
        <div className="empty">
            {icon && (
                <span className="empty-icon">
                    <Icon name={icon} size={22} />
                </span>
            )}
            <h3 className="empty-title">{title}</h3>
            {children && <div className="empty-body">{children}</div>}
            {action && <div className="empty-action">{action}</div>}
        </div>
    )
}
