import { createElement, type ReactNode } from "react"

// A small, dependency-free tokenizer for the guide's code blocks. It runs during render, so the
// prerendered HTML already carries the coloured spans. Colours carry no product meaning; they
// are defined as --code-* tokens in styles.css.

export type Lang = "ts" | "bash" | "plain"

const TS_KEYWORDS = new Set(
    "const let var await async if else return import export from new function type try catch throw for of in as interface"
        .split(" ")
)
const TS_LITERALS = new Set(["true", "false", "null", "undefined"])

type Rule = [RegExp, string | ((m: string, src: string, end: number) => string | null)]

const TS_RULES: Rule[] = [
    [/\/\/[^\n]*/y, "comment"],
    [/\/\*[\s\S]*?\*\//y, "comment"],
    [/`(?:\\[\s\S]|[^`\\])*`/y, "string"],
    [/"(?:\\.|[^"\\\n])*"/y, "string"],
    [/'(?:\\.|[^'\\\n])*'/y, "string"],
    [/\b\d[\d_]*(?:\.\d+)?n?\b/y, "number"],
    [
        /[A-Za-z_$][\w$]*/y,
        (word, src, end) => {
            if (TS_KEYWORDS.has(word)) return "keyword"
            if (TS_LITERALS.has(word)) return "number"
            if (src[end] === "(") return "fn"
            return null
        }
    ]
]

const BASH_RULES: Rule[] = [
    [/#[^\n]*/y, "comment"],
    [/"(?:\\.|[^"\\\n])*"/y, "string"],
    [/'[^'\n]*'/y, "string"],
    [/(?<=^|\s)--?[A-Za-z][\w-]*/y, "number"],
    [/(?<=^|\n)\$(?=\s)/y, "comment"]
]

function tokenize(code: string, rules: Rule[]): ReactNode[] {
    const out: ReactNode[] = []
    let plain = ""
    let i = 0
    let key = 0
    const flush = () => {
        if (plain) out.push(plain)
        plain = ""
    }
    outer: while (i < code.length) {
        for (const [re, kind] of rules) {
            re.lastIndex = i
            const m = re.exec(code)
            if (!m || m[0].length === 0) continue
            const text = m[0]
            const cls = typeof kind === "function" ? kind(text, code, i + text.length) : kind
            if (cls) {
                flush()
                out.push(createElement("span", { key: key++, className: `tk-${cls}` }, text))
            } else {
                plain += text
            }
            i += text.length
            continue outer
        }
        plain += code[i]
        i++
    }
    flush()
    return out
}

export function highlight(code: string, lang: Lang): ReactNode[] {
    if (lang === "ts") return tokenize(code, TS_RULES)
    if (lang === "bash") return tokenize(code, BASH_RULES)
    return [code]
}

/** Map a code block label to a language. */
export function langFor(label: string): Lang {
    if (/typescript|tsx?$|javascript/i.test(label)) return "ts"
    if (/^(bash|powershell|shell)$/i.test(label)) return "bash"
    return "plain"
}
