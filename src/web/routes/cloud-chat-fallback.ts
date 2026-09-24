/**
 * Cloud companion fallback: answer a phone chat turn HERE when the primary
 * provably cannot receive it.
 *
 * ## When (and only when) this runs
 *
 * A phone turn sent to the companion is relayed to the primary
 * (routes/chat-turn-relay.ts). This module takes over only when the relay proves
 * the turn never reached the primary: nothing went on the wire (no bridge, or the
 * primary's daemon reported no primary server), or the primary does not know the
 * action at all (needs_upgrade). Anything ambiguous (a timeout after the send, a
 * domain refusal, a turn already running on the primary) keeps the old SSE error,
 * because answering locally there could put two answers on one question.
 *
 * It also needs the companion to be an execution host (`cloud.exec`, see
 * core/cloud-exec.ts) with the `claude` CLI installed, and a text-only turn: an
 * image turn's bytes would have to be staged here and then handed to the primary
 * too, which the outbox does not carry.
 *
 * ## What it does
 *
 *  - Runs the turn on the companion's OWN lane (core/sessions/cloud-chat-lane.ts):
 *    a different lane key in this box's own registry, a cwd under the cloud-exec
 *    root, read-only tools, no Walnut MCP. Through the SAME per-agent queue and
 *    the SAME lane turn runner (runLaneTurn) as the primary's REST turns.
 *  - Streams the same SSE frames a relayed turn produces, plus the additive
 *    `answeredBy: 'cloud'` on `message-start` and the terminal frame.
 *  - Persists ONLY into the non-git outbox (core/cloud-chat-outbox.ts). Never the
 *    conversation file: that has one writer, the primary.
 *
 * The phone sees the turn at once through GET /messages (the route merges banked
 * turns, see cloudTurnRows and the merge helpers below), and the primary adopts
 * it when the bridge is back.
 */

import { log } from '../../logging/index.js'
import { stripEntityRefs } from '../../utils/entity-refs.js'
import type { CloudChatOutboxEntry } from '../../core/cloud-chat-outbox.js'

/**
 * What a replica tells the phone when it cannot reach the box that answers and
 * cannot answer itself. The phone shows it verbatim; the "why" suffixes below are
 * appended to it, never substituted for it.
 */
export const PRIMARY_UNREACHABLE_MESSAGE =
  "Walnut's primary is unreachable; the replica cannot answer on its own. Try again when the primary is back."

/** Frame emitter bound to the conversation's SSE channel (api-v1's emitSse). */
export type ConversationEmitter = (event: string, data: unknown) => void

export type CloudFallbackDecision =
  | { kind: 'run'; cwd: string }
  | { kind: 'refuse'; reason: string; message: string }

/** Is the `claude` CLI available here? Swappable so tests need no real binary. */
let cliProbe: () => boolean = () => false
let cliProbeResolved = false

async function claudeCliAvailable(): Promise<boolean> {
  if (!cliProbeResolved) {
    const { resolveClaudeCliExecutable } = await import('../../core/claude-cli-detect.js')
    cliProbe = () => resolveClaudeCliExecutable() !== null
    cliProbeResolved = true
  }
  return cliProbe()
}

/** Test hook: force the CLI probe's answer (null restores the real probe). */
export function _setCloudChatCliProbeForTesting(probe: (() => boolean) | null): void {
  if (probe) { cliProbe = probe; cliProbeResolved = true } else { cliProbeResolved = false }
}

function refuse(reason: string, why?: string): CloudFallbackDecision {
  return { kind: 'refuse', reason, message: why ? `${PRIMARY_UNREACHABLE_MESSAGE} (${why})` : PRIMARY_UNREACHABLE_MESSAGE }
}

/**
 * May this box answer the turn itself? Cheapest checks first; the only I/O is a
 * config read and one mkdir, and only once the turn provably went nowhere.
 */
