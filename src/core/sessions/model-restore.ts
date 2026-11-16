/**
 * A model Walnut or an agent picked for a session holds for one turn, then the session goes back to
 * its own model (2026-11-16: a lead moved a task's session from Opus 5.5 to Sonnet 5.5 after the
 * safeguards refused it; nothing moved it back, and the task woke on Sonnet three hours later).
 *
 *   safeguard switch picks a fallback ─┐
 *   an agent POSTs /sessions/:id/model ┴► record.modelTemporary = { from: the session's own model, to, by, at }
 *                                                    │ (a chain of switches keeps the first `from`)
 *   the next turn that ends clean ───────────────────┴► switch back to `from` (null: the engine's default),
 *                                                       clear the mark, one line for open panels
 *   a person picks a model (web, phone, or an agent passing user_words) ─► the mark is cleared: it is theirs
 *
 * A session the safeguards keep refusing would bounce between models all day, two refused turns each
 * time: after RESTORE_PAUSE_AFTER_SWITCHES safeguard switches in a day it stays on the fallback until
 * the day's count drops. Primary only (server.ts), as the safeguard switch.
 */
import { bus, EventNames, type BusEvent } from '../event-bus.js'
import { log } from '../../logging/index.js'
import type { SessionRecord, TemporaryModel } from '../types.js'
import { isQuietTurn } from './quiet-turn.js'
import { engineCaps } from '../agents/engine-registry.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import { ambientAutomatedClient } from './automated-client.js'

/** Safeguard switches in a day after which a session stays on its fallback instead of bouncing back. */
export const RESTORE_PAUSE_AFTER_SWITCHES = 3
const DAY_MS = 24 * 60 * 60_000
/** user_words shorter than this quote nothing. */
const MIN_USER_WORDS = 4
/** The model id that asks the engine for its own default (the menu's Default row). */
export const ENGINE_DEFAULT_MODEL = 'default'

/** Who picked a model: a person's pick is the session's own, an agent's holds for one turn. */
export type ModelChoice = 'person' | 'agent'

/**
 * Who asks for a model change, from the request: a session (x-walnut-caller-sid), a script or job
 * (x-walnut-caller-kind) or a browser under automation is an agent, unless it passes `user_words`
 * quoting the user's own ask for that model. Everyone else is a person. Pure but for the ambient
 * automation flag.
 */
export function modelChoiceOf(headers: Record<string, string | string[] | undefined>, body: unknown): ModelChoice {
  const words = (body as { user_words?: unknown } | null | undefined)?.user_words
  if (typeof words === 'string' && words.trim().length >= MIN_USER_WORDS) return 'person'
  const has = (name: string) => { const v = headers[name]; return !!(Array.isArray(v) ? v[0] : v)?.trim() }
  return has('x-walnut-caller-sid') || has(CALLER_KIND_HEADER) || ambientAutomatedClient() ? 'agent' : 'person'
}

/** Whether Walnut puts this session's model back itself (a Claude Code session; ACP engines keep theirs). */
export function tracksTemporaryModel(rec: Pick<SessionRecord, 'engine'>): boolean {
  return engineCaps(rec.engine).modelSwitch !== 'config-option'
}

/** The session's own model a temporary switch goes back to. Pure. */
export function restoreTarget(t: TemporaryModel): string {
  return t.from ?? ENGINE_DEFAULT_MODEL
}

/**
 * The mark a temporary switch to `to` leaves, or null when `to` is the session's own model again.
 * A switch on top of a temporary one keeps the first `from`. Pure.
 */
export function markTemporary(
  rec: Pick<SessionRecord, 'cliModel' | 'modelTemporary'>, to: string, by: TemporaryModel['by'], at: string,
): TemporaryModel | null {
  const from = rec.modelTemporary ? rec.modelTemporary.from : (rec.cliModel ?? null)
  if (to === (from ?? ENGINE_DEFAULT_MODEL)) return null
  return { from, to, by, at }
}

/** Why the session stays on its temporary model for now, or null. Pure. */
export function restoreHeldBy(rec: SessionRecord, nowMs: number): string | null {
  const t = rec.modelTemporary
  if (!t) return 'not-temporary'
  if (Date.parse(t.at) > nowMs) return 'not-yet'
  if (t.by === 'safeguard-switch') {
    const today = (rec.safeguardSwitch?.switches ?? []).filter((s) => nowMs - Date.parse(s.at) < DAY_MS).length
    if (today >= RESTORE_PAUSE_AFTER_SWITCHES) return 'switched-often'
  }
  return null
}

