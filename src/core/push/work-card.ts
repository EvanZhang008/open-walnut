/**
 * The lock-screen work card: one ActivityKit Live Activity on the phone (lock screen and
 * Dynamic Island) that says how many tasks are Working, how many Need you, and how many
 * were Completed since the card began, and opens the matching list on a tap.
 *
 * The phone starts the card itself, while the app is open and something is working
 * (ios-native WorkCardController), and hands this box the card's own push token
 * (`POST /api/push/work-card`, kept on the device's push row, registry.ts
 * setDeviceWorkCard). From then on this box keeps the card current while the phone is
 * locked: every change of the counts is sent to that token as a Live Activity content
 * update, and when nothing has worked for END_GRACE_MS the card is ended.
 *
 * SILENT BY CONSTRUCTION (the user's rule: the phone rings once, only when he must decide;
 * tests/core/push-producer-ratchet.test.ts guards the alert side). A card update is sent with
 * `apns-push-type: liveactivity` to the card's token, and its payload never carries `alert`,
 * `sound` or `badge` (workCardPayload; tests/core/work-card.test.ts fails on one). iOS then
 * redraws the card and does nothing else: no banner, no sound, no vibration, no lit screen.
 * The card is never STARTED by a push either, because a push-to-start needs an alert.
 *
 * The numbers are the Org's, the same everywhere (org-tree.ts userStateOf over orgTasks):
 * Working = a turn is running; Needs you = Needs you plus To read, folded as the phone draws
 * them (2026-11-03, the user: "I dont wnat serpeate to read"); Completed = org work whose
 * completed_at is inside the current stretch. A stretch begins when something starts working
 * and ends when the card ends; it survives a restart (STRETCH_FILE).
 *
 * Primary only (boot policy `work-card`): the tasks and the APNs key are here; a companion
 * relays both routes (web/routes/push.ts).
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../event-bus.js'
import { isOrgMember, isOrgWork, userStateOf } from '../org/org-tree.js'
import type { PushTokenEntry, Task } from '../types.js'
import type { ApnsSendOutcome, ApnsTarget } from './apns.js'
import { tokenTag } from './send.js'

/** Nothing worked for this long: the card ends. Agents pause between turns and between tasks,
 *  and a card that ended while the phone is locked comes back only when the app is opened, so
 *  the pause it rides out is generous. */
export const END_GRACE_MS = 15 * 60_000
/** At most one update per this, so a burst of status writes is one push. */
export const MIN_GAP_MS = 10_000
/** A push Apple keeps refusing is tried again ever more slowly, up to this apart. */
export const MAX_RETRY_MS = 10 * 60_000
/** How long Apple keeps an end for a phone that is offline: as long as iOS keeps a card. */
export const END_EXPIRES_MS = 8 * 3600_000
/** A card with no news is refreshed this often, so its stale date keeps moving. */
export const HEARTBEAT_MS = 20 * 60_000
/** A card that heard nothing for this long draws itself as out of date (the Mac asleep). */
export const STALE_AFTER_MS = 45 * 60_000
/** An ended card stays on the lock screen this long with its last numbers. */
export const DISMISS_AFTER_MS = 15 * 60_000
/** The title of the newest Needs you task, cut to fit one line of the card. */
export const TITLE_MAX = 60
const TICK_MS = 30_000
const DEBOUNCE_MS = 2_000
const SUBSCRIBER = 'work-card'
const STRETCH_FILE = path.join(WALNUT_HOME, 'cache', 'work-card.json')

/**
 * What the card draws: the ActivityKit content state, field for field
 * (ios-native/Shared/WorkCardAttributes.swift `ContentState`). Times are epoch seconds:
 * ActivityKit decodes a Date in its own reference epoch, so none is sent as a Date.
 */
export interface WorkCardState {
  working: number
  needs: number
  completed: number
  /** When the stretch began: Completed counts from here. */
  since: number
  /** When these numbers were read. */
  updatedAt: number
  /** The newest Needs you task's title, absent when nothing needs the user. */
  needsTitle?: string
  /** That task's id: a tap on its title opens it. */
  needsTaskId?: string
  /** On the last push only: when the card ended, so it reads as finished, not as still running. */
  endedAt?: number
}

/** The tasks behind each number, for the list a tap opens (newest first). */
export interface WorkCardLists {
  working: string[]
  needs: string[]
  completed: string[]
}

