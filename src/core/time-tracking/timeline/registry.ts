/**
 * Who can contribute to the day timeline. Core registers its sources at server
 * start (core-sources.ts); a plugin registers through
 * `walnut.registry.timelineSource(...)` and the handle it gets back withdraws it.
 *
 * One id, one source: a second registration of an id is refused, so a plugin can
 * never silently replace what core measures. The one deliberate exception is a
 * core BRIDGE (`replaceableByOwner`): the calendar bridge reads the calendar
 * plugin's op until that plugin registers a source of its own, and steps aside then.
 */

import type { Disposable } from '../../plugins/disposable.js'
import type { TimelineSourceSpec } from './types.js'

export const PLUGIN_PRIORITY_DEFAULT = 40
export const PLUGIN_PRIORITY_MAX = 80

export interface RegisteredSource {
  spec: TimelineSourceSpec
  owner: string
  priority: number
  /** A core bridge that any source registered by this owner (a plugin id) replaces. */
  replaceableByOwner?: string
}

const sources = new Map<string, RegisteredSource>()

function clampPriority(owner: string, raw: number | undefined): number {
  if (owner === 'core') return typeof raw === 'number' && Number.isFinite(raw) ? raw : PLUGIN_PRIORITY_DEFAULT
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return PLUGIN_PRIORITY_DEFAULT
  return Math.max(1, Math.min(PLUGIN_PRIORITY_MAX, raw))
}

function validate(spec: TimelineSourceSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('timeline source: a spec object is required')
  if (typeof spec.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/.test(spec.id)) {
    throw new Error(`timeline source: id "${String(spec.id)}" must be letters, digits, _ : . -`)
  }
  if (typeof spec.label !== 'string' || !spec.label.trim()) throw new Error(`timeline source "${spec.id}": label is required`)
  if (spec.lane !== 'activity' && spec.lane !== 'place') throw new Error(`timeline source "${spec.id}": lane must be activity or place`)
  if (typeof spec.segments !== 'function') throw new Error(`timeline source "${spec.id}": segments(range) is required`)
}

/**
 * Register a source. `replaceableByOwner` (core only): a plugin id whose own
 * source, once registered, takes this one's place.
 */
export function registerTimelineSource(
  owner: string,
  spec: TimelineSourceSpec,
  opts: { replaceableByOwner?: string } = {},
): Disposable {
  validate(spec)
  const existing = sources.get(spec.id)
  if (existing && existing.owner === owner && owner === 'core') {
    // Core re-registers on every server start in one process (tests): replace in place.
    sources.delete(spec.id)
  } else if (existing) {
    throw new Error(`timeline source "${spec.id}" is already registered by ${existing.owner}`)
  }
  const entry: RegisteredSource = {
    spec, owner, priority: clampPriority(owner, spec.priority),
    ...(opts.replaceableByOwner && owner === 'core' ? { replaceableByOwner: opts.replaceableByOwner } : {}),
  }
  sources.set(spec.id, entry)
  return {
    dispose() {
      if (sources.get(spec.id) === entry) sources.delete(spec.id)
    },
  }
}

/** The sources a timeline reads now: a bridge whose replacement is registered is left out. */
export function listTimelineSources(): RegisteredSource[] {
  const all = [...sources.values()]
  const owners = new Set(all.map((s) => s.owner))
  return all.filter((s) => !s.replaceableByOwner || !owners.has(s.replaceableByOwner))
}

/** Drop every source of one owner (plugin teardown) or all (tests). */
export function clearTimelineSources(owner?: string): void {
  for (const [id, s] of sources) if (owner === undefined || s.owner === owner) sources.delete(id)
}
