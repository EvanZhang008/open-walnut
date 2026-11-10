/**
 * `walnut net join <companion> <code>`: what an invite link runs on a new machine
 * after Walnut is installed (core/net/net-join-script.ts). It keeps Walnut's daemon
 * running here (`walnut daemon install`), makes this machine's network key (in the
 * daemon, net-core.ts), trades the invite for a place in the user's machines on the
 * cloud companion (routes/net-v1.ts), and hands the daemon its config. The Mac sees
 * the new member and lists it under Settings > Remote Hosts.
 *
 * `walnut net join <ticket>`: the same with no companion (join.sh runs it): the daemon
 * is told to let the Mac in, then asks the Mac itself, over the host network, to take
 * this machine in with the ticket's code (core/net/join-ticket.ts, net-local.ts).
 *
 * `walnut net status`: this machine's host network, as its daemon says.
 *
 * Its lines match the script's first step (net-join-script.ts): one column of dots.
 */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from '#ws'
import { decodeTicket, TICKET_PREFIX, type JoinTicket } from '../core/net/join-ticket.js'
import { FETCH_TIMEOUT_MS as NET_FETCH_TIMEOUT_MS } from '../providers/net-binary.js'
import { DRAIN_SWAP_WINDOW_MS, resendThroughSwap } from '../providers/daemon-drain-resend.js'

const STEP_W = 19
function step(n: number, label: string, text: string): void {
  process.stdout.write(`  ${n}/3  ${(label + ' ').padEnd(STEP_W, '.')} ${text}\n`)
}

/**
 * This account's daemon dir: the one its login service runs (the same choice as
 * `walnut daemon`). WALNUT_JOIN_DAEMON_DIR names another for a test, which then never
 * installs a service.
 */
async function daemonDir(): Promise<string> {
  if (process.env.WALNUT_JOIN_DAEMON_DIR) return process.env.WALNUT_JOIN_DAEMON_DIR
  const { localProductionDaemonDir } = await import('../lib/daemon-dir.js')
  return localProductionDaemonDir()
}

/**
 * One command to this account's own daemon (at `atPort`, else the port its port file names).
 * A refusal of a daemon shutting down for a swap is asked again of the next one (daemon-drain-resend.ts).
 */
async function daemonRpc(cmd: string, params: Record<string, unknown> = {}, timeoutMs = 30_000, atPort?: number): Promise<Record<string, unknown>> {
  let refusedAt = 0
  return resendThroughSwap(cmd, {
    once: (budget) => daemonRpcOnce(cmd, params, budget, atPort),
    // Each try reads the port anew and opens its own socket: one that never opened sent nothing.
    failure: (err) => ((err as { unopened?: boolean }).unopened ? 'no-link' : null),
    swapUnderway: () => Date.now() - refusedAt < DRAIN_SWAP_WINDOW_MS,
    noteRefusal: () => { refusedAt = Date.now() },
    waitLink: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 1_000))),
  }, timeoutMs)
}

async function daemonRpcOnce(cmd: string, params: Record<string, unknown>, timeoutMs: number, atPort?: number): Promise<Record<string, unknown>> {
  const unopened = (err: unknown) => Object.assign(err instanceof Error ? err : new Error(String(err)), { unopened: true })
  let port: number
  try {
    port = atPort ?? Number(fs.readFileSync(path.join(await daemonDir(), 'daemon.port'), 'utf8').trim())
  } catch (err) { throw unopened(err) }
  if (!Number.isInteger(port) || port <= 0) throw unopened(new Error('the Walnut daemon is not running here'))
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 4 * 1024 * 1024 })
    let opened = false
    ws.on('open', () => { opened = true })
    const timer = setTimeout(() => { try { ws.terminate() } catch { /* gone */ } reject(new Error(`the daemon did not answer ${cmd}`)) }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, cmd, ...params })))
    ws.on('message', (d: Buffer) => {
      let m: Record<string, unknown>
      try { m = JSON.parse(d.toString()) as Record<string, unknown> } catch { return }
      if (m.id !== 1) return
      clearTimeout(timer)
      ws.close()
      resolve(m)
    })
    ws.on('error', (e: Error) => { clearTimeout(timer); reject(opened ? e : unopened(e)) })
  })
}

