/**
 * A session the model's safeguards refuse turn after turn moves to another model by itself
 * (2026-11-11: "API Error: Opus 5.5's safeguards flagged this message ... [reasoning_extraction]"
 * came back 19 times in 34 minutes on one task's ordinary code edits; the session kept trying,
 * "I can't switch models directly myself", until the user typed /model sonnet; another needed
 * /model claude-fable-5-2).
 *
 *   refused turn ──► streak +1 (record.safeguardSwitch.streak)            a clean turn ──► streak 0,
 *        │            its model's family joins `tried`                      tried and owed forgotten
 *        └► streak reaches REFUSALS_BEFORE_SWITCH (2), or the new model refuses the resend itself
 *           (the same words refused again: the second refusal for it):
 *             pick the next family on the session's own menu (safeguard-stop.ts pickFallbackModel:
 *             Opus, Fable, Sonnet; never the current one, never one tried since it last worked)
 *             ─► switch it live (session-controls.ts applySessionModelChange, as the model picker)
 *             ─► one note into the session: which model and why, with the messages that got no
 *                answer (its transcript keeps it: the task's timeline line), a live line for open
 *                panels, and one line riding the lead's next message (status-riding.ts)
 *           no family left, or MAX_SWITCHES_PER_DAY reached: Walnut stops, the error is the user's.
 *
 * Which turns count: the engines stamp `safeguardStop` on session:result from what they mark
 * themselves (safeguard-stop.ts). While a switch runs, the turn that started it is not the end of
 * the work for any reader (`safeguardSwitchHolds`: the error card, the hand-back, turnHold).
 * Primary only (server.ts).
 */
import { randomUUID } from 'node:crypto'
import { bus, EventNames, type BusEvent } from '../event-bus.js'
import { log } from '../../logging/index.js'
import type { SafeguardSwitchState, SessionRecord } from '../types.js'
import { isQuietTurn } from './quiet-turn.js'
import { reportHeldTurnFailed } from './context-full-recovery.js'
import { noteTurnAttempt, type TurnRetrier } from './turn-run.js'
import { ANTHROPIC_DEFAULT_WINDOW, resolveContextWindow } from '../../providers/context-window.js'
import {
  FALLBACK_FAMILIES, modelFamilyOf, modelName, pickFallbackModel, REFUSALS_BEFORE_SWITCH, resendNoteText, rowFamily, switchedLine,
  type ModelFamily, type ModelRow, type OwedWords, type SafeguardStopFacts,
} from './safeguard-stop.js'

/** The send source of the note that tells the session it moved (an agent's, never a person's). */
export const SAFEGUARD_SWITCH_SOURCE = 'safeguard-switch'
/** Switches one session may make by itself in a day: a session every model refuses stops there. */
export const MAX_SWITCHES_PER_DAY = 6
const DAY_MS = 24 * 60 * 60_000
const KEEP_ROWS = 20
const KEEP_CHARS = 20_000
/** What the record keeps of the owed words, for a restart mid-switch. */
const KEEP_OWED_CHARS = 60_000
const KEEP_SWITCHES = 10
/** How long a refused result a switch took reads as held, at most. */
const HELD_TURN_MS = 10 * 60_000
/** A switch that ended so with its turn held: the error goes to the user (gaveUp). Stopped, closed and gone ones only let go. */
const HANDS_BACK: ReadonlySet<string> = new Set(['not-a-task-session', 'timed-out', 'host-unreachable'])
/** A switch a restart caught runs again this long after boot, once the hosts had a chance to connect. */
const REBUILD_RERUN_MS = 30_000

interface SeenRow extends OwedWords { id: string; delivered?: boolean; taken?: boolean }

interface Run { stopped: boolean; fence: string | null; startedAt: number; turnGen?: number }

interface Streak { count: number; since: string; category?: string; model?: string; families: string[] }

const FALLBACK_FAMILY_COUNT = FALLBACK_FAMILIES.length

export interface SafeguardSwitchDeps {
  now: () => number
  getSession: (sessionId: string) => Promise<SessionRecord | null>
  saveSession: (sessionId: string, updates: Partial<SessionRecord>) => Promise<unknown>
  /** The session's model menu and its current row (session-controls.ts computeModelOptions). */
  modelOptions: (sessionId: string) => Promise<{ models: ModelRow[]; current?: string | null }>
  /** Switch the session's model: `rejected` when its CLI refused the value; `failed` when the change
   *  could not be made at all (its host unreachable): no family is to blame. */
  applyModel: (sessionId: string, modelId: string) => Promise<{ rejected: boolean; failed?: boolean }>
  send: (sessionId: string, text: string, opts: { source: string; taskId?: string; messageId: string; stopFence: string | null; stillWanted: () => boolean }) => Promise<unknown>
  stopFence: (sessionId: string) => Promise<string | null>
  taskOpen: (taskId: string) => Promise<boolean>
  deleteQueued: (sessionId: string, messageId: string) => Promise<boolean>
  emitNote: (sessionId: string, taskId: string | undefined, message: string, variant: 'info' | 'error') => void
  /** One line riding the next message of the task's lead (the node right above it), never a turn of its own. */
  tellLead: (rec: SessionRecord, line: string) => Promise<void>
  /** Walnut stopped switching after holding the turn: the server raises the error card and moves the phase. */
  gaveUp: (rec: SessionRecord, words: string) => Promise<void>
}

