/**
 * A trigger check the machine failed, on the real daemon (trigger-check-core.ts
 * machineFaultOf): the daemon reads the answers the check's own `walnut` calls got, and a run that
 * failed with a machine fault among them is reported with `fault`, without a strike.
 *
 *   test (server WS) ◄═gateway-request═ daemon ◄═gateway socket═ check (one call, then its verdict)
 *        └═gateway-result{errorCode, api}═►                       exit 1 when the call failed
 *
 * 2026-11-16 11:36Z: the Mac's disk was 99% full, the API answered 507, and nine checks failed
 * at once and woke their sessions. Covered:
 * - a 507 answer (api {status 507, code disk_full}) → trigger.checked {outcome error, fault disk_full},
 *   consecutiveErrors stays 0, and the state file has no `fault` (an older snapshot check would
 *   call it corrupt);
 * - a hub_timeout answer (one slow op as often as a stuck server) → no fault, a strike;
 * - the check failing on its own (its call answered fine) → no fault, consecutiveErrors 1;
 * - a check's report of a call refused as written is relayed and never clears the run's fault;
 * - after the faults, a good run fires the item that was waiting (nothing was lost).
 *
 * MACHINE SAFETY: HOME, the daemon dir and the state dir are temp paths under /tmp (a unix socket
 * path is at most 104 bytes on macOS); the only processes signalled are the daemons this file started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const BUN: string | undefined = testBun()
const STANDALONE = path.join(ROOT, 'src/providers/daemon-standalone.ts')
let checkDir = ''
let checkPath = ''
let root = ''

// The check: one gateway call as `walnut trigger-check` makes it, then its verdict. A failed call
// is exit 1, as the CLI does on a 507; a good one prints the items the test put in the file, or
// fails on its own when the file says so.
const CHECK = `
const net = require('net'), fs = require('fs')
const sock = process.env.WALNUT_CHECK_SOCKET
const sid = process.env.WALNUT_CHECK_TOKEN || 'external'
const items = process.argv[2]
const s = net.connect(sock)
let buf = ''
s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name: 'trigger_template_check', args: { template: 'mail:new-mail', params: {} } } }) + '\\n'))
s.on('data', (d) => {
  buf += d
  if (!buf.includes('\\n')) return
  s.destroy()
  const resp = JSON.parse(buf.split('\\n')[0])
  if (!resp.ok) { process.stderr.write('walnut trigger-check mail:new-mail: ' + resp.error.message + '\\n'); process.exit(1) }
  const want = fs.readFileSync(items, 'utf8').trim()
  if (want === 'BROKEN') { process.stderr.write('jq: parse error\\n'); process.exit(1) }
  if (want === 'HTTP_507' || want === 'HTTP_507_THEN_400') {
    // As the Mac's CLI does after its own HTTP call got a 507 (tools-daemon-fallback.ts reportCheckOutcome).
    const r = net.connect(sock)
    r.on('connect', () => r.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name: 'trigger_check_fault', args: { kind: 'disk_full' } } }) + '\\n'))
    const end = () => { process.stderr.write('Walnut API error (507)\\n'); process.exit(1) }
    r.on('data', () => {
      r.destroy()
      if (want === 'HTTP_507') return end()
      // Then a call of its refused as written, which it tells its daemon of (check-call-report.ts).
      const t = net.connect(sock)
      t.on('connect', () => t.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name: 'trigger_check_call_refused', args: { op: 'task_list', message: 'Invalid arguments' } } }) + '\\n'))
      t.on('data', () => { t.destroy(); end() })
    })
    return
  }
  console.log(JSON.stringify({ fire: true, items: want.split(',').map((id) => ({ id })) }))
  process.exit(0)
})
s.on('error', (e) => { process.stderr.write(String(e) + '\\n'); process.exit(1) })
setTimeout(() => process.exit(3), 20000)
`

/** How the test's "server" answers the check's call. */
type Answer = 'ok' | 'disk_full' | 'hub_timeout'

