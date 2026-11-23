/**
 * walnut-net's config as the daemon writes it (net-core.ts): the checks a configure
 * request passes, matching what walnut-net itself reads (native/walnut-net/src/config.rs),
 * where this host's net state lives, and which walnut-net executable runs.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { netInstallName } from './net-binary.js'

export const NET_CONFIG_VERSION = 1
export const ID_RE = /^[0-9a-f]{64}$/
const NAME_MAX = 80
const MEMBERS_MAX = 256

export interface NetMember {
  id: string
  name: string
  accept: boolean
  addrs?: string[]
  /** Relays it was last seen on: it is reached there until it moves to this host's choice. */
  relays?: string[]
  /** In the file only: the service set that wrote it (absent: the default set, as every older file). */
  walnut?: string
  /** In the file only: the port file of that set's daemon, where its streams go (absent: the top-level one). */
  daemonPortFile?: string
}

export interface NetConfigureRequest {
  enabled?: unknown
  /** `custom` (the relays listed: the user's own), `public` (iroh's public relays and lookup), `none`. */
  relayMode?: unknown
  relays?: unknown
  relayRoots?: unknown
  members?: unknown
}

export type NetRelayMode = 'custom' | 'public' | 'none'

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null
}

/** `1.2.3.4:5` or `[::1]:5`, as Rust's SocketAddr reads it. */
export function socketAddr(a: unknown): boolean {
  if (typeof a !== 'string' || a.length > 64) return false
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(a)
  if (!m) return false
  const port = Number(m[3])
  if (port < 1 || port > 65535) return false
  return m[1] ? net.isIPv6(m[1]) : net.isIPv4(m[2])
}

/** Validate a configure request into walnut-net's config fields. Throws on anything off. */
export function parseNetConfig(req: NetConfigureRequest): { relayMode?: 'public' | 'none'; relays: string[]; relayRoots: string[]; members: NetMember[] } {
  // The same rules walnut-net applies when it reads the file (config.rs): a config it would
  // refuse is refused here, before it replaces one that works.
  const httpOk = process.env.WALNUT_NET_ALLOW_HTTP_RELAY === '1'
  const mode = req.relayMode === undefined || req.relayMode === null ? null : req.relayMode
  if (mode !== null && mode !== 'custom' && mode !== 'public' && mode !== 'none') throw new Error(`relayMode ${String(mode).slice(0, 20)} is not custom, public or none`)
  const relays = Array.isArray(req.relays) ? req.relays : []
  if ((mode === 'public' || mode === 'none') && (relays.length || (Array.isArray(req.relayRoots) && req.relayRoots.length))) {
    throw new Error(`relayMode ${mode} takes no relays or relayRoots`)
  }
  const checkRelay = (r: unknown): void => {
    if (typeof r !== 'string' || !/^https?:\/\/[^\s]+$/.test(r) || r.length > 512) throw new Error(`bad relay URL ${String(r).slice(0, 80)}`)
    if (!r.startsWith('https://') && !httpOk) throw new Error(`relay ${r.slice(0, 80)} is not https`)
  }
  for (const r of relays) checkRelay(r)
  const roots = Array.isArray(req.relayRoots) ? req.relayRoots : []
  for (const c of roots) {
    if (typeof c !== 'string' || !c.includes('-----BEGIN CERTIFICATE-----') || c.length > 16_384) throw new Error('relayRoots: PEM certificates only')
  }
  const raw = Array.isArray(req.members) ? req.members : []
  if (raw.length > MEMBERS_MAX) throw new Error(`at most ${MEMBERS_MAX} members`)
  const seen = new Set<string>()
  const members: NetMember[] = raw.map((m) => {
    const o = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.toLowerCase() : ''
    if (!ID_RE.test(id)) throw new Error(`bad member id ${String(o.id).slice(0, 80)}`)
    if (seen.has(id)) throw new Error(`member ${id} listed twice`)
    seen.add(id)
    const addrs = Array.isArray(o.addrs) ? o.addrs.slice(0, 16) : []
    for (const a of addrs) if (!socketAddr(a)) throw new Error(`member ${id}: bad address ${String(a).slice(0, 64)}`)
    const seenOn = Array.isArray(o.relays) ? o.relays.slice(0, 4) : []
    for (const r of seenOn) checkRelay(r)
    return { id, name: str(o.name, NAME_MAX) ?? '', accept: o.accept === true, ...(addrs.length ? { addrs } : {}), ...(seenOn.length ? { relays: seenOn as string[] } : {}) }
  })
  // `custom` is written as no field at all: the config of the user's own relay reads the same
  // as it did before relay modes, so walnut-net is not restarted for it.
  return { ...(mode === 'public' || mode === 'none' ? { relayMode: mode } : {}), relays: relays as string[], relayRoots: roots as string[], members }
}

