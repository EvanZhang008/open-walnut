/**
 * The writes of `hosts.<alias>.not_offered` (rules in found-host-offer.ts):
 *
 *   markNotLinux    a found host whose SSH probe named another system: marked on the target it
 *                   was dialled at, and off, so it is never dialled or offered again while the
 *                   alias names that target (found-host-alert.ts, on its first answer).
 *   clearNotLinux   a found host carrying that mark connected: the mark no longer holds.
 *
 * Only the server that keeps config.yaml writes them (a replica's config is the Mac's copy). A
 * found host Walnut kept only in memory (merged from ~/.ssh/config, never answered) is written
 * whole, as answerFoundHost writes one, so the mark has a row to live on.
 */

import type { FoundHostRow } from './found-hosts.js'
import { notOfferedOf, sameTarget, targetOf, withNotLinuxMark, withoutNotLinuxMark } from './found-host-offer.js'

type Doc = Record<string, unknown>
type Rows = Record<string, FoundHostRow>

function rowsOf(doc: Doc): Rows {
  const hosts = doc.hosts
  return hosts && typeof hosts === 'object' && !Array.isArray(hosts) ? hosts as Rows : {}
}

/** The fields a found host kept only in memory is written with. */
function wholeRow(def: FoundHostRow): FoundHostRow {
  return {
    hostname: def.hostname,
    ...(def.user ? { user: def.user } : {}),
    ...(def.port ? { port: def.port } : {}),
    ...(def.label ? { label: def.label } : {}),
    discovered: true,
    ...(def.connect !== undefined ? { connect: def.connect } : {}),
    ...(def.enabled !== undefined ? { enabled: def.enabled } : {}),
    ...(def.scanned !== undefined ? { scanned: def.scanned } : {}),
  }
}

export interface FoundHostMarkDeps {
  /** Read-modify-write the stored config mapping; `mutate` returns whether it changed it. */
  modify: (mutate: (doc: Doc) => boolean) => Promise<boolean>
  /** The host rows as getConfig reads them (a found host kept only in memory included). */
  readHosts: () => Promise<Rows>
  now?: () => Date
  /** Tell every surface the hosts changed (config:changed), so the row leaves them live. */
  announce?: () => Promise<void>
}

/** The real deps, or null on a follower (a replica writes no host of the Mac's). */
async function defaultDeps(): Promise<FoundHostMarkDeps | null> {
  if ((await import('../server-role.js')).isFollower()) return null
  const [{ getConfig, migrateStoredConfig }, { bus, EventNames }] = await Promise.all([
    import('../config-manager.js'), import('../event-bus.js'),
  ])
  return {
    modify: (mutate) => migrateStoredConfig(mutate),
    readHosts: async () => ((await getConfig()).hosts ?? {}) as unknown as Rows,
    // A key-only notice (config-broadcast.ts): the host defs refresh, so a host now off leaves
    // every surface live, and Home and Settings read the hosts again.
    announce: async () => { bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts' }, ['web-ui'], { source: 'found-host-marks' }) },
  }
}

/**
 * Mark a found host not Linux, and off. Returns true when the stored row changed (the first
 * answer, or a row the person had turned back on), false when it already read so, on a host
 * added by hand, or on a follower.
 */
export async function markNotLinux(alias: string, os: string | undefined, deps?: FoundHostMarkDeps): Promise<boolean> {
  const d = deps ?? await defaultDeps()
  if (!d) return false
  const hosts = await d.readHosts()
  const def = Object.hasOwn(hosts, alias) ? hosts[alias] : undefined
  if (!def || def.discovered !== true) return false
  const now = (d.now ?? (() => new Date()))()
  // The target it was dialled at: the row as the read named it (it follows ~/.ssh/config).
  const dialled = targetOf(def)
  const changed = await d.modify((doc) => {
    const rows: Rows = { ...rowsOf(doc) }
    const stored = Object.hasOwn(rows, alias) && rows[alias] && typeof rows[alias] === 'object' ? rows[alias] : undefined
    const base = stored ?? wholeRow(def)
    const kept = notOfferedOf(base)
    if (kept && base.enabled === false && kept.target && sameTarget(kept.target, dialled)) return false
    rows[alias] = withNotLinuxMark(base, os, now, dialled)
    doc.hosts = rows
    return true
  })
  if (changed) await d.announce?.()
  return changed
}

/** A found host marked not Linux connected: drop the mark. Returns whether it was there. */
export async function clearNotLinux(alias: string, deps?: FoundHostMarkDeps): Promise<boolean> {
  const d = deps ?? await defaultDeps()
  if (!d) return false
  const changed = await d.modify((doc) => {
    const rows: Rows = { ...rowsOf(doc) }
    const stored = Object.hasOwn(rows, alias) ? rows[alias] : undefined
    if (!stored || typeof stored !== 'object') return false
    const next = withoutNotLinuxMark(stored)
    if (next === stored) return false
    rows[alias] = next
    doc.hosts = rows
    return true
  })
  if (changed) await d.announce?.()
  return changed
}
