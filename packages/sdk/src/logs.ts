/** Runs eth_getLogs in block-range chunks, for RPCs that cap the range per request. */
export async function getLogsChunked<T>(
    fromBlock: bigint,
    toBlock: bigint,
    chunkSize: bigint,
    fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>
): Promise<T[]> {
    if (chunkSize <= 0n) throw new Error("chunkSize must be positive")
    const out: T[] = []
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
        const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n
        out.push(...(await fetch(start, end)))
    }
    return out
}
