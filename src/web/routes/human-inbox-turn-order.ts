/**
 * Letter turns of a session whose relay to the Mac is out right now, by the turn's order key (its
 * session, send-order.ts): a later turn whose wait ran out behind one of them is neither relayed
 * nor kept (human-inbox-replica.ts replicaLetterTurn).
 */

/** Letter turns of each session (its order key) whose relay to the Mac is out right now. */
const relaysOut = new Map<string, number>()

/** `relay`, counted in relaysOut for the turn's session while it is out. */
export async function relayCounted<T>(key: string | null, relay: () => Promise<T>): Promise<T> {
  if (key === null) return relay()
  relaysOut.set(key, (relaysOut.get(key) ?? 0) + 1)
  try {
    return await relay()
  } finally {
    const n = (relaysOut.get(key) ?? 1) - 1
    if (n > 0) relaysOut.set(key, n)
    else relaysOut.delete(key)
  }
}

/** Whether a letter turn of this order key is in its relay to the Mac now. */
export function relayOut(key: string): boolean {
  return (relaysOut.get(key) ?? 0) > 0
}