export interface ModelRestoreDeps {
  now: () => number
  getSession: (sessionId: string) => Promise<SessionRecord | null>
  /** Switch the model (session-controls.ts applySessionModelChange); false when it did not take. */
  applyModel: (sessionId: string, modelId: string) => Promise<boolean>
  /** Clear the mark, only while the record still holds this one (`at`). */
  clearMark: (sessionId: string, at: string) => Promise<void>
  /** A switch of the safeguard switch holds the session now. */
  switching: (sessionId: string) => Promise<boolean>
  emitNote: (sessionId: string, taskId: string | undefined, message: string) => void
}

function defaultDeps(): ModelRestoreDeps {
  return {
    now: () => Date.now(),
    getSession: async (id) => (await import('../session-tracker.js')).getSessionByClaudeId(id),
    applyModel: async (id, modelId) => {
      const { applySessionModelChange } = await import('./session-controls.js')
      const r = await applySessionModelChange(id, modelId, { remember: false }) as { appliedLive?: boolean; applied?: boolean; cliModel?: string }
      // A CLI that is not live takes the stored model at its next start; a live one must have taken it.
      const { getSessionByClaudeId } = await import('../session-tracker.js')
      const now = await getSessionByClaudeId(id)
      const live = now?.process_status === 'running' || now?.process_status === 'idle'
      return r.applied === true || !live || r.appliedLive === true
    },
    clearMark: async (id, at) => {
      const { updateSessionRecordConditionally } = await import('../session-tracker.js')
      await updateSessionRecordConditionally(id, { modelTemporary: null }, (cur) => cur.modelTemporary?.at === at, { preserveLastActiveAt: true })
    },
    switching: async (id) => (await import('./safeguard-switch.js')).safeguardSwitchHolds(id),
    emitNote: (sessionId, taskId, message) => {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, { sessionId, taskId, variant: 'info', message },
        ['main-ai'], { source: 'model-restore', urgency: 'normal' })
    },
  }
}

export class ModelRestore {
  private readonly deps: ModelRestoreDeps
  private readonly busy = new Set<string>()
  private stopped = false

  constructor(deps: Partial<ModelRestoreDeps> = {}) {
    this.deps = { ...defaultDeps(), ...deps }
  }

  handleEvent = (event: BusEvent): void => {
    if (this.stopped || event.name !== EventNames.SESSION_RESULT) return
    const d = event.data as Record<string, unknown>
    const sessionId = typeof d.sessionId === 'string' ? d.sessionId : undefined
    if (!sessionId || isQuietTurn(sessionId, d.turnGen)) return
    // Only a turn the model answered: a refusal, an error or a stop leaves the work unanswered.
    if (d.safeguardStop || d.isError === true || d.interrupted === true || d.compactionStopped === true || d.processDied === true) return
    // The work goes on (a team or background job still running): the turn is not over yet.
    if (d.teamActive === true || d.backgroundActive === true) return
    void this.restore(sessionId).catch((err) => log.session.warn('model restore failed', { sessionId, error: err instanceof Error ? err.message : String(err) }))
  }

  /** Put the session back on its own model when its temporary turn is over. Resolves to what it did. */
  async restore(sessionId: string): Promise<'restored' | string> {
    if (this.busy.has(sessionId)) return 'busy'
    this.busy.add(sessionId)
    try {
      const rec = await this.deps.getSession(sessionId)
      if (!rec || rec.archived) return 'session-gone'
      const t = rec.modelTemporary
      const held = restoreHeldBy(rec, this.deps.now())
      if (!t || held) return held ?? 'not-temporary'
      if (await this.deps.switching(sessionId)) return 'switching'
      const target = restoreTarget(t)
      const ok = await this.deps.applyModel(sessionId, target).catch((err) => {
        log.session.warn('model restore: switch back failed', { sessionId, model: target, error: err instanceof Error ? err.message : String(err) })
        return false
      })
      // The mark stays: the next clean turn tries again.
      if (!ok || this.stopped) return 'not-applied'
      await this.deps.clearMark(sessionId, t.at)
      const ownName = t.from ?? 'its default model'
      this.deps.emitNote(sessionId, rec.taskId, `Walnut moved this session back to ${ownName}: ${t.to} was for one turn only.`)
      log.session.info('model restore: back on its own model', { sessionId, taskId: rec.taskId, from: t.to, to: target, by: t.by })
      return 'restored'
    } finally {
      this.busy.delete(sessionId)
    }
  }

  stop(): void { this.stopped = true }
}

/** Start it on the primary. */
export function startModelRestore(deps: Partial<ModelRestoreDeps> = {}): { stop: () => void; instance: ModelRestore } {
  const r = new ModelRestore(deps)
  bus.subscribe('model-restore', r.handleEvent, { global: true, interest: ['session:result'] })
  return {
    instance: r,
    stop: () => { bus.unsubscribe('model-restore'); r.stop() },
  }
}
