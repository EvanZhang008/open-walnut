/**
 * What a host's daemon vouched for on one relayed call, held in this process's memory for the
 * op's own HTTP self-calls (capability-router.ts), named only by a random token this process
 * made. A route reads the held word by that token alone, so no other process can hand it one by
 * writing a header: it would need a token that never left this process.
 *
 * Used by every relayed word of that kind: a caller proof (core/approvals/relay-proof.ts), a
 * trigger check's call (core/hosts/trigger-caller.ts) and a plugin job's call
 * (core/plugin-jobs/job-caller.ts). Each keeps its own hold, so one kind's token never reads as
 * another's.
 */
import crypto from 'node:crypto'

/** The shape of every token a hold makes (24 random bytes, hex). */
export const RELAY_TOKEN_RE = /^[0-9a-f]{48}$/

export interface RelayHold<T> {
  /** Keep `value` for `ttlMs`; the token its self-calls carry, or undefined when full of live ones. */
  hold(value: T, now?: number): string | undefined
  /** The value a header's token names while it is held, else undefined. */
  get(token: unknown, now?: number): T | undefined
  /** Drop a token whose call has ended: its self-calls are over, so it holds no place any more. */
  release(token: string): void
  /** The tokens held and still live. */
  size(now?: number): number
  clear(): void
}

/**
 * A relayed call's self-calls land within a few seconds, so a minute covers a slow one. Full of
 * live ones, a hold keeps none rather than drop one a call still needs: the call then reads as
 * what it was without the word (an anonymous caller, an unchecked proof).
 */
export function createRelayHold<T>(opts: { ttlMs: number; max: number }): RelayHold<T> {
  const held = new Map<string, { value: T; until: number }>()
  return {
    hold(value, now = Date.now()) {
      for (const [k, v] of held) if (v.until <= now) held.delete(k)
      if (held.size >= opts.max) return undefined
      const token = crypto.randomBytes(24).toString('hex')
      held.set(token, { value, until: now + opts.ttlMs })
      return token
    },
    get(token, now = Date.now()) {
      const raw = Array.isArray(token) ? token[0] : token
      if (typeof raw !== 'string' || !RELAY_TOKEN_RE.test(raw.trim())) return undefined
      const h = held.get(raw.trim())
      return h && h.until > now ? h.value : undefined
    },
    release(token) { held.delete(token) },
    size(now = Date.now()) { let n = 0; for (const v of held.values()) if (v.until > now) n++; return n },
    clear() { held.clear() },
  }
}
