/**
 * The one rule for the companion's direct paths to a host's daemon (land 5b, review round 1): a
 * session its host runs and judges itself is NEVER sent direct to a daemon by any companion path.
 * Its host's one Walnut service holds its queue, its prompts and its turn; a line written into
 * the CLI behind it is a line its judge never saw.
 *
 * A session is its host's own when the companion's copy says so (the row's `judge: 'host'`,
 * session-projection.ts) or a listener link claimed it (companion-listener.ts claimedBy). Both,
 * because the claim is memory only (a restarted companion has none until the host links again)
 * and the copy can lag a session born while the Mac was away.
 *
 * The direct paths, each asking `directToDaemonAllowed` before its first byte (ratchet:
 * tests/core/session-channel/host-judged-direct-ratchet.test.ts):
 *   - sessions/direct-host-send.ts deliverDirectToHost: the bridge `send`, behind the phone's
 *     direct fallback (cloud-send-direct.ts), the banked-send sweep (send-queue-sweep.ts) and the
 *     inbox takeover (human-inbox-takeover.ts)
 *   - web/routes/bridge-send.ts: the Mac's `send` and `session.permission` through the companion
 *   - leader/host-session-control.ts: `leader.control` (Stop, a prompt's answer, a mode) while the
 *     companion leads the host
 * A path that is refused keeps the message where it was (banked for the Mac's relay or the host's
 * link, or the phone told 503 host_unreachable): never a loss, never a second judge.
 */
import { log } from '../../logging/index.js'

/** The host that judges `sid` itself, by the copy's row or a listener's claim, or null. */
export async function hostJudgedAlias(sid: string): Promise<string | null> {
  const { claimedBy } = await import('./companion-listener.js')
  const claimed = await claimedBy(sid)
  if (claimed) return claimed
  const { readSessionProjection } = await import('../session-projection.js')
  const row = (await readSessionProjection())?.sessions.find((s) => s.id === sid)
  return row?.judge === 'host' && row.host ? row.host : null
}

/** THE predicate: may companion path `path` write `sid` direct to a daemon? False (and logged) for a host-judged session. */
export async function directToDaemonAllowed(sid: string, path: string): Promise<boolean> {
  const host = await hostJudgedAlias(sid)
  if (!host) return true
  log.web.info('companion: a direct daemon path refused for a session its host judges', { sessionId: sid, host, path })
  return false
}

/** The phone's sentence while a host-judged session's host is not linked (and the Mac is away). */
export function hostUnreachableSentence(hostName: string): string {
  return `${hostName} can't be reached right now and your Mac is away. Try again in a moment.`
}
