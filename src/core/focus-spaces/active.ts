/**
 * Being in a focus space: which one, since when, until when.
 *
 * Entering holds Walnut quiet (quiet-state.ts, source `focus-space`) with the space's scope, so
 * an interruption about a task inside it gets through and everything else waits: no toast, no
 * system notice, no push (push/quiet-hold.ts). The views of every window show only the space
 * (web/src/focus-spaces/). Leaving lets the hold go; what waited is what the window lists.
 *
 * One person, one focus: the state is the server's, not a window's, because the gates it
 * drives (the phone's pushes) are the server's too. A space can also be entered without being
 * saved (a Rhythm focus block on one task): `scope` then carries it alone.
 *
 * Kept in <WALNUT_HOME>/local/focus-active.json, this box's own (git-sync never carries it),
 * so a restart in the middle of a focus stays in it until its `until`.
 */
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { bus, EventNames } from '../event-bus.js'
import { clearQuiet, getQuiet, setQuiet } from '../quiet/quiet-state.js'
import { FOCUS_BY, normalizeScope, scopeIsEmpty, type ActiveFocus, type FocusBy, type FocusScope } from './scope.js'
import { FocusSpaceError, getFocusSpace, spaceScope, type FocusSpace } from './store.js'

export const FOCUS_QUIET_SOURCE = 'focus-space'

export { FOCUS_BY }
export type { ActiveFocus, FocusBy }

export interface EnterFocusInput {
  spaceId?: string
  /** An unsaved focus (a focus block on one task): its scope and name. */
  scope?: unknown
  name?: unknown
  /** Epoch ms. */
  until?: unknown
  by?: unknown
  owner?: unknown
}

const MAX_MS = 24 * 60 * 60 * 1000
let current: ActiveFocus | null | undefined

function activeFile(): string {
  return path.join(WALNUT_HOME, 'local', 'focus-active.json')
}

function readActive(raw: unknown, now: number): ActiveFocus | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const scope = normalizeScope(r.scope)
  if (scopeIsEmpty(scope) || typeof r.since !== 'number') return null
  const until = typeof r.until === 'number' ? r.until : undefined
  if (until !== undefined && until <= now) return null
  const by = FOCUS_BY.find((b) => b === r.by) ?? 'person'
  return {
    ...(typeof r.spaceId === 'string' ? { spaceId: r.spaceId } : {}),
    name: typeof r.name === 'string' && r.name ? r.name.slice(0, 60) : 'Focus',
    scope, since: r.since, ...(until !== undefined ? { until } : {}), by,
    ...(typeof r.owner === 'string' && r.owner ? { owner: r.owner.slice(0, 120) } : {}),
  }
}

function publish(): void {
  bus.emit(EventNames.FOCUS_SPACE_CHANGED, { active: current ?? null }, ['web-ui'], { source: 'focus-spaces' })
}

// Every change runs one at a time (enter, leave, a space's change, an end that came due): the
// file, the quiet hold and the event move together, and a check before a change ("only over a
// block's") holds until the change is made.
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

function due(f: ActiveFocus | null | undefined, now: number): boolean {
  return !!f && f.until !== undefined && f.until <= now
}

/** Inside `serial` only: the focus now, an ended one dropped. */
async function loadLocked(now: number): Promise<ActiveFocus | null> {
  if (current === undefined) current = readActive(await readJsonFile<unknown>(activeFile(), null), now)
  if (due(current, now)) await leaveLocked()
  return current ?? null
}

async function leaveLocked(): Promise<void> {
  current = null
  await writeJsonFile(activeFile(), null)
  await clearQuiet(FOCUS_QUIET_SOURCE)
  publish()
}

async function enterLocked(input: EnterFocusInput, now: number, allow?: (prev: ActiveFocus | null) => boolean): Promise<ActiveFocus | null> {
  const prev = await loadLocked(now)
  if (allow && !allow(prev)) return null
  const next = await resolveFocus(input, prev, getFocusSpace, now)
  current = next
  try {
    await writeJsonFile(activeFile(), current)
    await setQuiet({
      source: FOCUS_QUIET_SOURCE,
      reason: `Focus: ${next.name}`,
      scope: next.scope,
      ...(next.until !== undefined ? { until: next.until } : {}),
    })
  } catch (err) {
    // Half done (the file written, the hold not): back to the focus there was, so the two agree.
    current = prev
    await writeJsonFile(activeFile(), prev).catch(() => {})
    throw err
  }
  publish()
  return next
}

/** The focus now (null: none), an ended one dropped. */
export async function getActiveFocus(now = Date.now()): Promise<ActiveFocus | null> {
  if (current !== undefined && !due(current, now)) return current
  return serial(() => loadLocked(now))
}