export async function decideCloudFallback(input: {
  provablyUnsent: boolean
  hasImages: boolean
}): Promise<CloudFallbackDecision> {
  // Not provable → the primary may be answering it right now. Today's error.
  if (!input.provablyUnsent) return refuse('ambiguous')
  if (input.hasImages) return refuse('images', 'The cloud companion does not answer picture messages on its own.')
  const { cloudExecActive } = await import('../../core/cloud-owned-session.js')
  if (!(await cloudExecActive())) {
    return refuse('cloud_exec_off', 'Cloud exec is not enabled on the cloud companion, so it has no engine of its own.')
  }
  if (!(await claudeCliAvailable())) {
    return refuse('cli_missing', 'The Claude Code CLI is not installed on the cloud companion.')
  }
  const [{ readCloudExecConfig }, { getConfig }, { resolveCloudChatCwd }] = await Promise.all([
    import('../../core/cloud-exec.js'),
    import('../../core/config-manager.js'),
    import('../../core/sessions/cloud-chat-lane.js'),
  ])
  const cwd = await resolveCloudChatCwd(readCloudExecConfig(await getConfig(), true).cwdRoots)
  if (!cwd.ok) return refuse('cwd_unusable', `The cloud companion cannot answer: ${cwd.reason}.`)
  return { kind: 'run', cwd: cwd.cwd }
}

/** The terminal error a fallback turn ends with when its lane gave no answer. */
const NO_ANSWER_MESSAGE =
  'The cloud companion did not answer this turn (timed out or errored). Try again, or wait for the primary.'

/**
 * Run one turn on the companion's own lane. Resolves when the turn is over, so
 * the caller's per-conversation 409 guard is held for its real duration.
 */
export async function runCloudFallbackTurn(input: {
  agentId: string
  conversationId: string
  text: string
  turnId: string
  cwd: string
  emit: ConversationEmitter
}): Promise<void> {
  const { agentId, conversationId, text, turnId, cwd, emit } = input
  const { enqueueAgentTurn } = await import('../agent-turn-queue.js')
  // The same per-agent queue every turn on this box goes through: a companion
  // runs at most one CLI turn per agent at a time (its CPU and memory are small).
  await enqueueAgentTurn(agentId, 'api-v1-cloud-fallback', async () => {
    // Every module first: nothing may throw between `message-start` and the
    // try below, or the phone would hold a turn that never ends.
    const [outbox, { runLaneTurn }, { subscribeLaneTurnFrames }, lane, { cloudEngineLabel }] = await Promise.all([
      import('../../core/cloud-chat-outbox.js'),
      import('../../core/sessions/lane-turn.js'),
      import('./lane-turn-sse.js'),
      import('../../core/sessions/cloud-chat-lane.js'),
      import('../../core/chat-history.js'),
    ])
    // Banked BEFORE the turn starts: the user's words survive a crash, and a
    // GET /messages during the turn still shows them.
    const entry = await outbox.bankCloudTurnStart({ turnId, agentId, conversationId, userText: text })
    if (!entry) {
      // An answer that can never reach the primary's history is one the user
      // loses on the next reload, so none is given.
      emit('error', {
        message: 'The cloud companion could not save this turn, so it did not answer it. Try again.',
        answeredBy: 'cloud',
      })
      return
    }
    emit('message-start', { turnId, answeredBy: 'cloud' })
    const relay = subscribeLaneTurnFrames(`cloud-fallback-relay-${turnId}`, emit)
    let laneSessionId = ''
    const engine = (): string | undefined => (laneSessionId ? cloudEngineLabel(laneSessionId) : undefined)
    try {
      const { resultText } = await runLaneTurn(agentId, conversationId, text, {
        source: 'cloud-fallback',
        onSessionId: (sid) => { laneSessionId = sid; relay.setSessionId(sid) },
        target: {
          resolve: (first) => lane.getOrCreateCloudChatLane(agentId, conversationId, cwd, first),
          catchUp: (sid, msg) => lane.cloudChatLaneCatchUp(agentId, conversationId, sid, msg),
        },
      })
      relay.settle()
      if (resultText === null || !resultText.trim()) {
        await outbox.finishCloudTurn(entry, { error: NO_ANSWER_MESSAGE, engine: engine() })
        log.web.error('cloud fallback turn got no answer', { conversationId, turnId, agentId, sessionId: laneSessionId })
        emit('error', { message: NO_ANSWER_MESSAGE, answeredBy: 'cloud' })
        return
      }
      // Recorded BEFORE the terminal frame: the phone refetches GET /messages on
      // `message-end`, and that read merges this entry.
      await outbox.finishCloudTurn(entry, { answerText: resultText, engine: engine() })
      // Entity refs stripped so the frame matches GET /messages byte-wise (the
      // same rule the primary's lane turn follows).
      emit('message-end', {
        turnId, fullText: stripEntityRefs(resultText), engine: 'claude-code', answeredBy: 'cloud',
      })
      log.web.info('cloud fallback turn answered on the companion', {
        conversationId, turnId, agentId, sessionId: laneSessionId, resultLength: resultText.length,
      })
    } catch (err) {
      relay.settle()
      const message = err instanceof Error ? err.message : String(err)
      await outbox.finishCloudTurn(entry, { error: message, engine: engine() })
      log.web.error('cloud fallback turn failed', { conversationId, turnId, agentId, error: message })
      emit('error', { message, answeredBy: 'cloud' })
    } finally {
      relay.dispose()
      // The primary may already be back; hand the turn over without waiting for
      // the next sweep.
      void outbox.flushCloudChatOutbox()
    }
  })
}