type CardTask = Pick<Task, 'id' | 'title' | 'phase' | 'user_status' | 'org_role' | 'plugin_only' | 'walnut_agent' | 'project' | 'completed_at' | 'updated_at' | 'created_at'>

function cutTitle(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length <= TITLE_MAX ? one : `${chars.slice(0, TITLE_MAX - 1).join('')}…`
}

function newest(a: CardTask, b: CardTask): number {
  const ta = a.updated_at ?? a.created_at ?? ''
  const tb = b.updated_at ?? b.created_at ?? ''
  return ta === tb ? (a.id < b.id ? -1 : 1) : (ta < tb ? 1 : -1)
}

/** What the last read headlined, so the title under the counts stays put (see workCardSnapshot). */
export interface Headline { id?: string; needs: readonly string[] }

/**
 * The card's numbers and lists over these tasks. Pure.
 *
 * The title under the counts is the task that most recently came to need the user: one that
 * joined Needs you since the last read (`prev`), else the one already shown while it still
 * needs the user, else the newest. Ordering by the last write alone made the title hop
 * between tasks on every status write, and each hop was a push.
 */
export function workCardSnapshot(tasks: readonly CardTask[], sinceMs: number, nowMs: number, prev?: Headline): { state: WorkCardState; lists: WorkCardLists; headline: Headline } {
  const working: CardTask[] = []
  const needs: CardTask[] = []
  const completed: CardTask[] = []
  for (const t of tasks) {
    if (typeof t.title !== 'string') continue
    if (t.phase === 'COMPLETE') {
      const at = Date.parse(t.completed_at ?? '')
      if (Number.isFinite(at) && at >= sinceMs && isOrgWork(t)) completed.push(t)
      continue
    }
    if (!isOrgMember(t)) continue
    const s = userStateOf(t)
    if (s === 'working') working.push(t)
    else if (s === 'needs' || s === 'read') needs.push(t)
  }
  working.sort(newest)
  needs.sort(newest)
  completed.sort((a, b) => ((a.completed_at ?? '') < (b.completed_at ?? '') ? 1 : -1))
  const known = new Set(prev?.needs ?? needs.map((t) => t.id))
  const head = needs.find((t) => !known.has(t.id))
    ?? (prev?.id !== undefined ? needs.find((t) => t.id === prev.id) : undefined)
    ?? needs[0]
  const state: WorkCardState = {
    working: working.length,
    needs: needs.length,
    completed: completed.length,
    since: Math.floor(sinceMs / 1000),
    updatedAt: Math.floor(nowMs / 1000),
    ...(head ? { needsTitle: cutTitle(head.title), needsTaskId: head.id } : {}),
  }
  const ids = { working: working.map((t) => t.id), needs: needs.map((t) => t.id), completed: completed.map((t) => t.id) }
  return { state, lists: ids, headline: { ...(head ? { id: head.id } : {}), needs: ids.needs } }
}

/** What changes the card's face: the update time alone is no news. */
export function contentKey(s: WorkCardState): string {
  return `${s.working}|${s.needs}|${s.completed}|${s.since}|${s.needsTitle ?? ''}|${s.needsTaskId ?? ''}`
}

/**
 * The APNs payload of one card push. Never an `alert`, a `sound` or a `badge`: those are what
 * make a phone light up, ring or vibrate, and a card update must do none of that. Pure.
 */
export function workCardPayload(event: 'update' | 'end', state: WorkCardState, nowMs: number): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(nowMs / 1000),
    event,
    'content-state': state,
  }
  if (event === 'update') aps['stale-date'] = Math.floor((nowMs + STALE_AFTER_MS) / 1000)
  else aps['dismissal-date'] = Math.floor((nowMs + DISMISS_AFTER_MS) / 1000)
  return { aps }
}

/** Apple's two priorities: 10 now, 5 when it suits the phone's battery (Apple budgets the 10s
 *  of a Live Activity, so they are kept for what the user must see at once). A new Needs you is
 *  now, counted or headlined; the first push of a stretch is not (the phone drew those numbers
 *  itself when it started the card). */
export function updatePriority(prev: WorkCardState | null, next: WorkCardState): 5 | 10 {
  if (!prev) return 5
  return next.needs > prev.needs || (next.needs > 0 && next.needsTitle !== prev.needsTitle) ? 10 : 5
}