function defaultDeps(): SafeguardSwitchDeps {
  return {
    now: () => Date.now(),
    getSession: async (id) => (await import('../session-tracker.js')).getSessionByClaudeId(id),
    saveSession: async (id, updates) => (await import('../session-tracker.js'))
      .updateSessionRecordConditionally(id, updates, () => true, { preserveLastActiveAt: true }),
    modelOptions: async (id) => (await import('./session-controls.js')).computeModelOptions(id),
    applyModel: async (id, modelId) => {
      const { getSessionByClaudeId } = await import('../session-tracker.js')
      const { applySessionModelChange } = await import('./session-controls.js')
      const before = await getSessionByClaudeId(id)
      const live = before?.process_status === 'running' || before?.process_status === 'idle'
      try {
        const r = await applySessionModelChange(id, modelId, { remember: false }) as { appliedLive?: boolean; applied?: boolean }
        // A live CLI must take it now (its read-back matched); one that is not live takes it at its next start.
        return { rejected: r.applied !== true && live && r.appliedLive !== true }
      } catch (err) {
        // A host Walnut cannot reach says nothing about the model: the switch stops without blaming it.
        log.session.warn('safeguard switch: model change failed', { sessionId: id, model: modelId, error: err instanceof Error ? err.message : String(err) })
        return { rejected: true, failed: true }
      }
    },
    send: async (id, text, opts) => {
      await noteTurnAttempt(id, 'safeguard_switch')
      return (await import('../session-message-queue.js')).sendMessageToSession(id, text, opts)
    },
    stopFence: async (id) => (await import('./session-stop.js')).sessionStops.fence(id),
    taskOpen: async (taskId) => {
      const { getTask } = await import('../task-manager.js')
      const task = await getTask(taskId).catch(() => null)
      return !!task && task.phase !== 'COMPLETE'
    },
    deleteQueued: async (id, messageId) => (await import('../session-message-queue.js')).deleteMessage(id, messageId),
    emitNote: (sessionId, taskId, message, variant) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, { sessionId, taskId, variant, message },
        ['main-ai'], { source: SAFEGUARD_SWITCH_SOURCE, urgency: 'urgent' })
    },
    tellLead: async (rec, line) => {
      if (!rec.taskId) return
      const { listTasks } = await import('../task-manager.js')
      const all = await listTasks()
      const task = all.find((t) => t.id === rec.taskId)
      if (!task) return
      const { followContext, statusFollowersOf } = await import('./status-push.js')
      const { getSessionsForTask, isListableSession } = await import('../session-tracker.js')
      const { addressable, bestFirst } = await import('./reply-routing.js')
      const { byId, vpOf, main } = await followContext(all)
      // As the status push: the first node above that is open and has a session hears it. A stopped
      // one too: the line only rides its next message, whenever that comes (never a wake).
      for (const lead of statusFollowersOf(task, byId, vpOf, main)) {
        if (lead.phase === 'COMPLETE') continue
        const to = (await getSessionsForTask(lead.id).catch(() => [] as SessionRecord[]))
          .filter((r) => addressable(r, isListableSession)).sort(bestFirst)[0]
        if (!to || to.claudeSessionId === rec.claudeSessionId) continue
        const { rideLine } = await import('./status-riding.js')
        rideLine(to.claudeSessionId, `safeguard-switch:${task.id}`, `- "${task.title}" (task ${task.id}): ${line}`)
        return
      }
      log.session.info('safeguard switch: no lead with a session to tell', { sessionId: rec.claudeSessionId, taskId: task.id, parent: task.parent_task_id })
    },
    gaveUp: async () => {},
  }
}

/** Why a session is not one Walnut switches, or null. Pure. */
export function notSwitchable(rec: SessionRecord | null): string | null {
  if (!rec || rec.archived) return 'session-gone'
  if (rec.lane || rec.provider === 'embedded') return 'not-a-task-session'
  if (rec.supersededBy) return 'superseded'
  return null
}

/** The switches of the last day. Pure. */
export function switchesToday(state: SafeguardSwitchState | undefined, nowMs: number): number {
  return (state?.switches ?? []).filter((s) => nowMs - Date.parse(s.at) < DAY_MS).length
}

