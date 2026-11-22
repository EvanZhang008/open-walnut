/**
 * The resend family on a host that runs and judges its sessions (docs/plan/one-service-every-host.md,
 * phase 2, the plan's section 5 table): what resends into a session or respawns it follows the one
 * who judges it, so it works while the leader is away. On the leader each of these skips a
 * host-judged session; here each acts only on this host's own rows (sessions/judge-of.ts judgedHere,
 * judgedHereRecords), never on a copied row.
 *
 *   turn-run               the turn's attempts (a send by anyone but a retrier starts a new turn)
 *   queue-after-turn       rows held for the turn's end go out when this host's turn ends
 *   cold hold              rows held for a cold session's wake go out at the wake or the max hold
 *   idle compaction        the timed quiet /compact
 *   prompt refresh         the respawn on the current prompt: the prompt is the leader's, so a
 *                          respawn due while the leader is away waits for it to come back
 *   context-full recovery  the /compact and resend of what got no answer
 *   safeguard switch       the model switch after refused turns, and its resend
 *   model restore          the session's own model back after a borrowed one held a turn
 *   auto-continue          the timed continue of a turn the upstream retries gave up on
 *   endpoint wait          the continue once the model endpoint answers again
 *   usage-limit wait       the continue once the usage window resets
 *
 * What a give-up raises (the error card, the phase edge) is the leader's: it goes as a
 * `session:retry-over` fact (sessions/held-error.ts). The leader reads the host's turn state from
 * the facts (sessions/turn-run-host.ts: `hostTakenBy` on a turn end, `turnWaits` in the live state).
 *
 * Started before the host's fact emitter subscribes (host-boot.ts), so at a turn end each retrier
 * took it before the emitter stamps the end with their answer.
 */
import type { SessionRecord } from '../types.js'

type Say = (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void

/** How often a respawn that waits for the leader looks again, and how long it waits at most. */
const LEADER_POLL_MS = 5_000
const LEADER_WAIT_MAX_MS = 24 * 60 * 60_000

/**
 * Resolve once the leader answers (true), or false when `stillWanted` says no more (a send came) or
 * the wait ran out. `answers` and `sleep` are seams for tests.
 */
export async function whenLeaderAnswers(stillWanted: () => boolean, o: { answers?: () => boolean; sleep?: (ms: number) => Promise<void>; pollMs?: number; maxMs?: number; now?: () => number } = {}): Promise<boolean> {
  const answers = o.answers ?? (await import('../server-role.js')).leaderAnswers
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()))
  const now = o.now ?? Date.now
  const until = now() + (o.maxMs ?? LEADER_WAIT_MAX_MS)
  while (!answers()) {
    if (!stillWanted() || now() >= until) return false
    await sleep(o.pollMs ?? LEADER_POLL_MS)
  }
  return stillWanted()
}

type RespawnRunner = {
  respawnOnCurrentPrompt(id: string, stillWanted: () => boolean, opts?: { folder?: boolean }): Promise<'respawned' | 'not-due' | 'gave-way'>
}

/**
 * The runner as the prompt refresh sees it on a host: a respawn asks the leader for the current
 * prompt, so it goes only while the leader answers; due while it is away, it waits for it (no
 * resend is lost: the old prompt keeps working, only the saving waits). A wait that ends without
 * the leader gives way, and the session's next quiet turn end asks again.
 */
