// Simulated private notes. Same text format and shapes as the @fairpay/sdk note functions, but the
// "commitment" is a keccak hash instead of a Poseidon hash, so the demo never loads the Semaphore
// or Poseidon code (or the WebAssembly it compiles). These notes only work in the simulated pool.

import { FairPayError, type FairPayDeployment, type Note } from "@fairpay/sdk"
import { getAddress, isAddress, keccak256, toHex } from "viem"

const NOTE_PREFIX = "fairpay-note-v1:"
// Base64 of exactly 32 bytes, as in the SDK.
const NOTE_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/

function demoIdentity(key: string) {
    // A number below the BN254 field size, like a real commitment.
    const commitment = BigInt(keccak256(toHex(`fairpay-demo-commitment:${key}`))) >> 3n
    return { commitment, export: () => key }
}

function randomKey() {
    const b = new Uint8Array(32)
    crypto.getRandomValues(b)
    return btoa(String.fromCharCode(...b))
}

export function createNote(deployment: FairPayDeployment): Note {
    if (!deployment.pool) throw new FairPayError("INVALID_INPUT", "this deployment has no privacy pool")
    return { chainId: deployment.chainId, pool: getAddress(deployment.pool), identity: demoIdentity(randomKey()) } as unknown as Note
}

export function serializeNote(note: Note): string {
    return NOTE_PREFIX + btoa(JSON.stringify({ chainId: note.chainId, pool: note.pool, key: note.identity.export() }))
}

export function parseNote(serialized: string): Note {
    if (!serialized.startsWith(NOTE_PREFIX)) throw new FairPayError("INVALID_INPUT", "not a FairPay note")
    let data: { chainId?: unknown; pool?: unknown; key?: unknown }
    try {
        data = JSON.parse(atob(serialized.slice(NOTE_PREFIX.length)))
    } catch {
        throw new FairPayError("INVALID_INPUT", "corrupted note")
    }
    if (typeof data !== "object" || data === null) throw new FairPayError("INVALID_INPUT", "corrupted note")
    if (!Number.isSafeInteger(data.chainId) || (data.chainId as number) <= 0) throw new FairPayError("INVALID_INPUT", "corrupted note")
    if (typeof data.pool !== "string" || !isAddress(data.pool)) throw new FairPayError("INVALID_INPUT", "corrupted note")
    if (typeof data.key !== "string" || !NOTE_KEY.test(data.key)) throw new FairPayError("INVALID_INPUT", "corrupted note")
    return { chainId: data.chainId as number, pool: getAddress(data.pool), identity: demoIdentity(data.key) } as unknown as Note
}