// ── Read side: banked turns in GET /messages ─────────────────────────────────

/** The fields of a message row this module places (the rest pass through). */
interface TimedRow { createdAt?: string }

/** The rows a banked turn contributes, in the route's mobile shape (no ids). */
export function cloudTurnRows(entries: CloudChatOutboxEntry[]): Array<{
  role: 'user' | 'assistant'; text: string; createdAt: string
}> {
  const rows: Array<{ role: 'user' | 'assistant'; text: string; createdAt: string }> = []
  for (const e of entries) {
    const userText = stripEntityRefs(e.userText)
    if (userText) rows.push({ role: 'user', text: userText, createdAt: e.userAt })
    // Only an ANSWERED turn has a second row: a failed turn shows the user's
    // words alone, exactly like a failed primary turn (its error card is a
    // notification, never a timeline row).
    if (e.state === 'answered' && e.answerText) {
      rows.push({ role: 'assistant', text: stripEntityRefs(e.answerText), createdAt: e.answeredAt ?? e.updatedAt })
    }
  }
  return rows
}

/**
 * Slot `extra` rows into `base` by time. Stable: base order is never changed,
 * an extra row goes in front of the first base row that is strictly newer, and
 * a base row with no readable time never moves an extra row past it.
 */
export function mergeRowsByTime<T extends TimedRow>(base: T[], extra: T[]): T[] {
  if (extra.length === 0) return base
  const at = (row: TimedRow): number => (row.createdAt ? Date.parse(row.createdAt) : Number.NaN)
  const out: T[] = []
  let j = 0
  for (const row of base) {
    const t = at(row)
    if (Number.isFinite(t)) {
      while (j < extra.length && at(extra[j]) < t) out.push(extra[j++])
    }
    out.push(row)
  }
  while (j < extra.length) out.push(extra[j++])
  return out
}

/**
 * Merge banked rows into a TAIL page relayed from the primary.
 *
 * The page's ids are positional in the PRIMARY's list (`m<n>`, contiguous), so
 * the merged page is renumbered from the page's first index. For banked turns
 * inside the page's time span (the normal case: they are the newest turns) these
 * are the ids the primary itself will produce once it adopts them at the same
 * place; a turn older than the whole page is an approximation, like every other
 * positional id shift. A page whose ids are not positional is returned untouched
 * rather than guessed at.
 */
export function mergeCloudRowsIntoRelayedPage<T extends TimedRow & { id: string }>(
  page: T[],
  rows: Array<Omit<T, 'id'>>,
): T[] {
  if (rows.length === 0) return page
  let start = 0
  if (page.length > 0) {
    const m = /^m(\d+)$/.exec(page[0].id)
    if (!m) return page
    start = Number(m[1])
  }
  const merged = mergeRowsByTime<Omit<T, 'id'>>(page.map(({ id: _id, ...rest }) => rest as Omit<T, 'id'>), rows)
  return merged.map((row, i) => ({ ...row, id: `m${start + i}` }) as T)
}