export class SafeguardSwitch {
  private readonly deps: SafeguardSwitchDeps
  /** sessionId → messages the queue reported, until a turn ended with them. */
  private readonly seen = new Map<string, SeenRow[]>()
  /** sessionId → messages refused turns got: owed until a clean turn of the session's own. */
  private readonly owed = new Map<string, SeenRow[]>()
  /** sessionId → refused turns in a row (mirrors record.safeguardSwitch), and the families that refused them. */
  private readonly streak = new Map<string, Streak>()
  /** sessionId → the switch that holds it, from the refusal that started it to its note's send. */
  private readonly running = new Map<string, Run>()
  /** Sessions Walnut stopped switching (every family refused, or the day's cap): until a clean turn. */
  private readonly gaveUpOn = new Set<string>()
  /** sessionId → the note's queue row, until a clean turn. */
  private readonly resendRow = new Map<string, { id: string; taken?: boolean }>()
  private readonly linesKnown = new Set<string>()
  /**
   * sessionId → the refused result a switch took: every reader of that result (the error card, the
   * hand-back) sees it held, however soon the switch itself is over, for HELD_TURN_MS. A reader that
   * names the result's turnGen is answered for that result; one that does not, only until a newer
   * result of the session came (`superseded`).
   */
  private readonly heldTurn = new Map<string, { turnGen?: number; until: number; superseded: boolean }>()
  /** sessionId → its last record write: one at a time, in order. */
  private readonly writes = new Map<string, Promise<void>>()
  private stopped = false
  /** Tests set it short. */
  rerunDelayMs = REBUILD_RERUN_MS

  constructor(deps: Partial<SafeguardSwitchDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
  }

  handleEvent = (event: BusEvent): void => {
    if (this.stopped) return
    const d = event.data as Record<string, unknown> & { sessionId?: string }
    if (event.name === EventNames.SESSION_DELETED) {
      const ids = Array.isArray(d.sessionIds) ? d.sessionIds : [d.sessionId]
      for (const id of ids) if (typeof id === 'string') this.forget(id)
      return
    }
    const sessionId = typeof d.sessionId === 'string' ? d.sessionId : undefined
    if (!sessionId) return
    switch (event.name) {
      case EventNames.SESSION_MESSAGE_QUEUED: this.noteQueued(sessionId, d); return
      case EventNames.SESSION_MESSAGES_DELIVERED: this.mark(sessionId, d.messageIds, false); return
      case EventNames.SESSION_USER_LINE: this.linesKnown.add(sessionId); this.mark(sessionId, d.rowIds, true); return
      case EventNames.SESSION_QUEUED_CANCELLED: {
        const ids = Array.isArray(d.messageIds) ? d.messageIds : []
        const rows = this.seen.get(sessionId)
        if (rows) this.seen.set(sessionId, rows.filter((r) => !ids.includes(r.id)))
        // The note itself taken back: no turn of the switch's follows the refused one.
        const note = this.resendRow.get(sessionId)
        if (note && ids.includes(note.id)) {
          this.resendRow.delete(sessionId)
          if (!this.running.has(sessionId)) this.release(sessionId, undefined, undefined, 'The note to the session was taken back.')
        }
        return
      }
      case EventNames.SESSION_INTERRUPT: {
        const run = this.running.get(sessionId)
        if (run) run.stopped = true
        // A note still waiting in the queue was Walnut's, not the person's: a Stop takes it back.
        const row = this.resendRow.get(sessionId)
        if (row && !row.taken) {
          void this.deps.deleteQueued(sessionId, row.id).catch(() => false)
          this.resendRow.delete(sessionId)
        }
        // A switch already over held only its refused turn, and no turn follows it now.
        if (!run && this.heldTurn.has(sessionId)) this.release(sessionId, undefined, undefined, 'The session was stopped.')
        return
      }
      case EventNames.SESSION_RESULT: {
        const turnGen = typeof d.turnGen === 'number' ? d.turnGen : undefined
        if (isQuietTurn(sessionId, turnGen)) return
        // Any later result is past the held one; one with no turn number (ACP, the SDK) cannot be told
        // apart, and the hold is made after the refused result is read, so whatever comes next is newer.
        const held = this.heldTurn.get(sessionId)
        if (held && (held.turnGen === undefined || turnGen === undefined || held.turnGen !== turnGen)) held.superseded = true
        if (d.teamActive === true || d.backgroundActive === true) return
        const refused = d.safeguardStop && typeof d.safeguardStop === 'object' ? d.safeguardStop as SafeguardStopFacts : null
        if (refused) { this.onRefused(sessionId, refused, typeof d.taskId === 'string' ? d.taskId : undefined, turnGen); return }
        // Another error, or a stop: no turn the model answered, and no refusal either.
        if (d.isError === true || d.interrupted === true || d.compactionStopped === true || d.processDied === true) return
        this.onClean(sessionId)
        return
      }
    }
  }