/**
 * The focus `input` asks for, after `previous` (no file touched, no hold set): a test run keeps
 * its own copy, so the rule is shared with the real enter.
 */
export async function resolveFocus(
  input: EnterFocusInput,
  previous: ActiveFocus | null,
  findSpace: (id: string) => Promise<FocusSpace | null>,
  now = Date.now(),
): Promise<ActiveFocus> {
  let name = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : ''
  let scope: FocusScope
  let spaceId: string | undefined
  if (input.spaceId) {
    const space = await findSpace(input.spaceId)
    if (!space) throw new FocusSpaceError('not_found', 'No such focus space.')
    scope = spaceScope(space)
    name = space.name
    spaceId = space.id
  } else {
    scope = normalizeScope(input.scope)
  }
  if (scopeIsEmpty(scope)) throw new FocusSpaceError('bad_request', 'A focus needs a saved space or at least one project or task.')
  if (input.until !== undefined && (typeof input.until !== 'number' || !Number.isFinite(input.until) || input.until <= now || input.until > now + MAX_MS)) {
    throw new FocusSpaceError('bad_request', '`until` must be an epoch time in milliseconds within the next 24 hours.')
  }
  const by = (FOCUS_BY as readonly unknown[]).includes(input.by) ? input.by as FocusBy : 'person'
  return {
    ...(spaceId ? { spaceId } : {}),
    name: name || 'Focus',
    scope,
    // Moving to another space keeps when focus began: the rest still waited since then.
    since: previous && (previous.until === undefined || previous.until > now) ? previous.since : now,
    ...(input.until !== undefined ? { until: input.until } : {}),
    by,
    ...(typeof input.owner === 'string' && input.owner ? { owner: input.owner.slice(0, 120) } : {}),
  }
}

/** Enter a saved space, or an unsaved scope. Replaces the focus there was. */
export async function enterFocus(input: EnterFocusInput, now = Date.now()): Promise<ActiveFocus> {
  return (await serial(() => enterLocked(input, now)))!
}

/**
 * Enter only when `allow` says so of the focus there is, checked and entered in one step (a focus
 * block enters only over none or a block's). Null: refused, nothing changed.
 */
export async function enterFocusIf(input: EnterFocusInput, allow: (prev: ActiveFocus | null) => boolean, now = Date.now()): Promise<ActiveFocus | null> {
  return serial(() => enterLocked(input, now, allow))
}

/** A saved space changed or went: the focus in it follows (its new list, or leaving). */
export async function followSpaceChange(spaceId: string): Promise<void> {
  await serial(async () => {
    const was = await loadLocked(Date.now())
    if (!was || was.spaceId !== spaceId) return
    const space = await getFocusSpace(spaceId)
    if (!space) { await leaveLocked(); return }
    await enterLocked({ spaceId, by: was.by, ...(was.owner ? { owner: was.owner } : {}), ...(was.until !== undefined ? { until: was.until } : {}) }, Date.now())
  })
}

/**
 * Leave the focus. Returns the one that ended (null: there was none, or it was not the one named).
 * `onlyBy`/`onlyOwner`: a focus block ending leaves only the focus it entered itself, never one the
 * person chose since, nor another plugin's (or its own newer generation's) block.
 */
export async function leaveFocus(opts: { onlyBy?: FocusBy; onlyOwner?: (owner: string | undefined) => boolean } = {}): Promise<ActiveFocus | null> {
  return serial(async () => {
    const was = await loadLocked(Date.now())
    if (!was) return null
    if (opts.onlyBy && was.by !== opts.onlyBy) return null
    if (opts.onlyOwner && !opts.onlyOwner(was.owner)) return null
    await leaveLocked()
    return was
  })
}

/**
 * The file and the quiet hold agree (at start): a focus whose hold went (a crash between the two
 * writes) holds again, and a hold whose focus ended or went lets go.
 */
export async function reconcileFocusQuiet(now = Date.now()): Promise<void> {
  await serial(async () => {
    const f = await loadLocked(now)
    const hold = (await getQuiet()).holds.find((h) => h.source === FOCUS_QUIET_SOURCE)
    if (!f && hold) await clearQuiet(FOCUS_QUIET_SOURCE)
    if (f && !hold) {
      await setQuiet({ source: FOCUS_QUIET_SOURCE, reason: `Focus: ${f.name}`, scope: f.scope, ...(f.until !== undefined ? { until: f.until } : {}) })
    }
  })
}

/** Tests: forget the in-memory copy (the file stays). */
export function resetActiveFocus(): void {
  current = undefined
}
