/**
 * A host daemon's word about the process on its gateway socket (caller-proof-v1, gateway-core.ts),
 * carried from the relay (capability-router.ts) to the approvals route the op calls. The route
 * reads it only by a token this process made and keeps in memory for a minute, so no other
 * process can hand the route a proof by naming one in a header.
 */
import crypto from 'node:crypto'
import type { CallerProof } from '../../providers/gateway-core.js'

export const CALLER_PROOF_HEADER = 'x-walnut-caller-proof'

const TTL_MS = 60_000
const MAX = 500

interface Held { proof: CallerProof; sid: string; host: string; until: number }
const held = new Map<string, Held>()

/** Keep a relayed proof for the op's own calls; returns the token its self-calls carry. */
export function holdRelayProof(proof: unknown, sid: string, host: string, now = Date.now()): string | undefined {
  if (!proof || typeof proof !== 'object' || (proof as CallerProof).v !== 1) return undefined
  for (const [k, v] of held) if (v.until <= now || held.size > MAX) held.delete(k)
  const p = proof as CallerProof
  const token = crypto.randomBytes(24).toString('hex')
  held.set(token, {
    proof: {
      v: 1, verified: p.verified === true,
      ...(typeof p.pid === 'number' ? { pid: p.pid } : {}),
      ...(typeof p.process === 'string' ? { process: p.process.slice(0, 80) } : {}),
      ...(typeof p.ranBy === 'string' ? { ranBy: p.ranBy.slice(0, 300) } : {}),
    },
    sid, host, until: now + TTL_MS,
  })
  return token
}

/** The proof a self-call's token names, while it is held. */
export function relayProofOf(token: string | undefined, now = Date.now()): Held | undefined {
  if (!token) return undefined
  const h = held.get(token)
  return h && h.until > now ? h : undefined
}

export function _clearRelayProofsForTesting(): void { held.clear() }
