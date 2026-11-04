import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react"

type FieldBase = {
    label: ReactNode
    /** Helper text under the field, linked with aria-describedby. */
    hint?: ReactNode
    /** Error text; marks the control aria-invalid and is announced. */
    error?: string | null
    /** Visually hide the label (it stays for screen readers). */
    hideLabel?: boolean
    /** Shown after the label, e.g. "optional". */
    optional?: boolean
    className?: string
}

type ControlProps = { id: string; "aria-describedby"?: string; "aria-invalid"?: true }

/**
 * Label + control + hint + error. Pass a render function to wire your own control:
 * <Field label="Name">{(p) => <input {...p} className="input" />}</Field>
 * Most forms use Input / Textarea / Select below, which do this for you.
 */
export function Field({
    label,
    hint,
    error,
    hideLabel,
    optional,
    className,
    children
}: FieldBase & { children: (props: ControlProps) => ReactNode }) {
    const id = `f${useId().replace(/:/g, "")}`
    const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined
    return (
        <div className={["field", error ? "has-error" : "", className].filter(Boolean).join(" ")}>
            <label htmlFor={id} className={hideLabel ? "sr-only" : "field-label"}>
                {label}
                {optional && <span className="field-optional"> (optional)</span>}
            </label>
            {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
            {hint && (
                <p className="field-hint" id={`${id}-hint`}>
                    {hint}
                </p>
            )}
            {error && (
                <p className="field-error" id={`${id}-err`} role="alert">
                    {error}
                </p>
            )}
        </div>
    )
}

type InputProps = FieldBase & Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { suffix?: ReactNode }

/** Text-like input with label. `suffix` renders a unit after the box (e.g. "USDC"). */
export function Input({ label, hint, error, hideLabel, optional, className, suffix, ...rest }: InputProps) {
    return (
        <Field label={label} hint={hint} error={error} hideLabel={hideLabel} optional={optional} className={className}>
            {(p) =>
                suffix ? (
                    <div className="input-group">
                        <input {...rest} {...p} className="input" />
                        <span className="input-suffix" aria-hidden="true">
                            {suffix}
                        </span>
                    </div>
                ) : (
                    <input {...rest} {...p} className="input" />
                )
            }
        </Field>
    )
}

export function Textarea({ label, hint, error, hideLabel, optional, className, ...rest }: FieldBase & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">) {
    return (
        <Field label={label} hint={hint} error={error} hideLabel={hideLabel} optional={optional} className={className}>
            {(p) => <textarea rows={3} {...rest} {...p} className="input textarea" />}
        </Field>
    )
}

export function Select({
    label,
    hint,
    error,
    hideLabel,
    optional,
    className,
    options,
    ...rest
}: FieldBase & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & { options: { value: string; label: string; disabled?: boolean }[] }) {
    return (
        <Field label={label} hint={hint} error={error} hideLabel={hideLabel} optional={optional} className={className}>
            {(p) => (
                <select {...rest} {...p} className="input select">
                    {options.map((o) => (
                        <option key={o.value} value={o.value} disabled={o.disabled}>
                            {o.label}
                        </option>
                    ))}
                </select>
            )}
        </Field>
    )
}

/** A checkbox with its label to the right. */
export function Checkbox({
    label,
    hint,
    className,
    ...rest
}: { label: ReactNode; hint?: ReactNode; className?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id">) {
    const id = `c${useId().replace(/:/g, "")}`
    return (
        <div className={["check", className].filter(Boolean).join(" ")}>
            <input type="checkbox" id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...rest} />
            <label htmlFor={id}>
                {label}
                {hint && (
                    <span className="field-hint" id={`${id}-hint`}>
                        {hint}
                    </span>
                )}
            </label>
        </div>
    )
}

/** An on/off switch (a checkbox with role="switch"). */
export function Switch({
    label,
    checked,
    onChange,
    disabled,
    hideLabel
}: {
    label: ReactNode
    checked: boolean
    onChange: (next: boolean) => void
    disabled?: boolean
    hideLabel?: boolean
}) {
    const id = `s${useId().replace(/:/g, "")}`
    return (
        <span className="switch">
            <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <label htmlFor={id}>
                <span className="switch-track" aria-hidden="true">
                    <span className="switch-thumb" />
                </span>
                <span className={hideLabel ? "sr-only" : "switch-label"}>{label}</span>
            </label>
        </span>
    )
}

/**
 * A segmented choice (radio group). Use for 2-4 mutually exclusive options, e.g. Simple / Advanced.
 */
export function Segmented<T extends string>({
    label,
    value,
    onChange,
    options,
    hideLabel
}: {
    label: string
    value: T
    onChange: (v: T) => void
    options: { value: T; label: ReactNode; disabled?: boolean }[]
    hideLabel?: boolean
}) {
    const name = `g${useId().replace(/:/g, "")}`
    return (
        <fieldset className="segmented">
            <legend className={hideLabel ? "sr-only" : "field-label"}>{label}</legend>
            <div className="segmented-row">
                {options.map((o) => (
                    <label key={o.value} className="segmented-option" data-checked={value === o.value || undefined} data-disabled={o.disabled || undefined}>
                        <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
                        <span>{o.label}</span>
                    </label>
                ))}
            </div>
        </fieldset>
    )
}
