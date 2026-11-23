/**
 * `walnut daemon net-route`: point one leader's walnut-net link on this machine at its own
 * service set's daemon, with a safety net (two Walnuts on one machine, the move's step c and d).
 *
 *   walnut daemon net-route --walnut <walnutId> --member <endpointId> [--revert-after <s>]   flip
 *   walnut daemon net-route --walnut <walnutId> --member <endpointId> --confirm              keep it
 *   walnut daemon net-route --walnut <walnutId> --member <endpointId> --revert               put it back
 *
 * walnut-net sends each stream of a member to the daemon whose port file the member's entry
 * names (`daemonPortFile`, else the top-level one: the shared default daemon). A flip, under
 * walnut-net's config lock, records the entry as it is (net-route-record.ts), writes
 * `walnut: <set>` and `daemonPortFile: <set runtime dir>/daemon.port` into it, asks the running
 * walnut-net to reload (with a deadline; a missing or silent one is reported, the write stays),
 * and starts a DETACHED child of this same command:
 *
 *   walnut daemon net-route --walnut <id> --member <id> --revert --if-pending <token> --revert-after <s>
 *
 * (`--if-pending <token>` is internal: only the put-back child of a flip passes it.) It waits
 * `--revert-after` seconds (default 120, 10..3600), then puts the entry back only if that same
 * flip is still pending: the set's daemon confirms the route when the leader's link reaches it
 * (net-core.ts confirmRoutes), and the leader confirms it itself with `--confirm`. The child runs
 * in its own session with no pipes, so neither this CLI's exit nor the shared daemon's (its
 * unit has KillMode=process, its plist AbandonProcessGroup) takes it along.
 *
 * A put-back changes the entry only while it still routes where the flip pointed it; another
 * writer's change since is left as it is, and the answer says so. Every answer is one JSON line
 * on stdout after the `service set: <id>` line: { ok, action, state, reload, ... }; exit 0 on ok.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { serviceSetLine, type ServicePlatform, type ServiceSet } from './service-set.js'
import { chooseServiceSet } from './service-set-choice.js'
import { localProductionDaemonDir } from '../lib/daemon-dir.js'
import { netControlCall, netControlPath, netStateDir } from './net-core.js'
import {
  NET_ROUTES_DIR, NET_ROUTE_VERSION, netConfigFile, netRouteFile, readNetRoute, removeNetRoute,
  confirmNetRoute, withNetConfigLock, writeFileAtomicAsync, writeNetRoute,
} from './net-route-record.js'

export const NET_ROUTE_ACTION = 'net-route'
export const NET_ROUTE_REVERT_DEFAULT_S = 120
export const NET_ROUTE_REVERT_MIN_S = 10
export const NET_ROUTE_REVERT_MAX_S = 3600
/** How long a reload of walnut-net may take before the answer says it failed. */
const RELOAD_TIMEOUT_MS = 5_000
/** The put-back child's own log in the routes dir (its stdio goes nowhere). */
const PUT_BACK_LOG = 'put-back.log'
const PUT_BACK_LOG_MAX = 64 * 1024

export type NetRouteAction = 'flip' | 'confirm' | 'revert'

export interface NetRouteRequest {
  action: NetRouteAction
  walnut: string
  member: string
  revertAfterS: number
  /** Set only for the put-back child of a flip: act only while that flip is still pending. */
  ifPending?: string
}

export interface NetRouteAnswer {
  ok: boolean
  action: NetRouteAction
  /** pending, confirmed, reverted, none (no record), left (another writer changed it), not_pending (child: confirmed or reflipped). */
  state?: string
  /** 'none' also when this action asked no reload. */
  reload: 'ok' | 'none' | 'failed'
  reloadError?: string
  walnut?: string
  member?: string
  record?: string
  revertAt?: number
  revertChild?: number
  entry?: unknown
  code?: string
  error?: string
}

export interface NetRouteDeps {
  home?: string
  platform?: ServicePlatform
  uid?: number
  /** The default set's runtime dir, for the set choice (lib/daemon-dir.ts localProductionDaemonDir). */
  defaultRuntimeDir?: string
  /** The machine's net state dir (default: the one every service uses under `home`). */
  netDir?: string
  now?: () => number
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => { pid?: number; unref(): void; on(ev: 'error', fn: (e: Error) => void): unknown }
  /** The words that run `walnut` again here (default: this process's own, from process.argv). */
  commandPrefix?: string[] | null
  env?: NodeJS.ProcessEnv
  reloadTimeoutMs?: number
  /** The put-back child's wait (default: the request's seconds). Tests only. */
  waitMs?: number
  out?: (text: string) => void
}