/** How long Apple keeps a card push for a phone it cannot reach: an update until the card
 *  goes stale anyway, an end as long as a card can live. */
export function pushExpiry(event: 'update' | 'end', nowMs: number): number {
  return Math.floor((nowMs + (event === 'end' ? END_EXPIRES_MS : STALE_AFTER_MS)) / 1000)
}

/** What the clock keeps across a restart (STRETCH_FILE). */
export interface SavedCard {
  stretchSince: number | null
  /** An end not every card took yet, with the numbers it ends on. */
  endOwed?: boolean
  endState?: WorkCardState
  /** Since when nothing has worked: the grace runs on across a restart. */
  idleSince?: number
  /** The numbers the cards last took, so a restart neither resends them nor rings them in at priority 10. */
  lastSent?: { at: number; state: WorkCardState }
  /** The title the cards show, so a restart keeps it rather than picking another and ringing
   *  that in at priority 10. */
  headline?: Headline
}

export type CardStep =
  | { kind: 'none'; retryInMs?: number }
  | { kind: 'update'; priority: 5 | 10 }
  | { kind: 'end'; state: WorkCardState }

/**
 * The card's clock: when a stretch begins and ends, and which changes are sent. Pure apart
 * from its own fields; every time is passed in. A step says what to send; only `delivered`
 * records it as sent, so a push that failed (the Mac just woke, the network dropped) is
 * tried again rather than lost until the next change.
 */
export class WorkCardClock {
  /** When the current stretch began (epoch ms), null when no card should show. */
  stretchSince: number | null = null
  private zeroSince: number | null = null
  private lastSent: { key: string; at: number; state: WorkCardState } | null = null
  /** The last push tried, delivered or not: the gap between two tries. */
  private lastTry: number | null = null
  /** An `end` some card has not taken yet: sent again, with the stretch's last numbers
   *  (`endState`), until every card took it. */
  private endOwed = false
  private endState: WorkCardState | null = null
  /** Pushes refused in a row: each doubles the wait before the next try (MAX_RETRY_MS at most). */
  private failures = 0

  constructor(saved: SavedCard | number | null = null) {
    const s = typeof saved === 'object' && saved !== null ? saved : { stretchSince: saved }
    this.stretchSince = s.stretchSince
    this.endOwed = s.endOwed === true && s.stretchSince === null && s.endState !== undefined
    if (this.endOwed) this.endState = s.endState!
    if (s.stretchSince !== null && typeof s.idleSince === 'number') this.zeroSince = s.idleSince
    if (s.lastSent && s.stretchSince !== null) this.lastSent = { key: contentKey(s.lastSent.state), at: s.lastSent.at, state: s.lastSent.state }
  }

  /** What a restart needs to carry on where this left off. */
  saved(): SavedCard {
    return {
      stretchSince: this.stretchSince,
      ...(this.endOwed && this.endState ? { endOwed: true, endState: this.endState } : {}),
      ...(this.zeroSince !== null && this.stretchSince !== null ? { idleSince: this.zeroSince } : {}),
      ...(this.lastSent ? { lastSent: { at: this.lastSent.at, state: this.lastSent.state } } : {}),
    }
  }

  /** The wait between two tries: MIN_GAP_MS, doubled for each push refused in a row. */
  get retryGapMs(): number { return Math.min(MIN_GAP_MS * 2 ** this.failures, MAX_RETRY_MS) }

  /** Before reading the counts: the stretch the counts are read for. */
  begin(working: number, now: number): number {
    if (working > 0) {
      this.zeroSince = null
      if (this.stretchSince === null) {
        this.stretchSince = now
        this.lastSent = null
        this.lastTry = null
        this.failures = 0
        // A card that never took the last end is the new stretch's card now: it gets updates.
        this.endOwed = false
        this.endState = null
      }
    }
    return this.stretchSince ?? now
  }

