/**
 * The remote host of a live e2e test (tests/e2e/*-live-e2e.test.ts): a real session daemon (the
 * source twin under node, or the Bun standalone twin) started inside the walls under a keeper,
 * and the mock Claude CLI it runs for a session. Everything a test needs to talk to that daemon
 * and to read what its mock CLI received, and the cleanup that ends every mock CLI through its
 * own daemon's stop (never a signal from the test).
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from './source-twin.js'
import { LIVE_CONNECT_GUARD, LIVE_KEEPER, liveEnv, walled } from './live-isolation.js'
import { guardLogOf } from './live-run.js'
import type { LiveProcs, Owned } from './live-procs.js'

/**
 * The Claude CLI a daemon runs for a session: stream-json in and out. A user line gets the reply
 * "The message reached the CLI." (as a live text delta, the assistant line and the result); a line
 * with "ASK:" asks to run a tool instead (a can_use_tool control request). It keeps what it got:
 * `<sid>.inbox.jsonl` (user lines), `<sid>.ctrl.jsonl` (control requests), `<sid>.resp.jsonl`
 * (answers to its own prompts), `<sid>.exit` (a line with its pid on every way it ends).
 * argv: <sid> <inbox file>.
 */
export const LIVE_MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
const inbox = process.argv[3]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
let buf = ''
let asked = 0
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    // A settings or mode change (leader.settings, leader.control): kept for the
    // test, answered as the CLI does (set_permission_mode echoes the mode).
    if (msg.type === 'control_request') {
      fs.appendFileSync(inbox.replace('.inbox.jsonl', '.ctrl.jsonl'), JSON.stringify(msg) + '\\n')
      const echo = msg.request && msg.request.subtype === 'set_permission_mode' ? { response: { mode: msg.request.mode } } : {}
      out({ type: 'control_response', response: Object.assign({ subtype: 'success', request_id: msg.request_id }, echo) })
      continue
    }
    // An answer to a permission prompt this CLI asked.
    if (msg.type === 'control_response') {
      fs.appendFileSync(inbox.replace('.inbox.jsonl', '.resp.jsonl'), JSON.stringify(msg) + '\\n')
      continue
    }
    if (msg.type !== 'user') continue
    fs.appendFileSync(inbox, JSON.stringify({ content: msg.message && msg.message.content }) + '\\n')
    // "ASK:" in a message: the CLI asks to run a tool, as Claude Code does in default mode.
    if (JSON.stringify(msg.message && msg.message.content).includes('ASK:')) {
      out({ type: 'control_request', request_id: 'perm-' + (++asked), request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls docs/' } } })
    } else {
      const text = 'The message reached the CLI.'
      // The live delta first, as Claude Code streams it (--include-partial-messages).
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, session_id: sid })
      out({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
      out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid })
    }
  }
})
// Every way it ends leaves a line with its pid: the cleanup fails on a mock that ended without
// one (a KILL). It ends on the daemon's stop (INT, then TERM) and with its daemon, which holds this
// stdin open while it runs and is its parent.
const done = (why) => { try { fs.appendFileSync(inbox.replace('.inbox.jsonl', '.exit'), process.pid + ' ' + why + '\\n') } catch {} process.exit(0) }
process.on('SIGINT', () => done('SIGINT'))
process.on('SIGTERM', () => done('SIGTERM'))
process.stdin.on('end', () => done('stdin-end'))
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) done('parent-gone') }, 2_000)
`

/** Where a test's mock CLI lives (written once by writeLiveMockCli). */
export const liveMockCliOf = (base: string): string => path.join(base, 'mock-cli.cjs')

export function writeLiveMockCli(base: string): string {
  const file = liveMockCliOf(base)
  fs.writeFileSync(file, LIVE_MOCK_CLI)
  return file
}

export interface LiveDaemon { name: string; twin: LiveTwin; proc: ChildProcess; keeper: Owned; owned: Owned; dir: string; port: number; sock: string; pid: number }

/** A mock CLI a daemon runs, by the pid its daemon reported and the mock's path. */
export interface LiveCli { d: LiveDaemon; sid: string; o: Owned }

export interface LiveDaemonCtx { procs: LiveProcs; base: string; repo: string; bun?: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(fn: () => Promise<boolean> | boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try { if (await fn()) return } catch { /* not yet */ }
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * Which daemon runs: the JS twin on node (`source`), the Bun twin from source (`standalone`), or the
 * compiled daemon the repo built (`binary`, dist/daemon-binaries, the one a server spawns as its own
 * local daemon and adopts only when the versions match).
 */
export type LiveTwin = 'source' | 'standalone' | 'binary'

/** The compiled daemon of this platform in dist/daemon-binaries, or null when the repo has not built it. */
export function builtDaemonBinary(repo: string): string | null {
  const file = path.join(repo, 'dist', 'daemon-binaries', `daemon-${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`)
  return fs.existsSync(file) ? file : null
}

/**
 * Start a daemon in `<base>/<first two letters of name>` (that dir must be one liveBase checked),
 * with its own HOME and TMPDIR, registered with its proof of ownership. `env`: the daemon's own
 * variables on top of its dirs (timing knobs).
 */
export async function spawnLiveDaemon(ctx: LiveDaemonCtx, name: string, twin: LiveTwin, env: Record<string, string> = {}): Promise<LiveDaemon> {
  const { procs, base, repo } = ctx
  const dir = path.join(base, name.slice(0, 2))
  fs.mkdirSync(dir)
  const daemonEnv = liveEnv({ home: path.join(base, `${name}-host`, 'home'), tmp: path.join(base, `${name}-host`), bins: [], guardLog: guardLogOf(base) }, {
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '10000',
    WALNUT_TURN_SNAPSHOTS: '0',
    ...env,
  })
  // stderr goes to a file nobody has to drain (a full pipe would block the daemon). Each runs in its
  // own dir, as the product's local daemon does: behind the walls Bun starts with an EMPTY environment
  // when its cwd sits under a dir it may not list (the clone under the real home), and a daemon
  // without its env would fall back to the production daemon dir with no connect guard ports.
  const stderr = fs.openSync(path.join(dir, 'daemon-stderr.log'), 'a')
  let daemonArgv: string[]
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    daemonArgv = [SOURCE_TWIN.file, script, '--start']
  } else if (twin === 'binary') {
    const bin = builtDaemonBinary(repo)
    if (!bin) throw new Error(`${name}: no built daemon in dist/daemon-binaries`)
    // A compiled bun reads neither NODE_OPTIONS nor --preload: no connect guard inside it (as for the daemon a server spawns).
    daemonArgv = [bin, '--start']
  } else {
    if (!ctx.bun) throw new Error(`${name}: the standalone twin needs bun`)
    // Bun does not read NODE_OPTIONS: the connect guard is preloaded by name.
    daemonArgv = [ctx.bun, '--preload', LIVE_CONNECT_GUARD, path.join(repo, 'src/providers/daemon-standalone.ts'), '--start']
  }
  // The daemon runs under a keeper inside the same walls (tests/helpers/live-keeper.cjs): its parent
  // watchdog asks the keeper, so the daemon stays behind the signal wall. The keeper ends with this
  // process (its stdin closes); `--start` runs the daemon in the keeper's child itself.
  const [cmd, args] = walled(process.execPath, [LIVE_KEEPER, ...daemonArgv], { base, repo })
  const proc = spawn(cmd, args, { env: daemonEnv, stdio: ['pipe', 'pipe', stderr], cwd: dir })
  fs.closeSync(stderr)
  const keeper = procs.child(`${name} keeper`, proc)
  if (!keeper) throw new Error(`${name}: spawn gave no pid`)
  const reported = await new Promise<number>((resolve, reject) => {
    let out = ''
    const t = setTimeout(() => reject(new Error(`${name}: the keeper reported no daemon in 30 s`)), 30_000)
    proc.stdout!.on('data', (b: Buffer) => {
      out += b.toString()
      const line = out.split('\n').find((l) => l.startsWith('{'))
      if (!line) return
      clearTimeout(t)
      try { resolve(Number(JSON.parse(line).daemon)) } catch (err) { reject(err) }
    })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`${name}: the keeper exited early (${code})`)) })
  })
  const owned = await procs.childOf(`${name} daemon`, reported, keeper)
  const portFile = path.join(dir, 'daemon.port')
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitUntil(() => fs.existsSync(portFile) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${name} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  if (pid !== owned.pid) throw new Error(`${name}: daemon.pid says ${pid}, the spawned daemon is ${owned.pid}`)
  return { name, twin, proc, keeper, owned, dir, sock, pid, port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10) }
}

/** A host daemon's WebSocket, open within 10 s or an error. */
export function openDaemonSocket(d: LiveDaemon): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${d.port}`)
    const t = setTimeout(() => { s.terminate(); reject(new Error(`${d.name}: its socket did not open in 10 s`)) }, 10_000)
    s.once('open', () => { clearTimeout(t); s.on('error', () => { /* a reply wait times out instead */ }); resolve(s) })
    s.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}