/**
 * This host's net state dir. ONE per account for the account's own daemon, whichever
 * way it runs (the login service, or the daemon a server or an SSH connect started):
 * the key is the machine's identity on the network, and a second key would cut the
 * machine off from every member that knows the first. A daemon in any other dir (a
 * test's, the companion's tunnel daemon) keeps its own beside it.
 */
export function netStateDir(opts: { serviceStateDir?: string | null; prodDaemon: boolean; daemonDir: string; home?: string }): string {
  return netStateDirOf({ ...opts, home: opts.home ?? os.homedir(), join: path.join })
}

/**
 * netStateDir's rule with its path join handed in: the source daemon twin inlines this
 * one (`__NET_STATE_DIR_OF__`), so its body references nothing at module scope.
 */
export function netStateDirOf(opts: { serviceStateDir?: string | null; prodDaemon: boolean; daemonDir: string; home: string; join: (...parts: string[]) => string }): string {
  // Never XDG_STATE_HOME: a daemon a shell started may have it and the login service not,
  // and two paths would be two keys for one machine.
  if (opts.serviceStateDir || opts.prodDaemon) return opts.join(opts.home, '.local', 'state', 'open-walnut', 'net')
  return opts.join(opts.daemonDir, 'net')
}

/** The walnut-net executable for this install: $WALNUT_NET_BIN, else beside the daemon, else none. */
export function resolveNetBinary(opts: { env?: NodeJS.ProcessEnv; dirs: string[] }): string | null {
  const env = opts.env ?? process.env
  const runs = (f: string) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile() } catch { return false } }
  if (env.WALNUT_NET_BIN) return path.isAbsolute(env.WALNUT_NET_BIN) && runs(env.WALNUT_NET_BIN) ? env.WALNUT_NET_BIN : null
  const name = `walnut-net-${process.platform}-${process.arch}`
  for (const d of opts.dirs) {
    for (const f of [path.join(d, 'walnut-net'), path.join(d, name), path.join(d, netInstallName())]) if (runs(f)) return f
  }
  return null
}

/** The downloaded versions in `dir` (`walnut-net-<x.y.z>`), newest first. */
function downloadedVersions(dir: string): Array<{ file: string; v: number[] }> {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return [] }
  const out: Array<{ file: string; v: number[] }> = []
  for (const n of names) {
    const m = /^walnut-net-(\d+)\.(\d+)\.(\d+)$/.exec(n)
    if (m) out.push({ file: path.join(dir, n), v: [Number(m[1]), Number(m[2]), Number(m[3])] })
  }
  return out.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2])
}

/**
 * An older download in `dir`, run while this version downloads: a joined machine whose
 * daemon moved to a new walnut-net version stays on the network meanwhile.
 */
export function previousNetBinary(dir: string): string | null {
  const current = path.join(dir, netInstallName())
  for (const { file } of downloadedVersions(dir)) {
    if (file === current) continue
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file } catch { /* not runnable */ }
  }
  return null
}

/** Once this version runs: keep it and the newest older one (what a downgrade runs), remove the rest. */
export function pruneNetBinaries(dir: string): void {
  const current = path.join(dir, netInstallName())
  const older = downloadedVersions(dir).filter((d) => d.file !== current)
  for (const { file } of older.slice(1)) { try { fs.rmSync(file, { force: true }) } catch { /* best effort */ } }
}