export function leaderPromptRunner<R extends RespawnRunner>(runner: R, wait: typeof whenLeaderAnswers = whenLeaderAnswers): R {
  return new Proxy(runner, {
    get(target, prop, receiver) {
      if (prop === 'respawnOnCurrentPrompt') {
        return async (id: string, stillWanted: () => boolean, opts?: { folder?: boolean }) => {
          if (!(await wait(stillWanted))) return 'gave-way' as const
          return target.respawnOnCurrentPrompt(id, stillWanted, opts)
        }
      }
      const v = Reflect.get(target, prop, receiver) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
}

/**
 * What the emitter keeps of a turn end of an own session: its data with `hostTakenBy`, the retrier
 * of this host that took it (turn-run.ts turnEndTakenByNow), read in the event's own tick.
 */
export async function turnEndStamp(): Promise<(name: string, data: unknown) => unknown> {
  const { turnEndTakenByNow } = await import('../sessions/turn-run.js')
  return (name, data) => {
    if (name !== 'session:result' && name !== 'session:error') return data
    const d = (data ?? {}) as Record<string, unknown>
    const sessionId = typeof d.sessionId === 'string' ? d.sessionId : ''
    if (!sessionId) return data
    const isError = name === 'session:error' ? true : d.isError === true
    const result = name === 'session:error' ? (typeof d.error === 'string' ? d.error : null) : (typeof d.result === 'string' ? d.result : null)
    const hostTakenBy = turnEndTakenByNow({ ...(d as object), event: name === 'session:error' ? 'error' : 'result', sessionId, isError, result } as Parameters<typeof turnEndTakenByNow>[0])
    return { ...d, hostTakenBy }
  }
}

/** This host's own record's turn: its waits and stops (the live state's turnWaits). */
export async function turnOfOwnSession(): Promise<(sid: string) => { waits: unknown[]; stops: unknown[] } | null> {
  const [{ turnRunNow }, { getSessionByClaudeIdSync }] = await Promise.all([import('../sessions/turn-run.js'), import('../session-tracker.js')])
  return (sid) => {
    const rec = getSessionByClaudeIdSync(sid) as SessionRecord | null
    if (!rec) return null
    const run = turnRunNow(rec)
    return { waits: run.waits, stops: run.stops }
  }
}

export interface HostResendFamily { stop(): void }

/** Start every member here, for this host's own rows. A member that fails to start is logged; the rest run. */
export async function startHostResendFamily(o: { say?: Say } = {}): Promise<HostResendFamily> {
  const say: Say = o.say ?? (() => {})
  const stops: Array<() => void> = []
  const step = async (name: string, fn: () => Promise<(() => void) | void>): Promise<void> => {
    try {
      const stop = await fn()
      if (stop) stops.push(stop)
    } catch (err) {
      say('warn', 'host sessions: a resend member did not start', { member: name, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const { cardToLeader, contextRecoveryGaveUp, safeguardGaveUp } = await import('../sessions/held-error.js')
  const { sessionRunner } = await import('../../providers/claude-code-session.js')

  await step('turn-run', async () => (await (await import('../sessions/turn-run.js')).startTurnRun()).stop)
  await step('queue-after-turn', async () => {
    const m = await import('../sessions/queue-after-turn.js')
    await m.startQueueAfterTurn()
    return m.stopQueueAfterTurn
  })
  await step('cold-hold', async () => {
    const m = await import('../sessions/cold-hold.js')
    await m.startColdHold()
    return m.stopColdHold
  })
  let idleArmed: (id: string) => boolean = () => false
  await step('idle-compaction', async () => {
    const h = (await import('../sessions/idle-compaction.js')).startIdleCompaction(sessionRunner)
    idleArmed = (id) => h.instance.armedFor(id) !== undefined
    return h.stop
  })
  await step('prompt-refresh-respawn', async () =>
    (await import('../sessions/prompt-refresh-respawn.js')).startPromptRefreshRespawn(leaderPromptRunner(sessionRunner), (id) => idleArmed(id)).stop)
  await step('context-full-recovery', async () =>
    (await import('../sessions/context-full-recovery.js')).startContextFullRecovery({ gaveUp: contextRecoveryGaveUp(cardToLeader) }).stop)
  await step('safeguard-switch', async () =>
    (await import('../sessions/safeguard-switch.js')).startSafeguardSwitch({ gaveUp: safeguardGaveUp(cardToLeader) }).stop)
  await step('model-restore', async () => (await import('../sessions/model-restore.js')).startModelRestore().stop)
  await step('auto-continue', async () => {
    // The same opt-out as the leader's (web/server.ts): hooks.overrides in this host's config copy.
    const { getConfig } = await import('../config-manager.js')
    if ((await getConfig().catch(() => null))?.hooks?.overrides?.['session-auto-continue']?.enabled === false) return
    return (await import('../session-auto-continue.js')).startSessionAutoContinue().stop
  })
  await step('endpoint-wait', async () => {
    const m = await import('../sessions/endpoint-wait.js')
    if (!m.endpointWaitEnabled()) return
    return m.startEndpointWait({ gaveUp: cardToLeader }).stop
  })
  await step('usage-limit-wait', async () => {
    const m = await import('../sessions/usage-limit-wait.js')
    if (!m.usageLimitWaitEnabled()) return
    return m.startUsageLimitWait({ handBack: cardToLeader, pickUp: true }).stop
  })
  say('info', 'host sessions: the resend family runs here for this host\'s own sessions', { members: stops.length })
  return {
    stop() {
      for (const s of stops.splice(0).reverse()) { try { s() } catch { /* stopping */ } }
    },
  }
}
