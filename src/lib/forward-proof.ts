/**
 * Proof that a loopback request claiming to be for a paired device (`x-walnut-origin: remote-http`)
 * is this server's own forward, not a local process that wrote the header itself.
 *
 * The server calls itself for a client off this machine (the companion's forwarded calls, a
 * relayed plugin request, an op run for the phone) and labels the call `remote-http`, which reads
 * as the person (web/routes/person-caller.ts). A plain `curl -H 'x-walnut-origin: remote-http'
 * localhost:3456` wrote the same label (2026-11-28 review). So every such self-call carries this
 * secret, minted in this process's memory, never in env, a file or a session; a loopback request
 * claiming remote-http without it is not the person (routes/local-person-proof.ts).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

export const FORWARD_PROOF_HEADER = 'x-walnut-forward-proof'

const SECRET = randomBytes(32).toString('hex')

/** The header a self-call made for a client off this machine carries. */
export function forwardProofHeader(): Record<string, string> {
  return { [FORWARD_PROOF_HEADER]: SECRET }
}

/** Whether `value` is this process's own forward proof (constant time). */
export function isForwardProof(value: string | string[] | undefined): boolean {
  const v = Array.isArray(value) ? value[0] : value
  if (typeof v !== 'string' || v.length !== SECRET.length) return false
  return timingSafeEqual(Buffer.from(v), Buffer.from(SECRET))
}