interface Daemon { proc: ChildProcess; ws: WebSocket; daemonDir: string; stateDir: string; events: Array<Record<string, any>>; answer: { mode: Answer }; relayed: string[] }
let daemon: Daemon | null = null
let rpcId = 1

function rpc(d: { ws: WebSocket }, cmd: Record<string, unknown>, timeoutMs = 40_000): Promise<Record<string, any>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, any>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); d.ws.off('message', onMessage); resolve(msg) }
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor<T>(pick: () => T | undefined, ms = 30_000): Promise<T | undefined> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const hit = pick()
    if (hit !== undefined) return hit
    await new Promise((r) => setTimeout(r, 50))
  }
  return pick()
}

async function boot(): Promise<Daemon> {
  root = fs.realpathSync(fs.mkdtempSync('/tmp/wmf-'))
  const daemonDir = path.join(root, 'd')
  const stateDir = path.join(root, 'ts')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_SESSION_ID: undefined,
    WALNUT_AGENT_SOCKET: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_TRIGGER_STATE_DIR: stateDir,
    WALNUT_STREAMS_DIR: path.join(root, 's'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', 'spawn-journal.jsonl'),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  const proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(b.toString()))
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const events: Array<Record<string, any>> = []
  const relayed: string[] = []
  const answer = { mode: 'ok' as Answer }
  ws.on('message', (data: Buffer) => {
    let m: Record<string, any>
    try { m = JSON.parse(data.toString()) } catch { return }
    if (m.ev === 'trigger.checked' || m.ev === 'trigger.fired') { events.push(m); return }
    if (m.ev !== 'gateway-request') return
    relayed.push(String(m.payload?.name))
    // As the server's relay answers (daemon-connection.ts): errorCode, error, and the API's answer.
    const reply = answer.mode === 'ok'
      ? { relayId: m.relayId, result: { ok: true } }
      : answer.mode === 'disk_full'
        ? { relayId: m.relayId, errorCode: 'internal', error: 'Walnut API error (507): Data disk is critically full (99% used)', api: { status: 507, code: 'disk_full' } }
        : { relayId: m.relayId, errorCode: 'hub_timeout', error: 'the Walnut server\'s own call to its API got no answer' }
    ws.send(JSON.stringify({ id: rpcId++, cmd: 'gateway-result', ...reply }))
  })
  await rpc({ ws }, { cmd: 'hello', run: 'machine-fault-test' })
  expect(await waitFor(() => fs.existsSync(path.join(daemonDir, 'agent-gateway.sock')) || undefined, 30_000)).toBe(true)
  daemon = { proc, ws, daemonDir, stateDir, events, answer, relayed }
  return daemon
}

beforeAll(() => {
  checkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-machine-fault-src-'))
  checkPath = path.join(checkDir, 'check.cjs')
  fs.writeFileSync(checkPath, CHECK)
})

afterEach(async () => {
  if (daemon) {
    try { daemon.ws.close() } catch { /* closed */ }
    if (daemon.proc.exitCode === null) {
      daemon.proc.kill('SIGKILL')
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 3000); daemon!.proc.once('exit', () => { clearTimeout(t); resolve() }) })
    }
  }
  daemon = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

const ID = 'trg-mail-1'

