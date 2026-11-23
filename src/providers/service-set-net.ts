/**
 * A service set's own walnut-net identity on the host (net-config-core.ts netStateDir: the set's
 * `<set>/net`, its own key, address, config, control socket and UDP port), for the leader that
 * pairs with it over the link it already holds to the host (service-set-move-link.ts). The two
 * walnut-nets of the machine never touch each other; these two words are the only bridge:
 *
 *   walnut daemon net-id --walnut <walnutId> [--walnut-home <dir>] --request <base64url JSON>
 *     The set's own daemon (its loopback door, `<runtime dir>/daemon.port`, whose hello must name
 *     the set) takes the request as its `net.configure`: the leader's member list, the one every
 *     joined machine is handed (core/net/net-mac.ts). That writes the set's config by the daemon's
 *     own rules and starts the set's walnut-net. Prints {"ok":true,"endpointId","addrs"}.
 *   walnut daemon net-forget --member <endpointId>
 *     The default set's walnut-net (today's ~/.local/state/open-walnut/net, maybe another Walnut's)
 *     no longer lets that one endpoint in: its entry leaves config.json and the running walnut-net
 *     reloads. Nothing else in the file changes; with no such entry nothing is written. The leader
 *     sends it only for itself, after its move is confirmed.
 *
 * Every answer is one JSON line on stdout ({"ok":false,"code","message"} when not done).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from '#ws'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { ID_RE, netStateDir } from './net-config-core.js'
import { netControlCall, netControlPath, writeFileAtomic } from './net-control.js'
import { chooseServiceSet } from './service-set-choice.js'
import { serviceSetIdOf, serviceSetLine } from './service-set.js'
import { accountInfo } from '../lib/account.js'
import { localProductionDaemonDir } from '../lib/daemon-dir.js'

export const NET_ID_ACTION = 'net-id'
export const NET_FORGET_ACTION = 'net-forget'
export const SERVICE_SET_NET_ACTIONS: readonly string[] = [NET_ID_ACTION, NET_FORGET_ACTION]

/** How long the set's daemon may take to listen, and its walnut-net to come up (a first one downloads its build). */
const DOOR_WAIT_MS = 30_000
const NET_UP_WAIT_MS = 200_000

type Answer = { ok: true } & Record<string, unknown> | { ok: false; code: string; message: string }

const refuse = (code: string, message: string): Answer => ({ ok: false, code, message })

/** The leader's request, as it wrote it (base64url JSON of a net.configure); null when it does not read. */
export function decodeNetRequest(b64: string | undefined): Record<string, unknown> | null {
  if (!b64 || !/^[A-Za-z0-9_-]{1,65536}$/.test(b64)) return null
  try {
    const v = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const r = v as Record<string, unknown>
    // Pairing lets the leader in; it never turns the set's network off (leaving does, service-set-provision.ts).
    if (r.enabled === false || !Array.isArray(r.members) || !r.members.some((m) => (m as { accept?: unknown })?.accept === true)) return null
    return r
  } catch { return null }
}

export function encodeNetRequest(req: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(req), 'utf8').toString('base64url')
}

/** Commands on a daemon's loopback door, one after another; each answer, or null at the deadline. */
export async function askDoor(port: number, cmds: Array<Record<string, unknown>>, timeoutMs: number): Promise<Array<Record<string, unknown>> | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 1024 * 1024 })
    const answers: Array<Record<string, unknown>> = []
    let done = false
    const finish = (v: Array<Record<string, unknown>> | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.terminate()
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const next = () => {
      if (answers.length === cmds.length) return finish(answers)
      socket.send(JSON.stringify({ ...cmds[answers.length], id: answers.length + 1 }))
    }
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
    socket.on('open', next)
    socket.on('message', (raw) => {
      try {
        const v = JSON.parse(raw.toString()) as Record<string, unknown>
        if (v?.id !== answers.length + 1) return
        answers.push(v)
        next()
      } catch { finish(null) }
    })
  })
}

async function doorPort(runtimeDir: string, waitMs: number): Promise<number | null> {
  const end = performance.now() + waitMs
  for (;;) {
    const text = await fs.promises.readFile(path.join(runtimeDir, 'daemon.port'), 'utf8').catch(() => '')
    const port = Number(text.trim() || 'x')
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port
    if (performance.now() >= end) return null
    await delay(500)
  }
}

export interface NetIdInput {
  walnutId: string
  walnutHome?: string
  request: Record<string, unknown>
  /** Tests: the account and dirs (default: this process's). */
  home?: string
  uid?: number
  platform?: 'linux' | 'darwin'
  defaultRuntimeDir?: string
  doorWaitMs?: number
  netWaitMs?: number
}