  private noteQueued(sessionId: string, d: Record<string, unknown>): void {
    const source = typeof d.source === 'string' ? d.source : undefined
    if (source === SAFEGUARD_SWITCH_SOURCE) return
    const id = typeof d.messageId === 'string' ? d.messageId : undefined
    const text = typeof d.rowText === 'string' ? d.rowText
      : typeof d.queuedText === 'string' ? d.queuedText : typeof d.message === 'string' ? d.message : ''
    const shown = typeof d.message === 'string' ? d.message : text
    // A slash command runs in the CLI itself: nothing to answer, nothing to resend.
    if (!id || !text.trim() || shown.trim().startsWith('/')) return
    const rows = this.seen.get(sessionId) ?? []
    rows.push({
      id, text: text.slice(0, KEEP_CHARS),
      ...(d.sentBy === 'person' || d.sentBy === 'agent' ? { sentBy: d.sentBy } : {}),
      at: typeof d.enqueuedAt === 'string' ? d.enqueuedAt : new Date(this.deps.now()).toISOString(),
    })
    this.seen.set(sessionId, rows.slice(-KEEP_ROWS))
  }

  private mark(sessionId: string, ids: unknown, taken: boolean): void {
    if (!Array.isArray(ids)) return
    const resend = this.resendRow.get(sessionId)
    if (resend && ids.includes(resend.id) && (taken || !this.linesKnown.has(sessionId))) resend.taken = true
    for (const row of this.seen.get(sessionId) ?? []) {
      if (!ids.includes(row.id)) continue
      row.delivered = true
      if (taken) row.taken = true
    }
  }

  /** The rows a turn that just ended got (what it took, or every delivered row for a CLI that does not say). */
  private takeTurnRows(sessionId: string): SeenRow[] {
    const rows = this.seen.get(sessionId) ?? []
    const known = this.linesKnown.has(sessionId)
    const these = rows.filter((r) => (known ? r.taken : r.delivered))
    this.seen.set(sessionId, rows.filter((r) => !these.includes(r)))
    return these
  }

  private onClean(sessionId: string): void {
    this.takeTurnRows(sessionId)
    const hadState = this.streak.has(sessionId) || this.owed.has(sessionId) || this.gaveUpOn.has(sessionId)
    this.owed.delete(sessionId)
    // A note still queued stays the session's next turn: its refusal must still read as the resend's.
    if (this.resendRow.get(sessionId)?.taken) this.resendRow.delete(sessionId)
    this.gaveUpOn.delete(sessionId)
    this.streak.delete(sessionId)
    if (!hadState) return
    // The session works again: its streak, the families it tried and its owed words are over (its switches stay).
    this.writeState(sessionId, (prior) => {
      if (!prior || (!prior.streak && !prior.tried?.length && !prior.gaveUpAt && !prior.owed?.length && !prior.switchingAt)) return null
      const { since: _s, category: _c, tried: _t, gaveUpAt: _g, owed: _o, switchingAt: _w, ...rest } = prior
      return { ...rest, streak: 0 }
    })
  }

  /** A turn the safeguards refused. Synchronous up to the hold, so every reader of this result sees it. */
  private onRefused(sessionId: string, facts: SafeguardStopFacts, taskId: string | undefined, turnGen?: number): void {
    const rows = this.takeTurnRows(sessionId)
    const owed = [...(this.owed.get(sessionId) ?? []), ...rows].slice(-KEEP_ROWS)
    this.owed.set(sessionId, owed)
    // The turn that took the resend note refused the same words again: the second refusal for the new model.
    const resendRefused = this.resendRow.get(sessionId)?.taken === true
    if (resendRefused) this.resendRow.delete(sessionId)
    const now = new Date(this.deps.now()).toISOString()
    const prev = this.streak.get(sessionId)
    const family = modelFamilyOf(facts.model)
    const next: Streak = {
      count: Math.max((prev?.count ?? 0) + 1, resendRefused ? REFUSALS_BEFORE_SWITCH : 0), since: prev?.since ?? now,
      ...(facts.category ?? prev?.category ? { category: facts.category ?? prev?.category } : {}),
      ...(facts.model ?? prev?.model ? { model: facts.model ?? prev?.model } : {}),
      families: [...new Set([...(prev?.families ?? []), ...(family ? [family] : [])])],
    }
    this.streak.set(sessionId, next)
    this.writeState(sessionId, (prior) => ({
      ...(prior ?? { streak: 0 }), streak: next.count, since: next.since,
      ...(next.category ? { category: next.category } : {}),
      tried: [...new Set([...(prior?.tried ?? []), ...next.families])],
      owed: owedForRecord(owed),
    }))
    log.session.info('safeguard switch: refused turn', { sessionId, taskId, streak: next.count, category: next.category, resendRefused })
    if (next.count < REFUSALS_BEFORE_SWITCH || this.running.has(sessionId) || this.gaveUpOn.has(sessionId)) return
    this.startRun(sessionId, turnGen)
  }