describe.skipIf(!BUN)('machine faults, standalone daemon (bun)', () => {
  it('a machine fault is reported as one without a strike; the script\'s own failure counts; nothing is lost', async () => {
    const d = await boot()
    const items = path.join(root, 'items.txt')
    fs.writeFileSync(items, 'm1')
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const configured = await rpc(d, {
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: ID, name: 'Mail', everyMs: 3_600_000, check: { run: `${q(process.execPath)} ${q(checkPath)} ${q(items)}`, timeoutSeconds: 30 } }] },
    })
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
    // Quiet for a moment: a run the arm itself started has reported, so the next event is ours.
    const settle = async () => {
      let n = -1
      while (n !== d.events.length) { n = d.events.length; await new Promise((r) => setTimeout(r, 800)) }
    }
    const run = async (): Promise<Record<string, any>> => {
      await settle()
      const from = d.events.length
      await rpc(d, { cmd: 'triggers.run', triggerId: ID }).catch(() => undefined)
      const ev = await waitFor(() => d.events.slice(from).find((e) => e.id === ID && !e.replay))
      expect(ev, `no event after triggers.run; events: ${JSON.stringify(d.events)}`).toBeDefined()
      // A fire is acked, as the server does, so its replay never comes back as a new event.
      if (ev!.ev === 'trigger.fired') await rpc(d, { cmd: 'triggers.ack', triggerId: ID, seq: ev!.seq })
      return ev!
    }
    // The first good run reports m1 (the arm's own run, or this one).
    await settle()
    const armed = d.events.find((e) => e.ev === 'trigger.fired' && e.id === ID)
    if (armed) await rpc(d, { cmd: 'triggers.ack', triggerId: ID, seq: armed.seq })
    const first = armed ?? await run()
    expect(first.ev, JSON.stringify(first)).toBe('trigger.fired')
    expect(first.items.map((i: { id: string }) => i.id)).toEqual(['m1'])

    // 1. The disk is full: three runs, each a machine fault, no strike.
    d.answer.mode = 'disk_full'
    fs.writeFileSync(items, 'm1,m2')
    for (let i = 0; i < 3; i++) {
      const ev = await run()
      expect(ev, JSON.stringify(ev)).toMatchObject({ ev: 'trigger.checked', outcome: 'error', fault: 'disk_full', consecutiveErrors: 0 })
      expect(ev.error).toContain('507')
    }
    const file = JSON.parse(fs.readFileSync(path.join(d.stateDir, fs.readdirSync(d.stateDir).find((f) => f.endsWith('.json'))!), 'utf8'))
    expect(file.consecutiveErrors).toBe(0)
    expect(file.lastCheck.fault).toBeUndefined()
    expect(JSON.stringify(file)).not.toContain('"fault"')

    // 2. An answer that did not come in time: the check's own to hear about, a strike.
    d.answer.mode = 'hub_timeout'
    const slow = await run()
    expect(slow).toMatchObject({ ev: 'trigger.checked', outcome: 'error', consecutiveErrors: 1 })
    expect(slow.fault).toBeUndefined()

    // 3. The machine is back, the script breaks on its own: a strike, no fault.
    d.answer.mode = 'ok'
    fs.writeFileSync(items, 'BROKEN')
    const own = await run()
    expect(own).toMatchObject({ ev: 'trigger.checked', outcome: 'error', consecutiveErrors: 2 })
    expect(own.fault).toBeUndefined()
    expect(own.error).toContain('jq: parse error')

    // 4. The check's own CLI met the 507 over HTTP and said so: a machine fault, and never relayed.
    const relayedBefore = d.relayed.length
    fs.writeFileSync(items, 'HTTP_507')
    expect(await run()).toMatchObject({ ev: 'trigger.checked', outcome: 'error', fault: 'disk_full', consecutiveErrors: 2 })
    expect(d.relayed.slice(relayedBefore).filter((n) => n === 'trigger_check_fault')).toEqual([])

    // 4b. The same run then tells of a call refused as written: relayed (the server tells its task),
    // and its answer leaves the run's fault as it is (a report is no call of the run's).
    const reportsBefore = d.relayed.length
    fs.writeFileSync(items, 'HTTP_507_THEN_400')
    expect(await run()).toMatchObject({ ev: 'trigger.checked', outcome: 'error', fault: 'disk_full', consecutiveErrors: 2 })
    expect(d.relayed.slice(reportsBefore)).toContain('trigger_check_call_refused')

    // 5. Fixed: the mail that came while the disk was full fires now.
    fs.writeFileSync(items, 'm1,m2')
    const back = await run()
    expect(back.ev, JSON.stringify(back)).toBe('trigger.fired')
    expect(back.items.map((i: { id: string }) => i.id)).toEqual(['m2'])
  }, 150_000)
})
