/**
 * The route of one Walnut's leader through walnut-net to its own service set's daemon, as a
 * record in the machine's net state dir: `walnut daemon net-route` (net-route.ts) writes it
 * when it flips the leader's member entry in walnut-net's config.json, and the set's daemon
 * (both twins, through net-core.ts `confirmRoutes`) marks it confirmed once that leader's link
 * reaches it. A flip still pending when its time is up is put back by the detached child
 * the flip started.
 *
 *   <net state dir>/routes/<set id16>-<member endpoint id>.json   (0600, written atomically)
 *   { v: 1, walnut, member, previous, daemonPortFile, token, state, at, revertAt, confirmedAt? }
 *
 * `previous` is the member's entry exactly as it was before the first flip; `daemonPortFile`
 * is what the flip wrote, so a put-back changes the entry only while it still routes there.
 * Every read-decide-write of a record or of config.json runs under walnut-net's config lock
 * (`withFileLock(configFile)`, the one net-core.ts takes), so a confirm and the delayed
 * put-back never both win. Async fs only: the daemon calls it from its event loop.
 *
 * Imported by the binary daemon and bundled into net-core.cjs (the source twin's sidecar) and
 * daemon-service-cli.cjs.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { withFileLock } from '../utils/file-lock.js'

export const NET_ROUTE_VERSION = 1
/** Under the net state dir: one record per (set, member). */
export const NET_ROUTES_DIR = 'routes'

export type NetRouteState = 'pending' | 'confirmed'

export interface NetRouteRecord {
  v: typeof NET_ROUTE_VERSION
  /** The service set the member is routed to (16 hex). */
  walnut: string
  /** The member's endpoint id (64 hex, lowercase). */
  member: string
  /** The member's entry in config.json before the first flip, exactly. */
  previous: Record<string, unknown>
  /** The port file the flip wrote into the entry (the set's daemon's). */
  daemonPortFile: string
  /** This flip's own word: the put-back child acts only on the flip that started it. */
  token: string
  state: NetRouteState
  at: number
  revertAt: number
  confirmedAt?: number
}

const SET_RE = /^[0-9a-f]{16}$/
const MEMBER_RE = /^[0-9a-f]{64}$/

export function netConfigFile(netDir: string): string {
  return path.join(netDir, 'config.json')
}

export function netRouteFile(netDir: string, walnut: string, member: string): string {
  if (!SET_RE.test(walnut) || !MEMBER_RE.test(member)) throw new Error('a net route names a set (16 hex) and a member (64 hex)')
  return path.join(netDir, NET_ROUTES_DIR, `${walnut}-${member}.json`)
}

/** Read, change and write walnut-net's config or a route under the machine's one config lock. */
export function withNetConfigLock<T>(netDir: string, fn: () => Promise<T>): Promise<T> {
  const configFile = netConfigFile(netDir)
  return withFileLock(configFile, fn)
}

/** Write whole, then rename into place (0600), as net-core.ts writes the config. */
export async function writeFileAtomicAsync(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  try {
    await fs.writeFile(tmp, data, { mode: 0o600 })
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

function isRecord(v: unknown): v is NetRouteRecord {
  const r = v as NetRouteRecord | null
  return !!r && typeof r === 'object' && r.v === NET_ROUTE_VERSION && typeof r.walnut === 'string' && SET_RE.test(r.walnut)
    && typeof r.member === 'string' && MEMBER_RE.test(r.member) && !!r.previous && typeof r.previous === 'object'
    && typeof r.daemonPortFile === 'string' && typeof r.token === 'string' && (r.state === 'pending' || r.state === 'confirmed')
}

/** The record, or null when there is none (or one this version cannot read). */
export async function readNetRoute(file: string): Promise<NetRouteRecord | null> {
  let text: string
  try { text = await fs.readFile(file, 'utf8') } catch { return null }
  try {
    const v = JSON.parse(text) as unknown
    return isRecord(v) ? v : null
  } catch { return null }
}

export async function writeNetRoute(netDir: string, rec: NetRouteRecord): Promise<string> {
  const dir = path.join(netDir, NET_ROUTES_DIR)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = netRouteFile(netDir, rec.walnut, rec.member)
  await writeFileAtomicAsync(file, JSON.stringify(rec, null, 2) + '\n')
  return file
}

export async function removeNetRoute(file: string): Promise<void> {
  await fs.rm(file, { force: true })
}

/** Mark one route confirmed, under the lock: 'confirmed' (now or already) or 'none' (no record). */
export async function confirmNetRoute(netDir: string, walnut: string, member: string, now = Date.now()): Promise<'confirmed' | 'none'> {
  const file = netRouteFile(netDir, walnut, member)
  return withNetConfigLock(netDir, async () => {
    const rec = await readNetRoute(file)
    if (!rec) return 'none'
    if (rec.state !== 'confirmed') await writeNetRoute(netDir, { ...rec, state: 'confirmed', confirmedAt: now })
    return 'confirmed'
  })
}

/**
 * A leader of Walnut `walnutId` reached the daemon of set `setId`: every pending route of that
 * set is confirmed. Nothing for the default set or another Walnut's leader. The members it
 * confirmed; never throws for a missing dir.
 */
export async function confirmLeaderNetRoutes(netDir: string, setId: string, walnutId: unknown, now = Date.now()): Promise<string[]> {
  if (!SET_RE.test(setId) || typeof walnutId !== 'string' || walnutId.slice(0, 16) !== setId) return []
  let names: string[]
  try { names = await fs.readdir(path.join(netDir, NET_ROUTES_DIR)) } catch { return [] }
  const confirmed: string[] = []
  for (const name of names) {
    const m = /^([0-9a-f]{16})-([0-9a-f]{64})\.json$/.exec(name)
    if (!m || m[1] !== setId) continue
    const rec = await readNetRoute(path.join(netDir, NET_ROUTES_DIR, name))
    if (rec?.state !== 'pending') continue
    if (await confirmNetRoute(netDir, setId, m[2]!, now) === 'confirmed') confirmed.push(m[2]!)
  }
  return confirmed
}