/** One command to a host's daemon over its WebSocket, and its reply. */
export async function daemonCall(d: LiveDaemon, payload: Record<string, unknown>, ms = 10_000): Promise<Record<string, any>> {
  const ws = await openDaemonSocket(d)
  try {
    return await new Promise<Record<string, any>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${String(payload.cmd)} timed out`)), ms)
      ws.on('message', (m) => { const r = JSON.parse(String(m)); if (r.id === 1) { clearTimeout(t); resolve(r) } })
      ws.send(JSON.stringify({ id: 1, ...payload }))
    })
  } finally { ws.close() }
}

/** A session as its host's daemon sees it (status, read-only). */
export const daemonStatus = (d: LiveDaemon, sid: string): Promise<Record<string, any>> => daemonCall(d, { cmd: 'status', sid })

/**
 * Start session `sid` on `d` running the mock CLI (writeLiveMockCli first), for the Walnut at
 * `originHome`, and register the CLI once it is idle.
 */
export async function startLiveMockSession(ctx: LiveDaemonCtx, d: LiveDaemon, sid: string, originHome: string): Promise<LiveCli> {
  const mock = liveMockCliOf(ctx.base)
  const reply = await daemonCall(d, { cmd: 'start', sid, cwd: d.dir, message: 'init', args: [process.execPath, mock, sid, path.join(d.dir, `${sid}.inbox.jsonl`)], origin: { home: originHome } }, 20_000)
  if (reply.ok !== true) throw new Error(`${d.name}: start ${sid}: ${JSON.stringify(reply)}`)
  await waitUntil(() => { try { return fs.readFileSync(path.join(d.dir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 30_000, `${sid} idle`)
  // The CLI the daemon runs, once it wrote (so the daemon's shell has exec'd it): its pid from the
  // daemon, proven by the mock's path in its command line.
  const st = await daemonStatus(d, sid)
  return { d, sid, o: await ctx.procs.command(`mock cli ${sid.slice(0, 8)} on ${d.name}`, Number(st.pid), mock) }
}

function linesOf(file: string): Array<Record<string, any>> {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch { return [] }
}

/** The user lines a session's mock CLI got, as text (a list of content blocks as its JSON). */
export const inboxOf = (d: LiveDaemon, sid: string): string[] =>
  linesOf(path.join(d.dir, `${sid}.inbox.jsonl`)).map((l) => typeof l.content === 'string' ? l.content : JSON.stringify(l.content))

/** The control requests a session's CLI got (the mock keeps them). */
export const ctrlOf = (d: LiveDaemon, sid: string) =>
  linesOf(path.join(d.dir, `${sid}.ctrl.jsonl`)) as Array<{ request_id: string; request: { subtype: string; settings: Record<string, string> } }>

/** The permission answers a session's CLI got (the mock keeps them). */
export const respOf = (d: LiveDaemon, sid: string) =>
  linesOf(path.join(d.dir, `${sid}.resp.jsonl`)) as Array<{ response: { request_id: string; response: Record<string, unknown> } }>

/**
 * The cleanup step between the servers and the daemons (finishLive's `between`): every mock CLI
 * ends through its own daemon's stop (SIGINT, then TERM), never a signal from here; any other
 * session a daemon still runs too, once its pid is proven to run the mock. A mock that ended
 * without its exit line was killed: a failure.
 */
export async function stopLiveMockSessions(ctx: LiveDaemonCtx, daemons: LiveDaemon[], clis: LiveCli[], originHome: string): Promise<void> {
  const p = ctx.procs
  const mock = liveMockCliOf(ctx.base)
  for (const d of daemons) {
    if ((await p.state(d.owned)) !== 'ours') continue
    const listed = await daemonCall(d, { cmd: 'list' }).catch(() => ({ sessions: [] as Array<{ sid: string; pid: number | null; alive: boolean }> }))
    for (const row of (listed.sessions ?? []) as Array<{ sid: string; pid: number | null; alive: boolean }>) {
      if (!row.alive || !row.pid || clis.some((c) => c.d === d && c.sid === row.sid)) continue
      const o = await p.command(`session ${row.sid.slice(0, 8)} on ${d.name}`, row.pid, mock).catch(() => null)
      if (o) clis.push({ d, sid: row.sid, o })
    }
  }
  for (const c of clis) {
    if ((await p.state(c.o)) !== 'ours') continue
    const r = await daemonCall(c.d, { cmd: 'stop', sid: c.sid, reason: 'user', initiator: 'human', home: originHome }, 20_000).catch((err) => ({ ok: false, error: String(err) }))
    if (r.ok !== true || r.stopped !== true) p.fail(`${c.o.label}: the daemon did not stop it: ${JSON.stringify(r).slice(0, 300)}`)
    await p.waitExit(c.o, 15_000)
  }
  for (const c of clis) {
    if ((await p.state(c.o)) !== 'gone') continue
    const marks = (() => { try { return fs.readFileSync(path.join(c.d.dir, `${c.sid}.exit`), 'utf8') } catch { return '' } })()
    if (!marks.split('\n').some((l) => l.startsWith(`${c.o.pid} `))) p.fail(`${c.o.label} (${c.o.pid}) ended without its exit line: killed?`)
  }
}