/**
 * How long step 3 waits for this machine's network key. A new machine's daemon downloads
 * walnut-net before it can answer (one file, up to its download limit), and a slow line
 * takes most of that: 2026-11-03 a PC's first start spent 40 s on it, and the join, which
 * waited 30 s, stopped with "the daemon did not answer net.identity".
 */
export const NET_IDENTITY_WAIT_MS = NET_FETCH_TIMEOUT_MS + 30_000

/** This machine's network key, with a line when it takes a while (the first start downloads walnut-net). */
export async function netIdentity(opts: { waitMs?: number; slowMs?: number; port?: number } = {}): Promise<Record<string, unknown>> {
  const slow = setTimeout(() => step(3, 'Join', 'getting the network part ready (the first time only; it can take a minute)'), opts.slowMs ?? 5_000)
  try {
    return await daemonRpc('net.identity', {}, opts.waitMs ?? NET_IDENTITY_WAIT_MS, opts.port)
  } finally {
    clearTimeout(slow)
  }
}

/** The daemon answering here: `service` when it is the login service (it says where it runs from). */
async function daemonUp(): Promise<'service' | 'running' | null> {
  try {
    const hello = await daemonRpc('hello', {}, 5_000)
    if (hello.ok !== true) return null
    return typeof hello.serviceExecutable === 'string' ? 'service' : 'running'
  } catch { return null }
}

/**
 * A daemon of this account that still runs from its dir after the temp cleanup removed its
 * pid and port files (macOS removes /tmp files nobody touched for 3 days; 2026-11-02: a Mac
 * whose Walnut had run 26 days). Nothing could hand it over, and a service daemon beside it
 * fails on its instance lock. The lock still names it, with its port once it answers (null
 * while it starts), so its files are written back from there, never over one that exists, and
 * the install then hands it over to the login service like any running daemon. Its pid, or null.
 */
export async function recoverLostDaemon(): Promise<number | null> {
  const dir = await daemonDir()
  if (fs.existsSync(path.join(dir, 'daemon.pid'))) return null
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid === null) return null
  const { readDaemonInstanceOwner } = await import('../providers/daemon-instance-lock.js')
  const owner = await readDaemonInstanceOwner({ runtimeDir: dir, uid })
  if (!owner || !(owner.pid > 1) || owner.wsPort === null || !owner.instanceId) return null
  try {
    const hello = await daemonRpc('hello', {}, 5_000, owner.wsPort)
    if (hello.ok !== true || hello.instanceId !== owner.instanceId) return null
  } catch { return null }
  // The pid file last: it is what says a daemon runs here.
  for (const [name, text] of [['daemon.port', String(owner.wsPort)], ['daemon.instance', owner.instanceId], ['daemon.pid', String(owner.pid)]]) {
    try { fs.writeFileSync(path.join(dir, name), text, { flag: 'wx', mode: 0o600 }) } catch (err) {
      // One that survived must already say the same, never a mix of two daemons.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
      try { if (fs.readFileSync(path.join(dir, name), 'utf8').trim() !== text) return null } catch { return null }
    }
  }
  return owner.pid
}

