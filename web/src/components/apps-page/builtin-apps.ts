/**
 * The Apps page's "Built in" section: every built-in entry on the rail, in rail
 * order, with whether the user may take it off the rail.
 *
 * Two kinds, one switch. A registry app (Notes, Tasks, ...) and a fixed rail item
 * (the Home group's panel toggles, Org) both answer "is it on my rail?" from the
 * same app preferences: off means `unpinned`, which takes it off the rail and
 * nothing else (the route, links and the Command Palette keep working). A key the
 * user hid from the rail's right-click menu (`hidden`) reads off too, and switching
 * it on clears both.
 *
 * Three can never go: Home (every link and every fallback lands there), Apps (the
 * one place a hidden app comes back from) and Settings (everything else). Voice and
 * the bell are system controls, not apps, so they are not listed at all.
 */
import type { AppPreferences } from '@/apps/preferences'
import type { RegisteredApp } from '@/apps/registry'
import { railItemKey, type RailItemId } from '@/apps/rail-items'

export interface BuiltinEntry {
  /** App preferences key: `core:<id>` or `rail:<id>`. */
  key: string
  id: string
  title: string
  /** One line under the name. */
  line: string
  /** Tile colour behind the white glyph. */
  tint: string
  /** Set for registry apps (their icon); rail items draw their own glyph. */
  app?: RegisteredApp
  rail?: RailItemId
  /** A Home group toggle rather than a page. */
  homePanel: boolean
  /** Why it can never leave the rail; unset = the user may hide it. */
  lock?: string
  shown: boolean
}

interface Copy { line: string; tint: string; lock?: string }

const CORE_COPY: Readonly<Record<string, Copy>> = {
  home: { line: 'Tasks, sessions and chat side by side', tint: '#007AFF', lock: 'Every link lands here' },
  notes: { line: 'Your notes vault', tint: '#E8A800' },
  calendar: { line: 'Every calendar on this Mac', tint: '#FF3B30' },
  mail: { line: 'Inbox, rules and digests', tint: '#0A84FF' },
  tasks: { line: 'Every project as a full table', tint: '#34C759' },
  routines: { line: 'Scheduled jobs and triggers', tint: '#AF52DE' },
  apps: { line: 'This page', tint: '#FF2D55', lock: 'Brings hidden apps back' },
  settings: { line: 'Engines, hosts, voice and more', tint: '#8E8E93', lock: 'Holds everything else' },
}

const RAIL_COPY: Readonly<Record<RailItemId, Copy & { title: string }>> = {
  'home-todo': { title: 'Task panel', line: 'The task list on Home', tint: '#0A84FF' },
  'home-chat': { title: 'Ask Walnut', line: 'Chat with your Personal AI', tint: '#5E5CE6' },
  org: { title: 'Org', line: 'Main and the project leads', tint: '#30B0C7' },
  'home-agenda': { title: 'Agenda', line: "Today's calendar beside your tasks", tint: '#FF6B5E' },
  'home-scratchpad': { title: 'Scratchpad', line: 'A quick note pad on Home', tint: '#FF9F0A' },
}

/** Rail order: Home, its panel toggles, Org, then the registry apps as the rail draws them. */
const HOME_GROUP: readonly RailItemId[] = ['home-todo', 'home-chat', 'home-agenda', 'home-scratchpad']
const PHONE_ABSENT: ReadonlySet<RailItemId> = new Set(['home-agenda', 'home-scratchpad'])

function offRail(preferences: AppPreferences, key: string): boolean {
  return preferences.unpinned.includes(key) || preferences.hidden.includes(key)
}

/**
 * `coreApps` is every registered core app in rail order (the catalog's `all`, which
 * keeps hidden ones), already gated by plugin (Mail only while the mail plugin is on).
 */
export function builtinEntries(
  coreApps: readonly RegisteredApp[],
  preferences: AppPreferences,
  opts: { phone?: boolean } = {},
): BuiltinEntry[] {
  const out: BuiltinEntry[] = []
  const railEntry = (id: RailItemId): BuiltinEntry => {
    const copy = RAIL_COPY[id]
    const key = railItemKey(id)
    return {
      key, id, title: copy.title, line: copy.line, tint: copy.tint, rail: id,
      homePanel: id !== 'org', shown: !offRail(preferences, key),
    }
  }
  const appEntry = (app: RegisteredApp): BuiltinEntry => {
    const copy = CORE_COPY[app.id] ?? { line: '', tint: '#8E8E93' }
    const lock = app.lockVisibility ? copy.lock ?? 'Always on the rail' : undefined
    return {
      key: app.key, id: app.id, title: app.title, line: copy.line, tint: copy.tint, app,
      homePanel: false, ...(lock ? { lock } : {}),
      shown: lock ? true : !offRail(preferences, app.key),
    }
  }
  const home = coreApps.find((app) => app.id === 'home')
  if (home) out.push(appEntry(home))
  // A phone mounts neither the agenda nor the scratchpad, so the rail never shows them there.
  for (const id of HOME_GROUP) if (!(opts.phone && PHONE_ABSENT.has(id))) out.push(railEntry(id))
  out.push(railEntry('org'))
  for (const app of coreApps) if (app.id !== 'home') out.push(appEntry(app))
  return out
}

/** Case-insensitive match on the name and its line. */
export function builtinMatches(entry: BuiltinEntry, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return entry.title.toLowerCase().includes(q) || entry.line.toLowerCase().includes(q)
}