  /** Take the session and move it; the result's readers see it held from here (`holds`). */
  private startRun(sessionId: string, turnGen?: number): void {
    const run: Run = { stopped: false, fence: null, startedAt: this.deps.now(), ...(turnGen !== undefined ? { turnGen } : {}) }
    this.running.set(sessionId, run)
    this.heldTurn.set(sessionId, { ...(turnGen !== undefined ? { turnGen } : {}), until: this.deps.now() + HELD_TURN_MS, superseded: false })
    this.writeState(sessionId, (prior) => ({ ...(prior ?? { streak: 0 }), switchingAt: new Date(this.deps.now()).toISOString() }))
    // A host that never answers holds nothing for long: past HELD_TURN_MS the switch ends, and the error is the user's.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<string>((resolve) => {
      timer = setTimeout(() => { run.stopped = true; resolve('timed-out') }, HELD_TURN_MS)
      timer.unref?.()
    })
    void Promise.race([this.switchModel(sessionId, run), timedOut]).finally(() => clearTimeout(timer)).then(async (outcome) => {
      if (outcome === 'switched' || outcome === 'gave-up' || outcome === 'send-failed') return
      const rec = await this.deps.getSession(sessionId).catch(() => null)
      // The turn was held: an end that cannot be switched hands its error to the user; a stopped,
      // closed or gone one only lets go.
      if (rec && HANDS_BACK.has(outcome)) {
        await this.handBack(sessionId, run, rec, `The model's safeguards refused ${REFUSALS_BEFORE_SWITCH} turns in a row, and Walnut did not switch its model (${outcome}).`)
      } else {
        this.release(sessionId, run, rec?.taskId, `The safeguard switch ended: ${outcome}.`)
      }
    }, async (err) => {
      log.session.warn('safeguard switch: failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
      const rec = await this.deps.getSession(sessionId).catch(() => null)
      if (rec) await this.handBack(sessionId, run, rec, `The model's safeguards refused ${REFUSALS_BEFORE_SWITCH} turns in a row, and Walnut could not switch its model: ${err instanceof Error ? err.message : String(err)}`)
      else this.release(sessionId, run, undefined, 'The session is gone.')
    }).catch(() => {}).finally(() => {
      if (this.running.get(sessionId) === run) this.running.delete(sessionId)
      this.writeState(sessionId, (prior) => {
        if (!prior?.switchingAt) return null
        const { switchingAt: _w, ...rest } = prior
        return rest
      })
    })
  }

  /** Let go of the held turn with no turn of the switch's to follow: readers that waited settle it (triage runs). */
  private release(sessionId: string, run: Run | undefined, taskId: string | undefined, reason: string): void {
    if (!run || this.running.get(sessionId) === run) this.running.delete(sessionId)
    this.heldTurn.delete(sessionId)
    reportHeldTurnFailed({ sessionId, ...(taskId ? { taskId } : {}), reason })
  }

  /**
   * The error is the user's after all: the hold ends first, so the error edge gaveUp makes reaches every
   * reader (the askers' and the lead's notices, the phase), then the card and the phase are raised.
   */
  private async handBack(sessionId: string, run: Run | undefined, rec: SessionRecord, words: string): Promise<void> {
    this.release(sessionId, run, rec.taskId, words)
    await this.deps.gaveUp(rec, words).catch((err) => log.session.warn('safeguard switch: error card not raised', { sessionId, error: String(err) }))
  }

  private async fenceNow(sessionId: string): Promise<string | null | undefined> {
    try {
      return await this.deps.stopFence(sessionId)
    } catch {
      return undefined // a stop still waits for its host
    }
  }

  private async refusal(sessionId: string, rec: SessionRecord | null, run: Run): Promise<string | null> {
    const why = notSwitchable(rec)
    if (why) return why
    if (run.stopped || this.stopped) return 'stopped'
    if (rec!.taskId && !(await this.deps.taskOpen(rec!.taskId))) return 'task-complete'
    const fence = await this.fenceNow(sessionId)
    if (fence === undefined || fence !== run.fence || run.stopped) return 'stopped'
    return null
  }

  /** Two refused turns in a row: move the session to another model and hand it what got no answer. */
  async switchModel(sessionId: string, run: Run): Promise<'switched' | string> {
    const fence = await this.fenceNow(sessionId)
    if (fence === undefined) return 'stopped'
    run.fence = fence
    const rec = await this.deps.getSession(sessionId)
    const why = await this.refusal(sessionId, rec, run)
    if (why) { log.session.info('safeguard switch: not switched', { sessionId, why }); return why }
    // A turn that worked since (a clean result after a restart's rerun was armed) leaves nothing to switch.
    const streak = this.streak.get(sessionId)
    if (!streak || streak.count < REFUSALS_BEFORE_SWITCH) return 'stale'
    const prior = rec!.safeguardSwitch
    const nowMs = this.deps.now()
    if (switchesToday(prior, nowMs) >= MAX_SWITCHES_PER_DAY) {
      return this.giveUp(sessionId, run, rec!, `Walnut already switched its model ${MAX_SWITCHES_PER_DAY} times today, and the safeguards still refuse it.`)
    }
    const menu = await this.deps.modelOptions(sessionId)
    const currentRow = menu.models.find((m) => m.id === menu.current) ?? null
    const currentFamily = (currentRow ? rowFamily(currentRow) : null)
      ?? modelFamilyOf(rec!.cliModel) ?? modelFamilyOf(rec!.model) ?? modelFamilyOf(streak.model)
    const fromName = modelName(currentRow, streak.model ?? rec!.cliModel ?? rec!.model)
    // A wide window stays wide: a 300K conversation moved to a 200K model only overflows. The window
    // is the one the session reported (resolveContextWindow), never one read off the model's name here.
    const window = resolveContextWindow({
      model: rec!.model ?? rec!.cliModel ?? currentRow?.resolvedModel,
      recordWindow: rec!.modelMaxWindow, observedTokens: rec!.contextTokens,
    })
    const wide = (window?.window ?? 0) > ANTHROPIC_DEFAULT_WINDOW
    const tried = new Set<string>([...(prior?.tried ?? []), ...streak.families, ...(currentFamily ? [currentFamily] : [])])
    const originalCliModel = rec!.cliModel
    let picked: { row: ModelRow; family: ModelFamily } | null = null
    let attempted = false
    for (let i = 0; i < FALLBACK_FAMILY_COUNT; i++) {
      const pick = pickFallbackModel(menu.models, { id: menu.current ?? null, family: currentFamily, wide }, [...tried])
      if (!pick) break
      const again = await this.refusal(sessionId, await this.deps.getSession(sessionId), run)
      if (again) return again
      attempted = true
      const { rejected, failed } = await this.deps.applyModel(sessionId, pick.row.id)
      if (failed) {
        await this.deps.saveSession(sessionId, { cliModel: originalCliModel }).catch(() => {})
        return 'host-unreachable'
      }
      if (run.stopped || this.stopped) {
        // Timed out or stopped while the host applied it: the model it had stays, and nothing is said.
        const back = originalCliModel ?? menu.current
        if (!rejected && back) await this.deps.applyModel(sessionId, back).catch(() => null)
        await this.deps.saveSession(sessionId, { cliModel: originalCliModel }).catch(() => {})
        return 'stopped'
      }
      tried.add(pick.family)
      if (!rejected) { picked = pick; break }
      log.session.warn('safeguard switch: the model did not take', { sessionId, model: pick.row.id })
    }
    if (!picked) {
      // A refused value the change stored would start the next process on it: the record keeps the model it had.
      if (attempted) await this.deps.saveSession(sessionId, { cliModel: originalCliModel }).catch(() => {})
      return this.giveUp(sessionId, run, rec!, `Walnut found no other model to move it to (tried: ${[...tried].join(', ') || 'none'}).`)
    }
    const toName = modelName(picked.row)
    const owed = this.owed.get(sessionId) ?? []
    const at = new Date(this.deps.now()).toISOString()
    // The new model starts one short of a switch: refusing the resend itself is the second refusal of these words.
    const carried: Streak = { count: 0, since: at, ...(streak.category ? { category: streak.category } : {}), families: [] }
    this.streak.set(sessionId, carried)
    this.writeState(sessionId, (p) => ({
      // switchingAt goes with this write: a restart after it must not run the switch again.
      ...omitSwitching(p ?? { streak: 0 }), streak: 0, since: at, tried: [...tried],
      switches: [...(p?.switches ?? []), {
        at, from: fromName, to: toName, toId: picked!.row.id, ...(streak.category ? { category: streak.category } : {}), resent: owed.length,
      }].slice(-KEEP_SWITCHES),
    }))
    const line = switchedLine(fromName, toName, streak.count, streak.category)
    this.deps.emitNote(sessionId, rec!.taskId, `${line} ${owed.length
      ? `It resent the ${owed.length === 1 ? 'message' : `${owed.length} messages`} that got no answer.`
      : 'It asked the session to carry on.'}`, 'info')
    const rowId = `qm-safeguard-switch-${randomUUID()}`
    this.resendRow.set(sessionId, { id: rowId })
    try {
      await this.deps.send(sessionId, resendNoteText(fromName, toName, streak.count, streak.category, owed), {
        source: SAFEGUARD_SWITCH_SOURCE, ...(rec!.taskId ? { taskId: rec!.taskId } : {}), messageId: rowId,
        stopFence: run.fence, stillWanted: () => !run.stopped && !this.stopped,
      })
      if (run.stopped || this.stopped) {
        void this.deps.deleteQueued(sessionId, rowId).catch(() => false)
        this.resendRow.delete(sessionId)
        return 'stopped'
      }
    } catch (err) {
      if (this.resendRow.get(sessionId)?.id === rowId) this.resendRow.delete(sessionId)
      // The model is switched; only the note did not go out. The next message reaches the new model.
      log.session.warn('safeguard switch: switched, but the note was not sent', { sessionId, error: err instanceof Error ? err.message : String(err) })
      if (run.stopped) { this.release(sessionId, run, rec!.taskId, 'The session was stopped.'); return 'stopped' }
      await this.handBack(sessionId, run, rec!, `${line} Its note to the session could not be sent: ${err instanceof Error ? err.message : String(err)}`)
      return 'send-failed'
    }
    // The switch is over once its note is in: the new model's own results are nobody's to hold.
    if (this.running.get(sessionId) === run) this.running.delete(sessionId)
    await this.deps.tellLead(rec!, `${line} Walnut resent what got no answer; nothing for you to do.`).catch((err) => {
      log.session.warn('safeguard switch: lead not told', { sessionId, error: err instanceof Error ? err.message : String(err) })
    })
    log.session.info('safeguard switch: switched', { sessionId, taskId: rec!.taskId, from: fromName, to: toName, toId: picked.row.id, resent: owed.length })
    return 'switched'
  }

  private async giveUp(sessionId: string, run: Run, rec: SessionRecord, reason: string): Promise<string> {
    this.gaveUpOn.add(sessionId)
    const at = new Date(this.deps.now()).toISOString()
    this.writeState(sessionId, (p) => ({ ...(p ?? { streak: 0 }), gaveUpAt: at }))
    const streak = this.streak.get(sessionId)
    const words = `The model's safeguards refused ${Math.max(streak?.count ?? 0, REFUSALS_BEFORE_SWITCH)} turns in a row${streak?.category ? ` ([${streak.category}])` : ''}. ${reason}`
    this.deps.emitNote(sessionId, rec.taskId, `${words} Rephrase the request, or start a new session for this task.`, 'error')
    // The turn was held while Walnut looked: the error is the user's now, and its error edge tells the lead.
    await this.handBack(sessionId, run, rec, words)
    log.session.warn('safeguard switch: gave up', { sessionId, taskId: rec.taskId, reason })
    return 'gave-up'
  }

  /** Change the record's state, one write at a time per session (every caller reads the newest). */
  private writeState(sessionId: string, next: (prior: SafeguardSwitchState | undefined) => SafeguardSwitchState | null): Promise<void> {
    const prev = this.writes.get(sessionId) ?? Promise.resolve()
    const run = prev.then(async () => {
      const rec = await this.deps.getSession(sessionId)
      if (!rec) return
      const state = next(rec.safeguardSwitch)
      if (state) await this.deps.saveSession(sessionId, { safeguardSwitch: state })
    }).catch((err) => {
      log.session.warn('safeguard switch: state not saved', { sessionId, error: err instanceof Error ? err.message : String(err) })
    })
    this.writes.set(sessionId, run)
    void run.finally(() => { if (this.writes.get(sessionId) === run) this.writes.delete(sessionId) })
    return run
  }

  /** Tests only: the record writes made so far have landed. */
  async settled(sessionId: string): Promise<void> { await this.writes.get(sessionId) }

  /**
   * At boot: each record's refused streak counts on, with the words still owed; a switch a restart
   * caught runs again (its refused turn has no reader waiting for it any more, only the session).
   */
  async rebuild(listSessions: () => Promise<SessionRecord[]>): Promise<number> {
    let n = 0
    for (const rec of await listSessions()) {
      const s = rec.safeguardSwitch
      if (!s?.streak && !s?.switchingAt) continue
      const sid = rec.claudeSessionId
      // A refusal counted since boot is newer than the record: keep it.
      if (!this.streak.has(sid)) this.streak.set(sid, { count: s.streak, since: s.since ?? new Date(this.deps.now()).toISOString(), ...(s.category ? { category: s.category } : {}), families: [] })
      if (s.owed?.length && !this.owed.get(sid)?.length) this.owed.set(sid, s.owed.map((r, i) => ({ ...r, id: `restored-${i}`, delivered: true, taken: true })))
      if (s.gaveUpAt) this.gaveUpOn.add(sid)
      else if (s.switchingAt && !this.running.has(sid)) {
        const t = setTimeout(() => {
          if (this.stopped || this.running.has(sid) || this.gaveUpOn.has(sid)) return
          // A clean turn meanwhile (onClean drops the streak and the mark) means the session works again.
          if ((this.streak.get(sid)?.count ?? 0) < REFUSALS_BEFORE_SWITCH) return
          void this.deps.getSession(sid).then((now) => {
            if (now?.safeguardSwitch?.switchingAt && !this.stopped && !this.running.has(sid)) this.startRun(sid)
          }).catch(() => {})
        }, this.rerunDelayMs)
        t.unref?.()
      }
      n++
    }
    return n
  }

  /**
   * Whether a switch holds this session now: its last turn was refused and Walnut is moving it, or
   * moved it (`turnGen`: that result's, when the reader knows which result it reads).
   */
  holds(sessionId: string, turnGen?: number): boolean {
    if (this.stopped) return false
    const run = this.running.get(sessionId)
    if (run && this.deps.now() < run.startedAt + HELD_TURN_MS) {
      return turnGen === undefined || run.turnGen === undefined || run.turnGen === turnGen
    }
    const held = this.heldTurn.get(sessionId)
    if (!held || this.deps.now() >= held.until) return false
    if (turnGen !== undefined && held.turnGen !== undefined) return held.turnGen === turnGen
    return !held.superseded
  }

  forget(sessionId: string): void {
    this.seen.delete(sessionId)
    this.owed.delete(sessionId)
    this.streak.delete(sessionId)
    this.running.delete(sessionId)
    this.gaveUpOn.delete(sessionId)
    this.resendRow.delete(sessionId)
    this.linesKnown.delete(sessionId)
    this.heldTurn.delete(sessionId)
  }

  stop(): void {
    this.stopped = true
    for (const run of this.running.values()) run.stopped = true
  }

  /** Tests only. */
  streakOf(sessionId: string): number { return this.streak.get(sessionId)?.count ?? 0 }
}