/** Parse the words after `net-route`. Throws on anything off. */
export function parseNetRouteArgs(args: string[]): NetRouteRequest {
  let walnut = '', member = '', confirm = false, revert = false, ifPending: string | undefined, after: number | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const val = (): string => {
      const v = args[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`)
      return v
    }
    if (a === '--walnut') walnut = val()
    else if (a === '--member') member = val()
    else if (a === '--confirm') confirm = true
    else if (a === '--revert') revert = true
    else if (a === '--if-pending') ifPending = val()
    else if (a === '--revert-after') {
      const s = Number(val())
      if (!Number.isInteger(s) || s < NET_ROUTE_REVERT_MIN_S || s > NET_ROUTE_REVERT_MAX_S) {
        throw new Error(`--revert-after takes whole seconds from ${NET_ROUTE_REVERT_MIN_S} to ${NET_ROUTE_REVERT_MAX_S}`)
      }
      after = s
    } else throw new Error(`Unknown net-route option: ${a}`)
  }
  if (!walnut) throw new Error('net-route requires --walnut <walnutId>')
  if (!/^[0-9a-fA-F]{64}$/.test(member)) throw new Error('net-route requires --member <endpointId> (64 hex digits)')
  if (confirm && revert) throw new Error('net-route takes --confirm or --revert, not both')
  if (ifPending !== undefined && (!revert || !/^[0-9a-f]{16}$/.test(ifPending))) throw new Error('--if-pending is the put-back child\'s word: --revert --if-pending <token>')
  return { action: confirm ? 'confirm' : revert ? 'revert' : 'flip', walnut, member: member.toLowerCase(), revertAfterS: after ?? NET_ROUTE_REVERT_DEFAULT_S, ...(ifPending ? { ifPending } : {}) }
}

/**
 * How this process was started as `walnut`, up to the `daemon net-route` words: the compiled file
 * (its bunfs entry dropped: the runtime puts it back), node with the source twin or the npm CLI,
 * each with its own `walnut` keyword when it has one. null when argv holds no such words.
 */
export function walnutCommandPrefix(argv: string[] = process.argv, execPath: string = process.execPath): string[] | null {
  for (let i = 1; i < argv.length - 1; i++) {
    if (argv[i] !== 'daemon' || argv[i + 1] !== NET_ROUTE_ACTION) continue
    return [execPath, ...argv.slice(1, i).filter((a) => !a.includes('$bunfs') && !a.includes('~BUN'))]
  }
  return null
}

export async function runNetRouteArgs(args: string[], deps: NetRouteDeps = {}): Promise<number> {
  const out = deps.out ?? ((t: string) => { process.stdout.write(t) })
  let req: NetRouteRequest
  try { req = parseNetRouteArgs(args) } catch (err) {
    out(JSON.stringify({ ok: false, action: 'flip', reload: 'none', code: 'bad_args', error: (err as Error).message }) + '\n')
    return 1
  }
  const answer = await netRoute(req, deps, out).catch((err: Error): NetRouteAnswer => ({ ok: false, action: req.action, reload: 'none', code: 'error', error: err.message }))
  out(JSON.stringify(answer) + '\n')
  return answer.ok ? 0 : 1
}

/** The action, after the `service set:` line (written through `out`). */
export async function netRoute(req: NetRouteRequest, deps: NetRouteDeps = {}, out: (t: string) => void = () => {}): Promise<NetRouteAnswer> {
  const home = deps.home ?? os.homedir()
  const platform = deps.platform ?? (process.platform as ServicePlatform)
  const uid = deps.uid ?? process.getuid?.() ?? 0
  const defaultRuntimeDir = deps.defaultRuntimeDir ?? localProductionDaemonDir()
  let set: ServiceSet
  try {
    set = (await chooseServiceSet({ platform, home, walnutId: req.walnut, defaultRuntimeDir, uid, claim: false })).set
  } catch (err) {
    return { ok: false, action: req.action, reload: 'none', code: 'bad_args', error: (err as Error).message }
  }
  out(`${serviceSetLine(set.id)}\n`)
  const base = { action: req.action, walnut: set.id, member: req.member }
  if (set.id === '') return { ok: false, ...base, reload: 'none', code: 'default_set', error: 'this Walnut holds the default set here: its leader already reaches the default daemon' }
  const netDir = deps.netDir ?? netStateDir({ serviceStateDir: set.installRoot, prodDaemon: true, daemonDir: set.runtimeDir, home })
  const ctx: Ctx = { req, set, netDir, now: deps.now ?? Date.now, deps, record: netRouteFile(netDir, set.id, req.member) }
  if (req.action === 'confirm') {
    const state = await confirmNetRoute(netDir, set.id, req.member, ctx.now())
    return { ok: true, ...base, state, reload: 'none', record: ctx.record }
  }
  if (req.action === 'revert') {
    if (req.ifPending !== undefined) await delay(deps.waitMs ?? req.revertAfterS * 1000)
    const answer = await revert(ctx)
    if (req.ifPending !== undefined) await logPutBack(netDir, answer)
    return answer
  }
  return flip(ctx)
}

interface Ctx {
  req: NetRouteRequest
  set: ServiceSet
  netDir: string
  now: () => number
  deps: NetRouteDeps
  record: string
}

type Entry = Record<string, unknown>

async function readConfig(netDir: string): Promise<{ text: string; cfg: Entry; members: unknown[] } | null> {
  let text: string
  try { text = await fs.readFile(netConfigFile(netDir), 'utf8') } catch { return null }
  try {
    const cfg = JSON.parse(text) as unknown
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null
    const members = Array.isArray((cfg as Entry).members) ? [...((cfg as Entry).members as unknown[])] : []
    return { text, cfg: cfg as Entry, members }
  } catch { return null }
}

function memberAt(members: unknown[], id: string): number {
  return members.findIndex((m) => !!m && typeof m === 'object' && typeof (m as Entry).id === 'string' && ((m as Entry).id as string).toLowerCase() === id)
}

/** The config as net-core.ts writes it (net-config-core.ts configText). */
async function writeConfig(netDir: string, cfg: Entry, members: unknown[]): Promise<void> {
  await writeFileAtomicAsync(netConfigFile(netDir), JSON.stringify({ ...cfg, members }, null, 2) + '\n')
}

function portFileOf(set: ServiceSet): string {
  // The set's daemon writes its port here (the twins' PORT_FILE: WALNUT_DAEMON_DIR/daemon.port).
  return path.join(set.runtimeDir, 'daemon.port')
}

async function flip(ctx: Ctx): Promise<NetRouteAnswer> {
  const { req, set, netDir } = ctx
  const base = { action: req.action, walnut: set.id, member: req.member }
  const prefix = ctx.deps.commandPrefix === undefined ? walnutCommandPrefix() : ctx.deps.commandPrefix
  if (!prefix || prefix.length === 0) return { ok: false, ...base, reload: 'none', code: 'no_revert_child', error: 'cannot tell how this walnut was started, so no put-back could run; nothing changed' }
  const portFile = portFileOf(set)
  const token = crypto.randomBytes(8).toString('hex')
  const at = ctx.now()
  const revertAt = at + req.revertAfterS * 1000
  const step = await withNetConfigLock(netDir, async (): Promise<{ code: string; error: string } | { entry: Entry }> => {
    const file = await readConfig(netDir)
    if (!file) return { code: 'no_config', error: `no readable walnut-net config in ${netDir}` }
    const i = memberAt(file.members, req.member)
    if (i < 0) return { code: 'no_member', error: 'that endpoint is not a member of walnut-net here' }
    const entry = file.members[i] as Entry
    const entrySet = typeof entry.walnut === 'string' ? entry.walnut : ''
    if (entrySet && entrySet !== set.id) return { code: 'other_set', error: `that member belongs to another service set (${entrySet})` }
    // A flip again keeps the entry from before the first one, while the entry still routes there.
    const old = await readNetRoute(ctx.record)
    const ours = entrySet === set.id && entry.daemonPortFile === portFile
    const previous = old && ours ? old.previous : entry
    await writeNetRoute(netDir, { v: NET_ROUTE_VERSION, walnut: set.id, member: req.member, previous, daemonPortFile: portFile, token, state: 'pending', at, revertAt })
    const next = { ...entry, walnut: set.id, daemonPortFile: portFile }
    file.members[i] = next
    await writeConfig(netDir, file.cfg, file.members)
    return { entry: next }
  })
  if ('code' in step) return { ok: false, ...base, reload: 'none', ...step }
  const reload = await askReload(netDir, ctx.deps.reloadTimeoutMs)
  const child = startPutBack(ctx, prefix, token)
  if (!child.pid) {
    // No safety net: undo at once rather than leave a route nothing puts back.
    const undone = await revert(ctx)
    return { ok: false, ...base, state: undone.state, reload: undone.reload, record: ctx.record, code: 'no_revert_child', error: `the put-back child did not start (${child.error ?? 'no pid'}); the route was put back` }
  }
  return { ok: true, ...base, state: 'pending', ...reload, record: ctx.record, revertAt, revertChild: child.pid, entry: step.entry }
}

function startPutBack(ctx: Ctx, prefix: string[], token: string): { pid?: number; error?: string } {
  const { req, set } = ctx
  const args = [...prefix.slice(1), 'daemon', NET_ROUTE_ACTION, '--walnut', req.walnut, '--member', req.member, '--revert', '--if-pending', token, '--revert-after', String(req.revertAfterS)]
  const spawn = ctx.deps.spawn ?? nodeSpawn
  try {
    const child = spawn(prefix[0]!, args, { detached: true, stdio: 'ignore', cwd: '/', env: ctx.deps.env ?? process.env })
    child.on('error', () => { /* reported through the missing pid */ })
    child.unref()
    return child.pid ? { pid: child.pid } : { error: `could not start ${prefix[0]} for set ${set.id}` }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

async function revert(ctx: Ctx): Promise<NetRouteAnswer> {
  const { req, set, netDir } = ctx
  const base = { action: 'revert' as const, walnut: set.id, member: req.member, record: ctx.record }
  const step = await withNetConfigLock(netDir, async (): Promise<{ state: string; entry?: unknown }> => {
    const rec = await readNetRoute(ctx.record)
    if (!rec) return { state: 'none' }
    if (req.ifPending !== undefined && (rec.state !== 'pending' || rec.token !== req.ifPending)) return { state: 'not_pending' }
    const file = await readConfig(netDir)
    const i = file ? memberAt(file.members, req.member) : -1
    const entry = i >= 0 ? file!.members[i] as Entry : null
    if (!file || !entry || entry.walnut !== rec.walnut || entry.daemonPortFile !== rec.daemonPortFile) {
      // Another writer changed (or removed) it since: its change stands; nothing of this flip is left.
      await removeNetRoute(ctx.record)
      return { state: 'left', entry }
    }
    file.members[i] = rec.previous
    await writeConfig(netDir, file.cfg, file.members)
    await removeNetRoute(ctx.record)
    return { state: 'reverted' }
  })
  if (step.state !== 'reverted') return { ok: true, ...base, ...step, reload: 'none' }
  return { ok: true, ...base, state: 'reverted', ...(await askReload(netDir, ctx.deps.reloadTimeoutMs)) }
}

/** Ask the running walnut-net to read the config again, with a deadline. */
async function askReload(netDir: string, timeoutMs = RELOAD_TIMEOUT_MS): Promise<Pick<NetRouteAnswer, 'reload' | 'reloadError'>> {
  try {
    const res = await netControlCall(netControlPath(netDir), { op: 'reload' }, timeoutMs)
    if (res.ok === true || res.error === 'shutting down') return { reload: 'ok' }
    return { reload: 'failed', reloadError: typeof res.error === 'string' ? res.error : 'walnut-net refused the reload' }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED') return { reload: 'none' }
    return { reload: 'failed', reloadError: (err as Error).message }
  }
}

/** The put-back child has no stdio: what it did goes to one small log beside the records. */
async function logPutBack(netDir: string, answer: NetRouteAnswer): Promise<void> {
  const file = path.join(netDir, NET_ROUTES_DIR, PUT_BACK_LOG)
  try {
    const size = await fs.stat(file).then((s) => s.size, () => 0)
    if (size > PUT_BACK_LOG_MAX) await fs.rename(file, `${file}.1`)
    await fs.appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...answer }) + '\n', { mode: 0o600 })
  } catch { /* best effort */ }
}
