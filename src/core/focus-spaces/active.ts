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
import { clearQuiet, setQuiet } from '../quiet/quiet-state.js'
import { normalizeScope, scopeIsEmpty, type FocusScope } from './scope.js'
import { FocusSpaceError, getFocusSpace, spaceScope, type FocusSpace } from './store.js'

export const FOCUS_QUIET_SOURCE = 'focus-space'

export const FOCUS_BY = ['person', 'block', 'quick-bar', 'agent'] as const
export type FocusBy = typeof FOCUS_BY[number]

export interface ActiveFocus {
  /** The saved space, when it is one. */
  spaceId?: string
  name: string
  scope: FocusScope
  /** Epoch ms. */
  since: number
  /** Epoch ms; absent = until left. */
  until?: number
  by: FocusBy
}

export interface EnterFocusInput {
  spaceId?: string
  /** An unsaved focus (a focus block on one task): its scope and name. */
  scope?: unknown
  name?: unknown
  /** Epoch ms. */
  until?: unknown
  by?: unknown
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
  }
}

function publish(): void {
  bus.emit(EventNames.FOCUS_SPACE_CHANGED, { active: current ?? null }, ['web-ui'], { source: 'focus-spaces' })
}

/** The focus now (null: none), an ended one dropped. */
export async function getActiveFocus(now = Date.now()): Promise<ActiveFocus | null> {
  if (current === undefined) current = readActive(await readJsonFile<unknown>(activeFile(), null), now)
  if (current && current.until !== undefined && current.until <= now) {
    current = null
    await writeJsonFile(activeFile(), null)
    await clearQuiet(FOCUS_QUIET_SOURCE)
    publish()
  }
  return current
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
  }
}

/** Enter a saved space, or an unsaved scope. Replaces the focus there was. */
export async function enterFocus(input: EnterFocusInput, now = Date.now()): Promise<ActiveFocus> {
  const next = await resolveFocus(input, await getActiveFocus(now), getFocusSpace, now)
  current = next
  await writeJsonFile(activeFile(), current)
  await setQuiet({
    source: FOCUS_QUIET_SOURCE,
    reason: `Focus: ${next.name}`,
    scope: next.scope,
    ...(next.until !== undefined ? { until: next.until } : {}),
  })
  publish()
  return next
}

/** A saved space changed or went: the focus in it follows (its new list, or leaving). */
export async function followSpaceChange(spaceId: string): Promise<void> {
  const now = await getActiveFocus()
  if (!now || now.spaceId !== spaceId) return
  const space = await getFocusSpace(spaceId)
  if (!space) { await leaveFocus(); return }
  await enterFocus({ spaceId, by: now.by, ...(now.until !== undefined ? { until: now.until } : {}) })
}

/** Leave the focus. Returns the one that ended (null: there was none). */
export async function leaveFocus(opts: { onlyBy?: FocusBy } = {}): Promise<ActiveFocus | null> {
  const was = await getActiveFocus()
  if (!was) return null
  // A focus block ending (by 'block': a plugin's timer) leaves only the focus it entered, never one the person chose since.
  if (opts.onlyBy && was.by !== opts.onlyBy) return null
  current = null
  await writeJsonFile(activeFile(), null)
  await clearQuiet(FOCUS_QUIET_SOURCE)
  publish()
  return was
}

/** Tests: forget the in-memory copy (the file stays). */
export function resetActiveFocus(): void {
  current = undefined
}