// ── Two Walnut services on one machine (service sets, src/providers/service-set.ts) ──
// One walnut-net, one key, one config per machine; each service writes only its own set's
// members. A member's `walnut` names its set ('' or absent: the default set, so every file an
// older Walnut wrote is the default set's), and a non-default set's members carry its daemon's
// port file, which walnut-net routes their streams to. The rest of the file (relays, the
// top-level port file) is the default set's; a set writes it only when no file exists yet.

const SET_ID_RE = /^[0-9a-f]{16}$/

/** A service set id as the daemon is given it: '' (the default set) or 16 hex; null when it is neither. */
export function netSetId(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return ''
  return typeof v === 'string' && SET_ID_RE.test(v) ? v : null
}

type FileMember = Record<string, unknown>

/** The set a member of the file belongs to. */
function setOf(m: unknown): string {
  const w = m && typeof m === 'object' ? (m as FileMember).walnut : undefined
  return typeof w === 'string' ? w : ''
}

function configObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

function fileMembers(file: Record<string, unknown> | null): FileMember[] {
  return file && Array.isArray(file.members) ? file.members.filter((m): m is FileMember => !!m && typeof m === 'object') : []
}

function configText(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2) + '\n'
}

/**
 * One machine listed by two sets: one entry stays, so walnut-net's member check and route are
 * not left to the order of the file. The one that lets it in wins; of two alike, the other
 * set's (already in the file), so two writers never take it from each other in turn.
 */
function mergeMembers(own: NetMember[], others: FileMember[], ownFirst: boolean): unknown[] {
  const mine = new Map(own.map((m) => [m.id, m]))
  const dropOwn = new Set<string>()
  const kept = others.filter((o) => {
    const id = typeof o.id === 'string' ? o.id.toLowerCase() : ''
    const m = mine.get(id)
    if (!m) return true
    if (m.accept && o.accept !== true) return false
    dropOwn.add(id)
    return true
  })
  const ownKept = own.filter((m) => !dropOwn.has(m.id))
  return ownFirst ? [...ownKept, ...kept] : [...kept, ...ownKept]
}

export interface NetConfigWrite {
  /** The file as it is now (null: none). */
  current: string | null
  /** The writing service's set ('' default). */
  setId: string
  /** This host's endpoint id: never one of its own members. */
  self: string
  keyFile: string
  control: string
  /** The writing daemon's port file. */
  portFile: string
  request: ReturnType<typeof parseNetConfig>
}

/**
 * The config text after one service's configure: its set's members replaced by the request's,
 * every other set's kept as the file has them. For the default set with no other set in the
 * file this is exactly the text Walnut wrote before sets.
 */
export function netConfigText(w: NetConfigWrite): string {
  const file = configObject(w.current)
  const others = fileMembers(file).filter((m) => setOf(m) !== w.setId)
  const own = w.request.members
    .filter((m) => m.id !== w.self)
    .map((m) => (w.setId ? { ...m, walnut: w.setId, daemonPortFile: w.portFile } : m))
  const members = mergeMembers(own, others, w.setId === '')
  if (w.setId === '' || !file) {
    return configText({ version: NET_CONFIG_VERSION, key: w.keyFile, ...w.request, members, daemonPortFile: w.portFile, control: w.control })
  }
  // A set leaves the endpoint (key, relays) and the top-level port file to the default set.
  return configText({
    ...file, version: NET_CONFIG_VERSION, key: w.keyFile, members, control: w.control,
    ...(typeof file.daemonPortFile === 'string' ? {} : { daemonPortFile: w.portFile }),
  })
}

/** The config without one set's members (null: no readable file), and how many members remain. */
export function netConfigWithout(current: string | null, setId: string): { text: string; remaining: number } | null {
  const file = configObject(current)
  if (!file) return null
  const members = fileMembers(file).filter((m) => setOf(m) !== setId)
  return { text: configText({ ...file, members }), remaining: members.length }
}

/** The configure request that puts one set's part of a config back (null: no readable file). */
export function netRequestOf(current: string | null, setId: string): NetConfigureRequest | null {
  const file = configObject(current)
  if (!file) return null
  return { relayMode: file.relayMode, relays: file.relays, relayRoots: file.relayRoots, members: fileMembers(file).filter((m) => setOf(m) === setId) }
}