/** The owed words a record keeps: newest first into the budget, kept oldest first. */
function owedForRecord(rows: ReadonlyArray<SeenRow>): OwedWords[] {
  let budget = KEEP_OWED_CHARS
  const kept: OwedWords[] = []
  for (const r of [...rows].reverse()) {
    if (budget <= 0) break
    const text = r.text.slice(0, budget)
    budget -= text.length
    kept.unshift({ text, at: r.at, ...(r.sentBy ? { sentBy: r.sentBy } : {}) })
  }
  return kept
}

let instance: SafeguardSwitch | null = null

/** The running switch (null before the primary started it, or on a replica). */
export function safeguardSwitch(): SafeguardSwitch | null {
  return instance
}

/**
 * Whether a session's last turn end belongs to the safeguard switch: it was refused and Walnut is
 * moving the session to another model, so the turn answered nothing and the work goes on. Readers ask
 * the session's turn (sessions/turn-run.ts), whose row below answers with this.
 */
export function safeguardSwitchHolds(sessionId: string | undefined, turnGen?: number): boolean {
  return !!sessionId && !!instance?.holds(sessionId, turnGen)
}

/** The safeguard switch's row of the session's turn (sessions/turn-run.ts). */
export const turnRetrier: TurnRetrier<'safeguard_switch'> = {
  reason: 'safeguard_switch',
  sources: [SAFEGUARD_SWITCH_SOURCE],
  // Its hold starts inside the refused result's own handler, so the result's readers see it; an ACP
  // refusal ends "clean" (stopReason refusal), so a clean end is taken too.
  takes: (end) => end.event === 'result' && safeguardSwitchHolds(end.sessionId, end.turnGen),
  wait: (rec, q) => safeguardSwitchHolds(rec.claudeSessionId, q.turnGen) ? { reason: 'safeguard_switch' } : null,
}

/** Start the switch on the primary. */
export function startSafeguardSwitch(deps: Partial<SafeguardSwitchDeps> = {}): { stop: () => void; instance: SafeguardSwitch } {
  const sw = new SafeguardSwitch(deps)
  instance = sw
  bus.subscribe('safeguard-switch', sw.handleEvent, {
    global: true,
    interest: ['session:message-queued', 'session:messages-delivered', 'session:user-line', 'session:queued-cancelled',
      'session:interrupt', 'session:result', 'session:deleted'],
  })
  void import('../session-tracker.js').then(({ listSessions }) => sw.rebuild(listSessions))
    .then((n) => { if (n) log.session.info('safeguard switch: refused streaks picked up', { count: n }) })
    .catch((err) => log.session.warn('safeguard switch rebuild failed', { error: err instanceof Error ? err.message : String(err) }))
  return {
    instance: sw,
    stop: () => {
      bus.unsubscribe('safeguard-switch')
      sw.stop()
      if (instance === sw) instance = null
    },
  }
}

function omitSwitching(state: SafeguardSwitchState): SafeguardSwitchState {
  const { switchingAt: _w, ...rest } = state
  return rest
}
