/**
 * The writes of `hosts.<alias>.not_offered` (rules in found-host-offer.ts):
 *
 *   markFoundTwinsDoc  every found host still waiting for the yes that joined-twins.ts says is a
 *                      joined machine now is remembered as that machine. Run at start (the found
 *                      hosts' settle, found-hosts-store.ts) and each time a joined machine reports
 *                      where it is (net-seen.ts, through markFoundTwins).
 *   markNotLinux       a found host whose SSH probe named another system: marked and off, so it is
 *                      never dialled or offered again (found-host-alert.ts, on its first answer).
 *   clearNotLinux      a found host carrying that mark connected (the alias names another machine
 *                      now): the mark no longer holds.
 *
 * A found host Walnut kept only in memory (merged from ~/.ssh/config, never answered) is written
 * whole, as answerFoundHost writes one, so the mark has a row to live on.
 */

import { log } from '../../logging/index.js'
import type { Config } from '../types.js'
import type { DiscoveredHost } from '../ssh-config-scanner.js'
import { askingAboutFoundHosts, foundHostWaits, mergeFoundHosts, type FoundHostRow } from './found-hosts.js'
import { notOfferedOf, withNotLinuxMark, withoutNotLinuxMark, withSameMachineMark } from './found-host-offer.js'
import { joinedTwins } from './joined-twins.js'

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

/**
 * Mark, in `doc`, every found host waiting for the yes that is a joined machine now. The rows
 * read as getConfig reads them (the stored ones and those merged from `scanned`), so a found
 * host never answered is matched too. Returns the aliases it marked.
 */
export function markFoundTwinsDoc(
  doc: Doc,
  ctx: { scanned: ReadonlyMap<string, DiscoveredHost>; reserved?: ReadonlySet<string>; now: Date },
): string[] {
  const stored = rowsOf(doc)
  const view = { hosts: { ...stored } } as unknown as Config
  mergeFoundHosts(view, ctx.scanned, { reserved: ctx.reserved, asking: askingAboutFoundHosts(doc as Pick<Config, 'hosts_found'>) })
  const merged = (view.hosts ?? {}) as unknown as Rows
  const rows: Rows = { ...stored }
  const marked: string[] = []
  for (const { alias, joined } of joinedTwins(merged, doc.net)) {
    const row = merged[alias]
    if (!row || !foundHostWaits(row) || notOfferedOf(row)) continue
    const base = Object.hasOwn(stored, alias) && stored[alias] && typeof stored[alias] === 'object' ? stored[alias] : wholeRow({ ...row, enabled: false })
    rows[alias] = withSameMachineMark(base, joined, ctx.now)
    marked.push(alias)
  }
  if (marked.length > 0) doc.hosts = rows
  return marked
}

export interface FoundHostMarkDeps {
  scan: () => Promise<ReadonlyMap<string, DiscoveredHost>>
  /** Read-modify-write the stored config mapping; `mutate` returns whether it changed it. */
  modify: (mutate: (doc: Doc) => boolean) => Promise<boolean>
  /** The host rows as getConfig reads them (a found host kept only in memory included). */
  readHosts: () => Promise<Rows>
  reserved?: ReadonlySet<string>
  now?: () => Date
  /** Tell every surface the hosts changed (config:changed), so the row leaves them live. */
  announce?: () => Promise<void>
}

async function defaultDeps(): Promise<FoundHostMarkDeps> {
  const [{ getConfig, migrateStoredConfig }, { scanSshConfig }, { realSshReachAllowed }, { COMPANION_ALIAS }, { bus, EventNames }] = await Promise.all([
    import('../config-manager.js'), import('../ssh-config-scanner.js'), import('../../lib/real-ssh-guard.js'), import('../replication/companion-keep.js'),
    import('../event-bus.js'),
  ])
  return {
    scan: async () => (realSshReachAllowed() ? scanSshConfig() : new Map()),
    modify: (mutate) => migrateStoredConfig(mutate),
    readHosts: async () => ((await getConfig()).hosts ?? {}) as unknown as Rows,
    reserved: new Set([COMPANION_ALIAS]),
    // A key-only notice (config-broadcast.ts): the host defs refresh, so a host now off leaves
    // every surface live, and Home and Settings read the hosts again.
    announce: async () => { bus.emit(EventNames.CONFIG_CHANGED, { key: 'hosts' }, ['web-ui'], { source: 'found-host-marks' }) },
  }
}

async function depsOf(over?: Partial<FoundHostMarkDeps>): Promise<FoundHostMarkDeps> {
  return over && over.scan && over.modify && over.readHosts ? over as FoundHostMarkDeps : { ...(await defaultDeps()), ...over }
}

/** markFoundTwinsDoc, written. Only the server that keeps config.yaml marks. */
export async function markFoundTwins(over?: Partial<FoundHostMarkDeps>): Promise<string[]> {
  if (!over && (await import('../server-role.js')).isFollower()) return []
  const deps = await depsOf(over)
  const scanned = await deps.scan().catch(() => new Map<string, DiscoveredHost>())
  let marked: string[] = []
  await deps.modify((doc) => {
    marked = markFoundTwinsDoc(doc, { scanned, reserved: deps.reserved, now: (deps.now ?? (() => new Date()))() })
    return marked.length > 0
  })
  if (marked.length > 0) {
    log.session.info('found hosts: remembered as machines already joined', { hosts: marked })
    await deps.announce?.()
  }
  return marked
}

/**
 * Mark a found host not Linux, and off. Returns true when the stored row changed (the first
 * answer, or a row the person had turned back on), false when it already read so.
 */
export async function markNotLinux(alias: string, os: string | undefined, over?: Partial<FoundHostMarkDeps>): Promise<boolean> {
  const deps = await depsOf(over)
  const hosts = await deps.readHosts()
  const def = Object.hasOwn(hosts, alias) ? hosts[alias] : undefined
  if (!def || def.discovered !== true) return false
  const now = (deps.now ?? (() => new Date()))()
  const changed = await deps.modify((doc) => {
    const rows: Rows = { ...rowsOf(doc) }
    const stored = Object.hasOwn(rows, alias) && rows[alias] && typeof rows[alias] === 'object' ? rows[alias] : undefined
    const base = stored ?? wholeRow(def)
    if (notOfferedOf(base)?.reason === 'not_linux' && base.enabled === false) return false
    rows[alias] = withNotLinuxMark(base, os, now)
    doc.hosts = rows
    return true
  })
  if (changed) await deps.announce?.()
  return changed
}

/** A found host marked not Linux connected: drop the mark. Returns whether it was there. */
export async function clearNotLinux(alias: string, over?: Partial<FoundHostMarkDeps>): Promise<boolean> {
  const deps = await depsOf(over)
  const changed = await deps.modify((doc) => {
    const rows: Rows = { ...rowsOf(doc) }
    const stored = Object.hasOwn(rows, alias) ? rows[alias] : undefined
    if (!stored || typeof stored !== 'object') return false
    const next = withoutNotLinuxMark(stored)
    if (next === stored) return false
    rows[alias] = next
    doc.hosts = rows
    return true
  })
  if (changed) await deps.announce?.()
  return changed
}