  /** After reading them: what to send now. A held-back change is sent by a later step. */
  step(state: WorkCardState, now: number): CardStep {
    const wait = this.retryGapMs
    const gap = this.lastTry !== null && now - this.lastTry < wait ? wait - (now - this.lastTry) : 0
    if (this.stretchSince === null) {
      if (!this.endOwed || !this.endState) return { kind: 'none' }
      if (gap) return { kind: 'none', retryInMs: gap }
      this.lastTry = now
      return { kind: 'end', state: this.endState }
    }
    if (state.working === 0) {
      this.zeroSince ??= now
      if (now - this.zeroSince >= END_GRACE_MS) {
        this.stretchSince = null
        this.zeroSince = null
        this.lastSent = null
        this.endOwed = true
        this.endState = { ...state, endedAt: Math.floor(now / 1000) }
        this.lastTry = now
        this.failures = 0
        return { kind: 'end', state: this.endState }
      }
    }
    const key = contentKey(state)
    const last = this.lastSent
    if (last && last.key === key && now - last.at < HEARTBEAT_MS) return { kind: 'none' }
    if (gap) return { kind: 'none', retryInMs: gap }
    this.lastTry = now
    return { kind: 'update', priority: updatePriority(last?.state ?? null, state) }
  }

  /** Every card took this push (or there was none to send it to). */
  delivered(step: Exclude<CardStep, { kind: 'none' }>, state: WorkCardState, now: number): void {
    this.failures = 0
    if (step.kind === 'end') { this.endOwed = false; this.endState = null }
    // An update that lands after its stretch ended (it was in flight) records nothing.
    else if (this.stretchSince !== null) this.lastSent = { key: contentKey(state), at: now, state }
  }

  /** A card did not take this push: the next try waits longer. Returns that wait. */
  failed(): number {
    this.failures = Math.min(this.failures + 1, 16)
    return this.retryGapMs
  }

  /** The stretch is still showing a card: working, or inside the grace after the last. */
  get active(): boolean { return this.stretchSince !== null }
}

// ── Runtime (the primary's server) ──

export interface WorkCardDeps {
  tasks: () => Promise<CardTask[]>
  rows: () => Promise<PushTokenEntry[]>
  send: (targets: ApnsTarget[], payload: Record<string, unknown>, priority: number, expiration: number) => Promise<ApnsSendOutcome>
  clearTokens: (tokens: string[]) => Promise<number>
  now: () => number
  saveStretch: (card: SavedCard) => Promise<void>
  /** This box holds an APNs key, so it can keep a card current while the app is closed. */
  canPush?: () => Promise<boolean>
  /** A change held back by MIN_GAP_MS: read again after this long. */
  retryIn?: (ms: number) => void
}