async function waitDaemon(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await daemonUp()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function errText(r: Record<string, unknown>): string {
  const e = r.error as { message?: unknown } | string | undefined
  if (typeof e === 'string') return e
  return typeof e?.message === 'string' ? e.message : 'refused'
}

const JOIN_FAILS: Record<string, string> = {
  invalid_code: 'This link is not valid any more (used, or older than 10 minutes). Make a new one on your Mac.',
  no_answer: 'Your Mac did not answer. It must be awake and online while the machine joins; try again, or make a new link.',
  rate_limited: 'Too many tries with wrong links. Wait 10 minutes, then make a new link on your Mac.',
}

function done(name: string): number {
  step(3, 'Join', `done: this machine is "${name}"`)
  process.stdout.write(`\nYour Mac lists "${name}" under Settings > Remote Hosts.\n`)
  process.stdout.write(`To take it out later: Settings > Remote Hosts > ${name} > Remove.\n`)
  return 0
}

export async function runNetJoin(target: string, code: string | undefined, opts: { steps?: boolean } = {}): Promise<number> {
  if (!opts.steps) {
    process.stdout.write('Walnut: adding this machine to your Walnut machines\n')
    step(1, 'Walnut', `installed (${process.env.WALNUT_VERSION_LABEL ?? 'this one'})`)
  }
  let ticket: JoinTicket | null = null
  let base: URL | null = null
  if (code === undefined) {
    ticket = decodeTicket(target)
    if (!ticket) {
      step(3, 'Join', target.startsWith(TICKET_PREFIX) ? 'this link is not one this Walnut reads. Run `walnut update`, then this again.' : 'run the command your Mac shows under Settings > Remote Hosts > Add a machine')
      return 1
    }
  } else {
    try { base = new URL(target) } catch { step(3, 'Join', `${target} is not an address`); return 1 }
    if (base.protocol !== 'https:' && process.env.WALNUT_NET_ALLOW_HTTP_JOIN !== '1') { step(3, 'Join', `${target} is not https; refusing to join over plain HTTP`); return 1 }
  }
  if (!(await keepRunning())) return 1
  return ticket ? joinWithTicket(ticket) : joinWithCompanion(base!, code!)
}

/** What step 2 needs from the machine; tests replace it. */
export interface KeepRunningIo {
  daemonUp(): Promise<'service' | 'running' | null>
  waitDaemon(ms: number): Promise<boolean>
  /** True when this process is the compiled Walnut file. */
  compiled(): Promise<boolean>
  execPath: string
  /** `walnut daemon install --yes --executable <file>`: its exit code, and on a failure the reason
   *  its JSON report gave (`failure.message`), which this screen shows in step 2's line. */
  install(options: { yes: true; executable: string }): Promise<number | { code: number; why?: string }>
  /** WALNUT_JOIN_DAEMON_DIR: a test's daemon, which never installs a service. */
  testDaemonDir?: string
  /** Writes back the files of a daemon here that lost them (recoverLostDaemon); its pid, or null. */
  recoverLostDaemon?(): Promise<number | null>
}

const realKeepRunningIo = (): KeepRunningIo => ({
  daemonUp, waitDaemon, recoverLostDaemon, execPath: process.execPath, testDaemonDir: process.env.WALNUT_JOIN_DAEMON_DIR,
  compiled: async () => (await import('../lib/single-file.js')).singleFile() !== null,
  install: async (options) => {
    const { runDaemonServiceCli } = await import('../providers/daemon-service-cli.js')
    // Its JSON report is for `walnut daemon`; this screen says it in one line, the failure's
    // reason included (2026-11-02: the existing-Mac join stopped at step 2 with none).
    const write = process.stdout.write.bind(process.stdout)
    let report = ''
    ;(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { report += String(s); return true }
    let code: number
    try { code = await runDaemonServiceCli('install', options) } finally { (process.stdout as unknown as { write: typeof write }).write = write }
    return { code, why: code === 0 ? undefined : installFailure(report) }
  },
})

/**
 * 2/3: the daemon, as a service that starts at login. One already running that is not
 * the service (a server or an SSH connect started it) would be gone after a reboot: the
 * install hands it over to the service.
 */
export async function keepRunning(io: KeepRunningIo = realKeepRunningIo()): Promise<boolean> {
  let up = await io.daemonUp()
  if (!up && !io.testDaemonDir && await io.recoverLostDaemon?.()) up = await io.daemonUp()
  if (up === 'service' || (up && io.testDaemonDir)) {
    step(2, 'Keep it running', 'on (already running)')
    return true
  }
  if (io.testDaemonDir) {
    step(2, 'Keep it running', `no daemon answers in ${io.testDaemonDir}`)
    return false
  }
  try {
    const install = serviceInstall(await io.compiled(), io.execPath)
    if ('error' in install) { step(2, 'Keep it running', install.error); return false }
    const result = await io.install(install)
    const { code, why } = typeof result === 'number' ? { code: result, why: undefined } : result
    // By its path: a new machine's shell has no ~/.local/bin on PATH yet, and another
    // Walnut on PATH (an npm install) would show another daemon.
    if (code !== 0 || !(await io.waitDaemon(30_000))) {
      step(2, 'Keep it running', `did not start${why ? `: ${why}` : ''}. Run \`${install.executable} daemon status\` to see why, then this again.`)
      return false
    }
    step(2, 'Keep it running', 'on (starts when you log in)')
    return true
  } catch (err) {
    step(2, 'Keep it running', `${(err as Error).message}`)
    return false
  }
}

/** The reason in `walnut daemon install`'s JSON report (`{ ok: false, failure: { message } }`), one line. */
export function installFailure(report: string): string | undefined {
  try {
    const parsed = JSON.parse(report.trim()) as { failure?: { message?: unknown } }
    const message = parsed.failure?.message
    return typeof message === 'string' && message.trim() ? message.replace(/\s+/g, ' ').trim().slice(0, 300) : undefined
  } catch {
    return undefined
  }
}

/**
 * What the login service runs: the compiled Walnut file is the daemon too (`walnut
 * --service`, binary/main.ts). Without it the install had no daemon to stage and every
 * new machine stopped at step 2 (2026-11-02; the tests joined with a daemon already up).
 */
export function serviceInstall(compiled: boolean, execPath: string): { yes: true; executable: string } | { error: string } {
  if (compiled) return { yes: true, executable: execPath }
  return { error: 'needs the installed Walnut file (this Walnut runs under Node). Install it with curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh, then run this again.' }
}

/** 3/3 with no companion: let the Mac in, then ask it to take this machine in. */
async function joinWithTicket(t: JoinTicket): Promise<number> {
  try {
    const hello = await daemonRpc('hello')
    if (!(hello.capabilities as string[] | undefined)?.includes('net-join-v1')) { step(3, 'Join', 'this Walnut daemon is too old to join. Run `walnut update`, then this again.'); return 1 }
    const ident = await netIdentity()
    if (ident.ok !== true || typeof ident.endpointId !== 'string') { step(3, 'Join', `no network key: ${errText(ident)}`); return 1 }
    if (ident.endpointId === t.mac) { step(3, 'Join', 'this is the Mac that made the link; run it on the new machine'); return 1 }
    // The daemon lets the Mac in, asks, and on a refusal puts back what this machine had.
    const res = await daemonRpc('net.join', {
      to: t.mac, code: t.code, hostname: os.hostname(), platform: `${process.platform}-${process.arch}`, addrs: t.addrs, relay: t.relay, relayMode: t.relayMode,
    }, 90_000)
    if (res.ok === true && res.joined === true) return done(String(res.name || os.hostname().split('.')[0]))
    const why = res.ok === true ? String(res.error ?? 'refused') : errText(res)
    step(3, 'Join', JOIN_FAILS[why] ?? why)
    return 1
  } catch (err) {
    step(3, 'Join', `${(err as Error).message}`)
    return 1
  }
}

/** 3/3 with the companion: this machine's key (made here, it never leaves), then the invite. */
async function joinWithCompanion(base: URL, code: string): Promise<number> {
  try {
    const hello = await daemonRpc('hello')
    if (!(hello.capabilities as string[] | undefined)?.includes('net-v1')) { step(3, 'Join', 'this Walnut daemon is too old to join. Run `walnut update`, then this again.'); return 1 }
    const ident = await netIdentity()
    if (ident.ok !== true || typeof ident.endpointId !== 'string') { step(3, 'Join', `no network key: ${errText(ident)}`); return 1 }
    const res = await fetch(new URL('/api/v1/net/join', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, endpointId: ident.endpointId, hostname: os.hostname(), platform: `${process.platform}-${process.arch}` }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await res.json().catch(() => ({})) as Record<string, unknown>
    if (!res.ok) { step(3, 'Join', errText(body)); return 1 }
    const conf = await daemonRpc('net.configure', { relays: body.relays, relayRoots: body.relayRoots, members: body.members }, 30_000)
    if (conf.ok !== true) { step(3, 'Join', `joined, but the network did not start here: ${errText(conf)}`); return 1 }
    return done(String(body.name))
  } catch (err) {
    step(3, 'Join', `${(err as Error).message}`)
    return 1
  }
}

export async function runNetStatus(): Promise<number> {
  try {
    const s = await daemonRpc('net.status', {}, 10_000)
    if (s.ok !== true) { process.stderr.write(`walnut net: ${errText(s)}\n`); return 1 }
    process.stdout.write(JSON.stringify({ ...s, id: undefined, ok: undefined }, null, 2) + '\n')
    return 0
  } catch (err) {
    process.stderr.write(`walnut net: ${(err as Error).message}\n`)
    return 1
  }
}