/** `net-id`: the set's walnut-net configured with the leader's list and running; its endpoint id. */
export async function serviceSetNetId(i: NetIdInput): Promise<{ set: string; answer: Answer }> {
  const home = i.home ?? os.homedir()
  const choice = await chooseServiceSet({
    platform: i.platform ?? (process.platform as 'linux' | 'darwin'), home, walnutId: i.walnutId, serveHome: i.walnutHome,
    defaultRuntimeDir: i.defaultRuntimeDir ?? localProductionDaemonDir(), uid: i.uid ?? accountInfo().uid, claim: false,
  })
  const set = choice.set
  if (!set.id) return { set: '', answer: refuse('default_set', 'this Walnut holds the default service here: it keeps the machine\'s walnut-net, nothing to pair') }
  const port = await doorPort(set.runtimeDir, i.doorWaitMs ?? DOOR_WAIT_MS)
  if (port === null) return { set: set.id, answer: refuse('not_running', `this Walnut's own service is not running here (no ${path.join(set.runtimeDir, 'daemon.port')})`) }
  // The hello first, alone: a daemon that is not this set's (the machine's default one) is asked nothing more.
  const hello = (await askDoor(port, [{ cmd: 'hello' }], 15_000))?.[0]
  if (!hello) return { set: set.id, answer: refuse('no_answer', 'this Walnut\'s own service did not answer on its door') }
  if (hello.serviceSet !== set.id) return { set: set.id, answer: refuse('not_set_daemon', `the daemon on ${path.join(set.runtimeDir, 'daemon.port')} is not this Walnut's own service`) }
  const conf = (await askDoor(port, [{ cmd: 'net.configure', ...i.request }], NET_UP_WAIT_MS))?.[0]
  if (!conf) return { set: set.id, answer: refuse('no_answer', 'this Walnut\'s own service did not answer net.configure') }
  if (conf.ok !== true || typeof conf.endpointId !== 'string' || !ID_RE.test(conf.endpointId)) {
    return { set: set.id, answer: refuse('net_configure', `its walnut-net did not take the list: ${String(conf.error ?? 'no endpoint id')}`) }
  }
  // Running, and its addresses (a first walnut-net may still be downloading its build).
  const end = performance.now() + (i.netWaitMs ?? NET_UP_WAIT_MS)
  for (;;) {
    const st = (await askDoor(port, [{ cmd: 'net.status' }], 10_000))?.[0]
    const node = st?.node as { addrs?: unknown } | null | undefined
    if (st?.running === true) {
      const addrs = Array.isArray(node?.addrs) ? (node!.addrs as unknown[]).filter((a): a is string => typeof a === 'string').slice(0, 16) : []
      return { set: set.id, answer: { ok: true, endpointId: conf.endpointId, addrs } }
    }
    if (performance.now() >= end) return { set: set.id, answer: refuse('net_not_running', `its walnut-net is not running yet (${String(st?.lastError ?? 'no status')})`) }
    await delay(1_000)
  }
}

/** `net-forget`: the default set's walnut-net lets `member` in no longer (only that entry; nothing else changes). */
export async function forgetDefaultNetMember(member: string, home = os.homedir()): Promise<Answer> {
  if (!ID_RE.test(member)) return refuse('bad_member', 'the member must be an endpoint id')
  const dir = netStateDir({ serviceStateDir: null, prodDaemon: true, daemonDir: '/', home })
  const file = path.join(dir, 'config.json')
  let before: string
  try { before = fs.readFileSync(file, 'utf8') } catch { return { ok: true, changed: false } }
  let cfg: Record<string, unknown>
  try { cfg = JSON.parse(before) as Record<string, unknown> } catch { return refuse('unreadable', `${file} does not read; it is left as it is`) }
  const members = Array.isArray(cfg.members) ? cfg.members as Array<{ id?: unknown }> : []
  const rest = members.filter((m) => m?.id !== member)
  if (rest.length === members.length) return { ok: true, changed: false }
  const text = JSON.stringify({ ...cfg, members: rest }, null, 2) + '\n'
  writeFileAtomic(file, text)
  const control = typeof cfg.control === 'string' && path.isAbsolute(cfg.control) ? cfg.control : netControlPath(dir)
  let res: Record<string, unknown>
  try {
    res = await netControlCall(control, { op: 'reload' }, 10_000)
  } catch {
    // None runs: the file holds the list it starts on.
    return { ok: true, changed: true, reloaded: false }
  }
  if (res.ok !== true && res.error !== 'shutting down') {
    // Refused: the file goes back to what that walnut-net runs, as its own supervisor does (net-core.ts reload).
    if (fs.readFileSync(file, 'utf8') === text) writeFileAtomic(file, before)
    return refuse('reload_refused', `the machine's walnut-net refused the list without this member: ${String(res.error ?? 'invalid')}`)
  }
  return { ok: true, changed: true, reloaded: true }
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

/** `walnut daemon net-id|net-forget …` (daemon-service-cli.ts): one JSON line; exit 0 when ok. */
export async function runServiceSetNetArgs(args: string[]): Promise<number> {
  const print = (a: Answer): number => { process.stdout.write(JSON.stringify(a) + '\n'); return a.ok ? 0 : 1 }
  if (args[0] === NET_FORGET_ACTION) return print(await forgetDefaultNetMember((flag(args, '--member') ?? '').toLowerCase()))
  const walnutId = flag(args, '--walnut') ?? ''
  serviceSetIdOf(walnutId)
  const walnutHome = flag(args, '--walnut-home')
  if (walnutHome !== undefined && !path.isAbsolute(walnutHome)) throw new Error('--walnut-home requires the absolute data dir of the Walnut it is for')
  const request = decodeNetRequest(flag(args, '--request'))
  if (!request) return print(refuse('bad_request', '--request must be the base64url JSON of a member list that lets its leader in'))
  const { set, answer } = await serviceSetNetId({ walnutId, ...(walnutHome ? { walnutHome } : {}), request })
  // The set it acted for first, as every `walnut daemon … --walnut` line (service-set.ts serviceSetLine).
  process.stdout.write(`${serviceSetLine(set)}\n`)
  return print(answer)
}
