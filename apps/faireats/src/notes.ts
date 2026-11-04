// Note helpers the app uses. The real build uses the @fairpay/sdk ones; the static demo build
// (VITE_DEMO=1) swaps in simulated notes, so it never bundles or loads the Semaphore/Poseidon code.
// Each choice tests the build-time constant directly, so the unused side is dropped from the bundle.

import { createNote as sdkCreateNote, parseNote as sdkParseNote, serializeNote as sdkSerializeNote } from "@fairpay/sdk"

const demoNotes = import.meta.env.VITE_DEMO === "1" ? await import("./demo/notes") : undefined

export const createNote = import.meta.env.VITE_DEMO === "1" ? demoNotes!.createNote : sdkCreateNote
export const parseNote = import.meta.env.VITE_DEMO === "1" ? demoNotes!.parseNote : sdkParseNote
export const serializeNote = import.meta.env.VITE_DEMO === "1" ? demoNotes!.serializeNote : sdkSerializeNote
