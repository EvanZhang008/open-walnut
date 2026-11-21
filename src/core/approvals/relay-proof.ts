/**
 * A host daemon's word about the process on its gateway socket (caller-proof-v1, gateway-core.ts),
 * carried from the relay (capability-router.ts) to the approvals route the op calls. The route
 * reads it only by a token this process made and keeps in memory for a minute, so no other
 * process can hand the route a proof by naming one in a header.
 */
import type { CallerProof } from '../../providers/gateway-core.js'
import { createRelayHold } from '../../lib/relay-hold.js'

export const CALLER_PROOF_HEADER = 'x-walnut-caller-proof'

interface Held { proof: CallerProof; sid: string; host: string }
const held = createRelayHold<Held>({ ttlMs: 60_000, max: 500 })

/** Keep a relayed proof for the op's own calls; returns the token its self-calls carry. */
export function holdRelayProof(proof: unknown, sid: string, host: string, now = Date.now()): string | undefined {
  if (!proof || typeof proof !== 'object' || (proof as CallerProof).v !== 1 || !sid || sid === 'external') return undefined
  const p = proof as CallerProof
  // Full of live ones, it holds none and the ask reads not checked (relay-hold.ts).
  return held.hold({
    proof: {
      v: 1, verified: p.verified === true,
      ...(p.unchecked === true ? { unchecked: true } : {}),
      ...(typeof p.pid === 'number' ? { pid: p.pid } : {}),
      ...(typeof p.process === 'string' ? { process: p.process.slice(0, 80) } : {}),
      ...(typeof p.ranBy === 'string' ? { ranBy: p.ranBy.slice(0, 300) } : {}),
    },
    sid, host,
  }, now)
}

/** The proof a self-call's token names, while it is held. */
export function relayProofOf(token: string | undefined, now = Date.now()): Held | undefined {
  return held.get(token, now)
}

export function _clearRelayProofsForTesting(): void { held.clear() }