async function defaultDeps(): Promise<WorkCardDeps> {
  const { listTasks } = await import('../task-manager.js')
  const { isTestRunTask } = await import('../test-run.js')
  const { getConfig } = await import('../config-manager.js')
  const { sendApns, apnsStatus } = await import('./apns.js')
  const { clearWorkCardTokens } = await import('./registry.js')
  const { partitionByPairing } = await import('./paired-rows.js')
  return {
    // Never a test run's tasks, whatever context a tick was scheduled from (orgTasks keeps them
    // for a test run's own request, and a timer set inside one runs in it).
    tasks: async () => (await listTasks()).filter((t) => !isTestRunTask(t)),
    // A row whose device was revoked is never sent, as deliver.ts does for letters.
    rows: async () => (await partitionByPairing(((await getConfig()).push_tokens ?? []).filter((r) => r.work_card))).live,
    send: (targets, payload, priority, expiration) => sendApns(targets, payload, { pushType: 'liveactivity', priority, expiration }),
    clearTokens: clearWorkCardTokens,
    now: Date.now,
    saveStretch: async (card) => {
      await fs.mkdir(path.dirname(STRETCH_FILE), { recursive: true })
      const tmp = `${STRETCH_FILE}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(card))
      await fs.rename(tmp, STRETCH_FILE)
    },
    canPush: async () => (await apnsStatus()).configured,
    retryIn: (ms) => { const t = setTimeout(() => schedule(), ms); t.unref?.() },
  }
}

function isHeadline(v: unknown): v is Headline {
  if (!v || typeof v !== 'object') return false
  const h = v as { id?: unknown; needs?: unknown }
  return (h.id === undefined || typeof h.id === 'string') && Array.isArray(h.needs) && h.needs.every((x) => typeof x === 'string')
}

/** The clock's saved state; anything unreadable is a fresh start. Pure apart from the read. */
export function parseSavedCard(text: string): SavedCard {
  try {
    const raw = JSON.parse(text) as { stretchSince?: unknown; endOwed?: unknown; endState?: unknown; idleSince?: unknown; lastSent?: { at?: unknown; state?: unknown }; headline?: { id?: unknown; needs?: unknown } }
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
    const isState = (v: unknown): v is WorkCardState => !!v && typeof v === 'object'
      && (['working', 'needs', 'completed', 'since', 'updatedAt'] as const).every((k) => num((v as Record<string, unknown>)[k]))
    const since = num(raw.stretchSince) ? raw.stretchSince : null
    const st = raw.lastSent?.state
    return {
      stretchSince: since,
      ...(raw.endOwed === true && isState(raw.endState) ? { endOwed: true, endState: raw.endState } : {}),
      ...(num(raw.idleSince) ? { idleSince: raw.idleSince } : {}),
      ...(num(raw.lastSent?.at) && isState(st) ? { lastSent: { at: raw.lastSent!.at as number, state: st } } : {}),
      ...(since !== null && isHeadline(raw.headline) ? { headline: raw.headline } : {}),
    }
  } catch {
    return { stretchSince: null }
  }
}

async function loadStretch(): Promise<SavedCard> {
  try { return parseSavedCard(await fs.readFile(STRETCH_FILE, 'utf8')) } catch { return { stretchSince: null } }
}

/** iOS ends a Live Activity 8 hours after it started; its token is registered just after. */
export const CARD_LIFETIME_MS = 8 * 60 * 60_000

/**
 * One target per card token, sent to the APNs environment of the row's device token. A token
 * registered more than CARD_LIFETIME_MS ago belongs to a card iOS has ended already: it is
 * `expired`, never a target (the phone would only learn of it the next time Walnut opens).
 */
export function cardTargets(rows: readonly PushTokenEntry[], nowMs?: number): ApnsTarget[] & { expired?: string[] } {
  const seen = new Set<string>()
  const out: ApnsTarget[] & { expired?: string[] } = []
  for (const r of rows) {
    const token = r.work_card?.token
    if (!token || seen.has(token)) continue
    seen.add(token)
    const at = Date.parse(r.work_card!.registered_at)
    if (nowMs !== undefined && Number.isFinite(at) && nowMs - at > CARD_LIFETIME_MS) {
      (out.expired ??= []).push(token)
      continue
    }
    out.push({ token, ...(r.environment ? { environment: r.environment } : {}) })
  }
  return out
}

export interface WorkCardView {
  state: WorkCardState
  lists: WorkCardLists
  /** A card should show: something works, or the last stopped within END_GRACE_MS. */
  active: boolean
  /** The stretch's id (its start, ISO): the phone keeps one card per stretch. */
  stretch: string | null
  /** This box can keep the card current while the app is closed (it holds an APNs key).
   *  False: the card shows what the app last read and goes stale. */
  pushes: boolean
}

export class WorkCardService {
  readonly clock: WorkCardClock
  /** Reads run one at a time, and so do pushes, each in order; a read never waits on a push. */
  private reads: Promise<unknown> = Promise.resolve()
  private sends: Promise<unknown> = Promise.resolve()
  private lastView: WorkCardView | null = null
  private lastSaved: string
  private headline: Headline | undefined
  /** Cards that missed an update the others took (`at`: the last try): they alone get it
   *  again, at priority 5, so a healthy card is not rung again for the one that failed. */
  private owed: { tokens: Set<string>; at: number } | null = null

  constructor(private readonly deps: WorkCardDeps, saved: SavedCard | number | null = null) {
    this.clock = new WorkCardClock(saved)
    if (typeof saved === 'object' && saved?.headline && saved.stretchSince !== null) this.headline = saved.headline
    this.lastSaved = JSON.stringify(this.saved())
  }

  /** The clock's state and, within a stretch, the title its cards show. */
  private saved(): SavedCard {
    const c = this.clock.saved()
    const h = this.headline
    return c.stretchSince !== null && h && (h.id !== undefined || h.needs.length > 0) ? { ...c, headline: h } : c
  }

  /**
   * Read the counts and return what the card shows. What the card needs is pushed after, on a
   * queue of its own, so a caller (the phone's GET) never waits on Apple, not even behind an
   * earlier push that is still timing out.
   */
  tick(): Promise<WorkCardView> {
    const read = this.reads.then(() => this.read(), () => this.read())
    this.reads = read.catch(() => {})
    this.sends = Promise.all([this.sends, read]).then(([, r]) => r.send()).catch((err) => {
      log.notif.warn('work card: push failed', { error: err instanceof Error ? err.message : String(err) })
    })
    return read.then((r) => r.view)
  }

  /** Write the clock's state when it changed; a failed write is retried on the next change. */
  private async persist(): Promise<void> {
    const card = this.saved()
    const now = JSON.stringify(card)
    if (now === this.lastSaved) return
    try {
      await this.deps.saveStretch(card)
      this.lastSaved = now
    } catch { /* kept in memory; the next change writes again */ }
  }

  private async read(): Promise<{ view: WorkCardView; send: () => Promise<void> }> {
    const now = this.deps.now()
    const [tasks, pushes] = await Promise.all([this.deps.tasks(), this.deps.canPush?.().catch(() => false) ?? Promise.resolve(false)])
    // The stretch is decided on the working count, then the Completed count is read inside it.
    const probe = workCardSnapshot(tasks, now, now, this.headline)
    const since = this.clock.begin(probe.state.working, now)
    const snap = since === now ? probe : workCardSnapshot(tasks, since, now, this.headline)
    this.headline = snap.headline
    const step = this.clock.step(snap.state, now)
    await this.persist()
    const view: WorkCardView = {
      state: snap.state,
      lists: snap.lists,
      active: this.clock.active,
      stretch: this.clock.stretchSince !== null ? new Date(this.clock.stretchSince).toISOString() : null,
      pushes,
    }
    this.lastView = view
    const send = async (): Promise<void> => {
      if (step.kind !== 'none') await this.push(step, step.kind === 'end' ? step.state : snap.state, now)
      else if (this.owed && this.clock.active) await this.pushOwed(snap.state, now)
      else if (step.retryInMs !== undefined) this.deps.retryIn?.(step.retryInMs)
    }
    return { view, send }
  }

  /** The cards an update missed, once the wait since their last try is over. */
  private async pushOwed(state: WorkCardState, now: number): Promise<void> {
    const owed = this.owed!
    const wait = this.clock.retryGapMs - (now - owed.at)
    if (wait > 0) { this.deps.retryIn?.(wait); return }
    await this.push({ kind: 'update', priority: 5 }, state, now, owed.tokens)
  }

  private async push(step: Exclude<CardStep, { kind: 'none' }>, state: WorkCardState, now: number, only?: Set<string>): Promise<void> {
    // Work began again while this end waited its turn: the card is the new stretch's, and takes
    // its updates instead.
    if (step.kind === 'end' && this.clock.active) return
    if (step.kind === 'end') this.owed = null
    const all = cardTargets(await this.deps.rows(), now)
    if (all.expired?.length) await this.deps.clearTokens(all.expired).catch(() => 0)
    const targets = only ? all.filter((t) => only.has(t.token)) : all
    // Every card that missed it has left the rows (ended, unpaired): nothing is owed.
    if (only && targets.length === 0) { this.owed = null; return }
    // No card to tell, or no APNs key to tell it with (the phone ends its card itself the next
    // time Walnut opens): nothing is owed.
    const canPush = this.deps.canPush ? await this.deps.canPush().catch(() => false) : true
    if (targets.length === 0 || !canPush) { this.owed = null; this.clock.delivered(step, state, now); await this.persist(); return }
    const event = step.kind === 'end' ? 'end' : 'update'
    const out = await this.deps.send(targets, workCardPayload(event, state, now), step.kind === 'end' ? 10 : step.priority, pushExpiry(event, now))
    const settled = new Set([...(out.delivered ?? []), ...out.deadTokens])
    // Only a push every card took (or whose token is dead) counts as sent. Anything else, a
    // refusal, a timeout, no APNs key on this box, is tried again, each time later, up to
    // MAX_RETRY_MS apart: never lost, never every ten seconds forever.
    let retryMs: number | undefined
    const missed = targets.filter((t) => !settled.has(t.token)).map((t) => t.token)
    if (out.attempted && missed.length === 0) {
      this.clock.delivered(step, state, now)
      if (step.kind === 'update') this.owed = null
    } else if (out.attempted && step.kind === 'update' && missed.length < targets.length) {
      // Some cards took it: they are current. Only the others get it again.
      this.clock.delivered(step, state, now)
      this.owed = { tokens: new Set(missed), at: now }
      retryMs = this.clock.failed()
      this.deps.retryIn?.(retryMs)
    } else {
      if (only) this.owed = { tokens: only, at: now }
      retryMs = this.clock.failed()
      this.deps.retryIn?.(retryMs)
    }
    await this.persist()
    // A card that took its end takes no more updates, and a dead token never will: both leave the
    // rows. A card whose end did not get through keeps its token, for the retry.
    const gone = step.kind === 'end' ? [...settled] : out.deadTokens
    if (gone.length > 0) await this.deps.clearTokens(gone).catch(() => 0)
    log.notif.info('work card push', {
      event, cards: targets.length, sent: out.sent, failed: out.failed,
      working: state.working, needs: state.needs, completed: state.completed,
      ...(out.attempted ? {} : { reason: out.reason }),
      ...(retryMs !== undefined ? { retryInS: Math.round(retryMs / 1000) } : {}),
      ...(out.deadTokens.length ? { dead: out.deadTokens.map(tokenTag) } : {}),
    })
  }

  /** Every read and push asked for so far is done (a test seam). */
  async idle(): Promise<void> { await this.reads; await this.sends }

  /** The last view without reading again (a test seam and the log). */
  get view(): WorkCardView | null { return this.lastView }
}

let service: WorkCardService | null = null
let debounce: ReturnType<typeof setTimeout> | null = null
let ticker: ReturnType<typeof setInterval> | null = null

function schedule(): void {
  if (!service || debounce) return
  debounce = setTimeout(() => {
    debounce = null
    void service?.tick().catch((err) => log.notif.warn('work card: tick failed', { error: err instanceof Error ? err.message : String(err) }))
  }, DEBOUNCE_MS)
  debounce.unref?.()
}

/**
 * End these cards at once (their device was revoked): the old pairing's numbers and titles
 * must not stay on that lock screen until Walnut is next opened there. One silent `end` with
 * a dismissal date of now; never throws.
 */
export async function endCardsNow(targets: ApnsTarget[]): Promise<void> {
  if (targets.length === 0) return
  try {
    const { sendApns } = await import('./apns.js')
    const now = Date.now()
    const last = service?.view?.state
    const state: WorkCardState = {
      working: last?.working ?? 0, needs: last?.needs ?? 0, completed: last?.completed ?? 0,
      since: last?.since ?? Math.floor(now / 1000), updatedAt: Math.floor(now / 1000), endedAt: Math.floor(now / 1000),
    }
    const payload = workCardPayload('end', state, now)
    ;(payload.aps as Record<string, unknown>)['dismissal-date'] = Math.floor(now / 1000)
    const out = await sendApns(targets, payload, { pushType: 'liveactivity', priority: 10, expiration: pushExpiry('end', now) })
    log.notif.info('work card push', { event: 'end', reason: 'device revoked', cards: targets.length, sent: out.sent, failed: out.failed })
  } catch (err) {
    log.notif.warn('work card: revoke end failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Start the card's clock (server boot, primary only). Idempotent. */
export async function startWorkCard(deps?: WorkCardDeps): Promise<WorkCardService> {
  if (service) return service
  service = new WorkCardService(deps ?? await defaultDeps(), await loadStretch())
  bus.subscribe(SUBSCRIBER, () => schedule(), {
    global: true,
    interest: [EventNames.TASK_CREATED, EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED, EventNames.TASK_DELETED],
  })
  ticker = setInterval(() => schedule(), TICK_MS)
  ticker.unref?.()
  schedule()
  return service
}

export function stopWorkCard(): void {
  bus.unsubscribe(SUBSCRIBER)
  if (debounce) clearTimeout(debounce)
  if (ticker) clearInterval(ticker)
  debounce = null
  ticker = null
  service = null
}

/**
 * What the card shows now, for the phone (`GET /api/push/work-card`): read fresh, so a card
 * the app starts carries the same numbers this box will push. A server that runs no clock
 * (boot policy off), and a test run, get the numbers alone, never active.
 */
export async function workCardNow(): Promise<WorkCardView> {
  // A test run reads its own tasks (org-store.ts orgTasks) and must never move the user's card:
  // it gets the numbers alone, and the clock and the pushes stay the user's.
  const { ambientTestRun } = await import('../test-run.js')
  if (service && ambientTestRun() === undefined) return await service.tick()
  const { orgTasks } = await import('../org/org-store.js')
  const now = Date.now()
  const snap = workCardSnapshot(await orgTasks(), now, now)
  return { ...snap, active: false, stretch: null, pushes: false }
}
