/**
 * walnut-trigger, against a REAL daemon (docs/plan/walnut-trigger.md).
 *
 * The daemon half of a trigger is the part no unit test can prove: a clock that
 * keeps ticking, a check that runs in its own process group, state that survives
 * on disk, and a fire that must reach the trusted client at least once. So this
 * file starts the standalone twin in an isolated WALNUT_DAEMON_DIR, speaks the
 * WebSocket protocol, and asserts on the events and the state files it writes.
 *
 * What's real: the daemon, /bin/sh checks, the state files, the timers. What's
 * mocked: nothing (no Claude CLI is involved — a trigger has no session).
 *
 * The twin is launched with `bun <source>` rather than the compiled binary on
 * purpose: dist/daemon-binaries is what the production server on :3456 watches,
 * so a test must never depend on rebuilding it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { WebSocket, WebSocketServer } from 'ws'

const ROOT = path.resolve(__dirname, '../..')
const TWIN = path.join(ROOT, 'src/providers/daemon-standalone.ts')

function findBun(): string | null {
  for (const candidate of [
    process.env.BUN_PATH,
    path.join(os.homedir(), '.bun/bin/bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ]) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

const BUN = findBun()
const d = BUN ? describe : describe.skip

const DAEMON_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-daemon-trig-'))
const PORT_FILE = path.join(DAEMON_DIR, 'daemon.port')
const PID_FILE = path.join(DAEMON_DIR, 'daemon.pid')
const STATE_DIR = path.join(DAEMON_DIR, 'trigger-state')

let daemonPid: number | null = null
let port = 0
let ws: WebSocket
/** Events the daemon pushed, oldest first (never cleared: replay is a count). */
const events: Array<Record<string, unknown>> = []
let nextId = 1
const waiters = new Map<number, (reply: Record<string, unknown>) => void>()

function rpc(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve) => {
    waiters.set(id, resolve)
    ws.send(JSON.stringify({ id, ...frame }))
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const hit = pick()
    if (hit !== undefined) return hit
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}; events so far: ${JSON.stringify(events)}`)
}

const firedFor = (id: string) => events.filter((e) => e.ev === 'trigger.fired' && e.id === id)
const checkedFor = (id: string) => events.filter((e) => e.ev === 'trigger.checked' && e.id === id)

/** One trigger whose check prints a fire with the given item ids. */
function fireCheck(ids: string[]): { run: string } {
  const items = ids.map((id) => ({ id })).map((o) => JSON.stringify(o)).join(',')
  return { run: `echo '{"fire":true,"items":[${items}]}'` }
}

function readState(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${id}.json`), 'utf-8')) as Record<string, unknown>
}

/** MIN_EVERY_MS is 10s and the daemon must not be talked below it. */
const EVERY_MS = 10_000

async function startDaemon(): Promise<void> {
  // A 1.5s replay interval (production is 60s) is what makes the at-least-once
  // clock observable inside a test. Consequence for every test in this file: an
  // UNACKED fire is re-sent on each 5s tick, so a test that counts fires must ack
  // what it received first.
  const env: NodeJS.ProcessEnv = {
    ...process.env, WALNUT_DAEMON_DIR: DAEMON_DIR, WALNUT_TRIGGER_REPLAY_MS: '1500',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID
  delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
  const proc = spawn(BUN!, [TWIN, '--start'], { detached: true, stdio: 'ignore', env })
  proc.unref()

  await waitFor(() => (fs.existsSync(PORT_FILE) ? true : undefined), 30_000, 'the daemon port file')
  port = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10)
  daemonPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10)

  ws = new WebSocket(`ws://localhost:${port}`)
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })
  ws.on('message', (data: Buffer | string) => {
    const msg = JSON.parse((typeof data === 'string' ? data : data.toString())) as Record<string, unknown>
    if (typeof msg.ev === 'string') { events.push(msg); return }
    const waiter = typeof msg.id === 'number' ? waiters.get(msg.id) : undefined
    if (waiter) { waiters.delete(msg.id as number); waiter(msg) }
  })
}

d('walnut-trigger on a real daemon', () => {
  beforeAll(startDaemon, 45_000)

  afterAll(async () => {
    try { ws?.close() } catch { /* already gone */ }
    // Only the pid this file spawned, and gracefully: the daemon's own cleanup
    // stops the trigger clock and releases its dir.
    if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM') } catch { /* already exited */ } }
    await sleep(500)
    try { fs.rmSync(DAEMON_DIR, { recursive: true, force: true }) } catch { /* best effort */ }
    try { fs.rmSync(`${DAEMON_DIR}-streams`, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('advertises triggers-v1', async () => {
    const hello = await rpc({ cmd: 'hello' })
    expect(hello.ok).toBe(true)
    expect(hello.capabilities as string[]).toContain('triggers-v1')
  })

  it('triggers.test runs the check, judges it, and writes NO state', async () => {
    const reply = await rpc({ cmd: 'triggers.test', check: fireCheck(['a']) })
    expect(reply.ok).toBe(true)
    const result = reply.result as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, exitCode: 0, error: null, wouldFire: true, newItemCount: 1 })
    expect((result.parsed as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual(['a'])
    expect(result.stdoutTail as string).toContain('"fire":true')
    // The Test button must never teach the dedup set anything.
    expect(fs.existsSync(STATE_DIR)).toBe(false)
  })

  it('a check error in triggers.test is reported, not guessed at', async () => {
    const reply = await rpc({ cmd: 'triggers.test', check: { run: 'echo not-json' } })
    const result = (reply.result as Record<string, unknown>)
    expect(result.ok).toBe(false)
    expect(result.error as string).toContain('not JSON')
    expect(result.wouldFire).toBe(false)
  })

  // A test is arbitrary shell on this host with no state to serialize it, so the
  // ceiling is all that stands between an impatient form and a pile of process
  // groups. Four slow tests hold every slot; the fifth is turned away.
  it('a fifth concurrent triggers.test is refused', async () => {
    const slow = { run: 'sleep 2; echo \'{"fire":false}\'' }
    const replies = await Promise.all([1, 2, 3, 4, 5].map(() => rpc({ cmd: 'triggers.test', check: slow })))
    const refused = replies.filter((r) => r.ok === false)
    expect(refused.length, 'exactly one of the five is over the ceiling').toBe(1)
    expect(refused[0].error).toBe('triggers.test: too many concurrent tests (max 4)')
    // The slots are released afterwards, so the next press of the button works.
    expect(await rpc({ cmd: 'triggers.test', check: { run: 'echo \'{"fire":false}\'' } })).toMatchObject({ ok: true })
    expect(fs.existsSync(STATE_DIR), 'a refused or served test still writes no state').toBe(false)
  }, 30_000)

  it('configure arms the set, the clock fires it once, and ack clears the pending fire', async () => {
    const configured = await rpc({
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: 't1', name: 'T1', everyMs: EVERY_MS, check: fireCheck(['a', 'b']) }] },
    })
    expect(configured).toMatchObject({ ok: true, applied: true, changed: true, count: 1 })

    const fire = await waitFor(() => firedFor('t1')[0], 20_000, 'the first trigger.fired')
    expect(fire.seq).toBe(1)
    expect((fire.items as Array<{ id: string }>).map((i) => i.id)).toEqual(['a', 'b'])
    expect(typeof fire.nextRunAtMs).toBe('number')

    // At-least-once: the fire is on disk until the server acks it.
    expect((readState('t1').pendingFires as unknown[]).length).toBe(1)
    expect(await rpc({ cmd: 'triggers.ack', triggerId: 't1', seq: 1 })).toMatchObject({ ok: true, acked: true })
    expect((readState('t1').pendingFires as unknown[]).length).toBe(0)
    // A second ack of the same seq is a no-op, not an error (redelivery is normal).
    expect(await rpc({ cmd: 'triggers.ack', triggerId: 't1', seq: 1 })).toMatchObject({ acked: false })
  }, 40_000)

  // (epoch, seq) is the server's dedup key. `seq` restarts at 0 whenever a state
  // file is recreated, so without the epoch the server's high-water mark would
  // swallow the first fires of a fresh file as replays.
  it('a fire carries a 12-hex epoch, the same one its state file holds', () => {
    const fire = firedFor('t1')[0]
    expect(fire.epoch as string).toMatch(/^[0-9a-f]{12}$/)
    expect(readState('t1').epoch).toBe(fire.epoch)
  })

  it('the same items on a later run are quiet, and re-pushing the same set replays nothing', async () => {
    const before = firedFor('t1').length
    const beforeChecked = checkedFor('t1').length
    // Run now rather than waiting out the cadence: same path, same state. The reply
    // only says the run started; the outcome arrives as an event.
    expect(await rpc({ cmd: 'triggers.run', triggerId: 't1' }))
      .toMatchObject({ ok: true, ran: true, started: true })
    const quiet = await waitFor(() => checkedFor('t1').slice(beforeChecked)[0], 10_000, 'a quiet trigger.checked')
    expect(quiet).toMatchObject({ outcome: 'quiet', reason: 'all-seen' })

    const again = await rpc({
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: 't1', name: 'T1', everyMs: EVERY_MS, check: fireCheck(['a', 'b']) }] },
    })
    expect(again).toMatchObject({ changed: false, count: 1 })
    await sleep(500)
    expect(firedFor('t1').length, 'an acked fire must not be replayed').toBe(before)
  }, 30_000)

  it('refuses the whole payload when one trigger is invalid, and keeps the armed set', async () => {
    const reply = await rpc({
      cmd: 'triggers.configure',
      config: {
        version: 1,
        triggers: [
          { id: 't1', name: 'T1', everyMs: EVERY_MS, check: fireCheck(['a', 'b']) },
          { id: 'too-fast', everyMs: 5, check: { run: 'true' } },
        ],
      },
    })
    expect(reply.ok).toBe(false)
    expect(reply.error as string).toContain('triggers.configure: invalid config: ')
    expect(fs.existsSync(path.join(STATE_DIR, 't1.json')), 't1 stayed armed').toBe(true)
    expect(await rpc({ cmd: 'triggers.configure', config: { version: 2, triggers: [] } }))
      .toMatchObject({ ok: false })
  })

  it('a check that outlives its timeout is killed with its whole process group', async () => {
    const configured = await rpc({
      cmd: 'triggers.configure',
      config: {
        version: 1,
        triggers: [
          { id: 't1', name: 'T1', everyMs: EVERY_MS, check: fireCheck(['a', 'b']) },
          // The sleep is the pipeline's tail: killing only /bin/sh would leave it.
          { id: 'slow', name: 'Slow', everyMs: EVERY_MS, check: { run: 'sleep 30 | cat', timeoutSeconds: 1 } },
        ],
      },
    })
    expect(configured).toMatchObject({ changed: true, count: 2 })

    const errored = await waitFor(() => checkedFor('slow')[0], 20_000, "the slow check's error")
    expect(errored).toMatchObject({ outcome: 'error', consecutiveErrors: 1 })
    expect(errored.error as string).toContain('timed out')
    expect(errored.durationMs as number).toBeLessThan(5_000)
    expect((readState('slow').consecutiveErrors as number)).toBeGreaterThan(0)

    // Nothing from that group may outlive the deadline.
    const survivors = execFileSync('/bin/sh', ['-c', 'ps -Ao command | grep -c "[s]leep 30 | cat" || true'])
      .toString().trim()
    expect(survivors).toBe('0')
  }, 40_000)

  // The reply must not wait for the check: a 90s check under the caller's 60s RPC
  // deadline reported an error to the user while the fire landed anyway.
  it('triggers.run answers at once and the fire follows when the slow check ends', async () => {
    const check = { run: 'sleep 3; echo \'{"fire":true,"items":[{"id":"s1"}]}\'', timeoutSeconds: 20 }
    await rpc({
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: 'slowfire', name: 'Slow fire', everyMs: EVERY_MS, check }] },
    })
    const startedAt = Date.now()
    const reply = await rpc({ cmd: 'triggers.run', triggerId: 'slowfire' })
    const replyMs = Date.now() - startedAt
    expect(reply).toMatchObject({ ok: true, ran: true, started: true })
    expect(replyMs, 'the reply must not wait for the check').toBeLessThan(1_000)
    expect(firedFor('slowfire').length, 'nothing has fired yet when the reply arrives').toBe(0)
    // The refusal survives the change: a second run while one is in flight is
    // skipped, never queued.
    expect(await rpc({ cmd: 'triggers.run', triggerId: 'slowfire' })).toMatchObject({ ran: false, reason: 'running' })

    const fire = await waitFor(() => firedFor('slowfire')[0], 20_000, "the slow check's fire")
    expect((fire.items as Array<{ id: string }>).map((i) => i.id)).toEqual(['s1'])
    expect(await rpc({ cmd: 'triggers.ack', triggerId: 'slowfire', seq: fire.seq as number })).toMatchObject({ acked: true })
  }, 60_000)

  // A fire used to go to the FIRST trusted client only, so a second window (or a
  // server whose fresh socket arrived while the old one drained) never saw it.
  it('two trusted clients both receive the same fire', async () => {
    const second = new WebSocket(`ws://localhost:${port}`)
    const seen: Array<Record<string, unknown>> = []
    try {
      await new Promise<void>((res, rej) => { second.on('open', () => res()); second.on('error', rej) })
      second.on('message', (data: Buffer | string) => {
        seen.push(JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>)
      })
      await rpc({
        cmd: 'triggers.configure',
        config: { version: 1, triggers: [{ id: 'fanout', name: 'Fanout', everyMs: EVERY_MS, check: fireCheck(['f1']) }] },
      })
      expect(await rpc({ cmd: 'triggers.run', triggerId: 'fanout' })).toMatchObject({ started: true })

      const mine = await waitFor(() => firedFor('fanout')[0], 20_000, "the first client's fire")
      const theirs = await waitFor(
        () => seen.find((m) => m.ev === 'trigger.fired' && m.id === 'fanout'),
        10_000, "the second client's copy of the same fire",
      )
      // Same (epoch, seq) on both sockets: the daemon fans out, the server dedups.
      expect({ epoch: theirs.epoch, seq: theirs.seq }).toEqual({ epoch: mine.epoch, seq: mine.seq })
      expect(await rpc({ cmd: 'triggers.ack', triggerId: 'fanout', seq: mine.seq as number })).toMatchObject({ acked: true })
    } finally {
      try { second.close() } catch { /* already gone */ }
    }
  }, 60_000)

  // The configure replay only covers a reconnect. A server that stayed connected
  // but lost the event (a restart mid-frame, a dropped job write) used to wait for
  // a configure that may never come.
  it('an unacked fire is replayed on the daemon clock, not only after a configure', async () => {
    await rpc({
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: 'noack', name: 'No ack', everyMs: EVERY_MS, check: fireCheck(['n1']) }] },
    })
    const first = await waitFor(() => firedFor('noack')[0], 20_000, "the noack trigger's first fire")
    expect(first.replay, 'the first delivery is not a replay').toBeUndefined()
    // Nothing is acked and no configure is sent, so only the replay clock
    // (WALNUT_TRIGGER_REPLAY_MS in startDaemon) can bring this fire back.
    const again = await waitFor(() => firedFor('noack').find((e) => e.replay === true), 20_000, 'the replayed fire')
    expect({ epoch: again.epoch, seq: again.seq }).toEqual({ epoch: first.epoch, seq: first.seq })

    expect(await rpc({ cmd: 'triggers.ack', triggerId: 'noack', seq: first.seq as number })).toMatchObject({ acked: true })
    const afterAck = firedFor('noack').length
    await sleep(8_000)
    expect(firedFor('noack').length, 'an acked fire is never replayed again').toBe(afterAck)
  }, 90_000)

  it('an empty set disarms every trigger but KEEPS its state file', async () => {
    const cleared = await rpc({ cmd: 'triggers.configure', config: { version: 1, triggers: [] } })
    expect(cleared).toMatchObject({ ok: true, applied: true, changed: true, count: 0 })
    // Deleting state on disarm is what used to destroy `seen`, the script's cursor
    // and every unacked fire on a disable-then-enable (and on a foreign push that
    // briefly carried an empty set). Files age out by mtime instead.
    expect(fs.existsSync(path.join(STATE_DIR, 't1.json'))).toBe(true)
    expect(fs.existsSync(path.join(STATE_DIR, 'slow.json'))).toBe(true)
    expect(await rpc({ cmd: 'triggers.run', triggerId: 't1' })).toMatchObject({ ok: false })
    // The armed-set file itself is rewritten, not just forgotten.
    const persisted = JSON.parse(fs.readFileSync(path.join(DAEMON_DIR, 'triggers.json'), 'utf-8')) as { triggers: unknown[] }
    expect(persisted.triggers).toEqual([])
  }, 20_000)

  it('a disable then re-enable keeps the dedup set, the state file and its epoch', async () => {
    const armed = { id: 'keeper', name: 'Keeper', everyMs: EVERY_MS, check: fireCheck(['k1']) }
    await rpc({ cmd: 'triggers.configure', config: { version: 1, triggers: [armed] } })
    const fire = await waitFor(() => firedFor('keeper')[0], 20_000, "the keeper's first fire")
    expect(await rpc({ cmd: 'triggers.ack', triggerId: 'keeper', seq: fire.seq as number })).toMatchObject({ acked: true })
    const epoch = readState('keeper').epoch as string

    expect(await rpc({ cmd: 'triggers.configure', config: { version: 1, triggers: [] } })).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(STATE_DIR, 'keeper.json')), 'state survives being disarmed').toBe(true)
    expect(await rpc({ cmd: 'triggers.configure', config: { version: 1, triggers: [armed] } })).toMatchObject({ ok: true })

    const beforeChecked = checkedFor('keeper').length
    expect(await rpc({ cmd: 'triggers.run', triggerId: 'keeper' })).toMatchObject({ ran: true, started: true })
    const quiet = await waitFor(() => checkedFor('keeper').slice(beforeChecked)[0], 15_000, 'the re-enabled check')
    expect(quiet).toMatchObject({ outcome: 'quiet', reason: 'all-seen' })
    expect(firedFor('keeper').length, 'a re-enabled trigger must not re-deliver what it already sent').toBe(1)
    expect(readState('keeper').epoch, 'the epoch belongs to the file, not to the arming').toBe(epoch)
  }, 90_000)

  it('a bridge-origin client is refused: a check is arbitrary shell on this host', async () => {
    // Only the daemon's OWN outbound dial marks a socket as bridge-origin, so a
    // real bridge is the only honest way to test the refusal: stand up a fake
    // cloud endpoint, let the daemon dial it, and speak down that socket.
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    try {
      await new Promise<void>((res) => fake.on('listening', () => res()))
      const bridgePort = (fake.address() as { port: number }).port
      const dialed = new Promise<WebSocket>((resolve) => fake.on('connection', (socket) => resolve(socket as unknown as WebSocket)))
      expect(await rpc({
        cmd: 'bridge.configure', enabled: true, token: 'test-token', hostAlias: 'test-host',
        url: `ws://127.0.0.1:${bridgePort}/bridge`,
      })).toMatchObject({ ok: true })

      const socket = await dialed
      const replies: Array<Record<string, unknown>> = []
      socket.on('message', (data: Buffer | string) => {
        replies.push(JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>)
      })
      for (const frame of [
        { id: 1, cmd: 'triggers.configure', config: { version: 1, triggers: [] } },
        { id: 2, cmd: 'triggers.test', check: { run: 'echo hi' } },
        { id: 3, cmd: 'triggers.run', triggerId: 't1' },
        { id: 4, cmd: 'triggers.ack', triggerId: 't1', seq: 1 },
      ]) socket.send(JSON.stringify(frame))

      const refusals = await waitFor(
        () => (replies.filter((r) => typeof r.id === 'number').length === 4 ? replies : undefined),
        10_000, 'four bridge refusals',
      )
      for (const reply of refusals.filter((r) => typeof r.id === 'number')) {
        expect(reply.ok).toBe(false)
        expect(reply.error as string).toContain('command not permitted over bridge: triggers.')
      }
    } finally {
      await rpc({ cmd: 'bridge.configure', enabled: false })
      fake.close()
    }
  }, 30_000)

  // The reason the set is on disk at all: when the SERVER is what died, the
  // checks must keep polling, and the dedup set must not restart from zero (a
  // reloaded trigger with a forgotten `seen` would re-fire everything it had
  // already delivered).
  it('a restarted daemon re-arms the set and keeps each trigger dedup state', async () => {
    await rpc({
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: 'survivor', name: 'Survivor', everyMs: EVERY_MS, check: fireCheck(['c']) }] },
    })
    const fire = await waitFor(() => firedFor('survivor')[0], 20_000, "the survivor's first fire")
    expect(await rpc({ cmd: 'triggers.ack', triggerId: 'survivor', seq: fire.seq as number })).toMatchObject({ acked: true })

    const oldPid = daemonPid!
    ws.close()
    process.kill(oldPid, 'SIGTERM')
    await waitFor(() => {
      try { process.kill(oldPid, 0); return undefined } catch { return true }
    }, 15_000, 'the old daemon to exit')
    waiters.clear()
    await startDaemon()
    expect(daemonPid).not.toBe(oldPid)

    // Armed again without any push (triggers.json), and item c is still seen
    // (trigger-state/survivor.json) — so this run is quiet, not a re-fire.
    const beforeChecked = checkedFor('survivor').length
    expect(await rpc({ cmd: 'triggers.run', triggerId: 'survivor' })).toMatchObject({ ok: true, ran: true, started: true })
    const quiet = await waitFor(() => checkedFor('survivor').slice(beforeChecked)[0], 15_000, 'the re-armed check')
    expect(quiet).toMatchObject({ outcome: 'quiet', reason: 'all-seen' })
    expect(firedFor('survivor').length).toBe(1)
  }, 60_000)

  // The epoch is minted with the state FILE, so a restart that re-reads it must
  // keep it: a new epoch would tell the server to start its numbering over, and a
  // lost one would let the old high-water mark swallow the next fires.
  it('the epoch survives a restart, and the next fire continues its numbering', async () => {
    const epoch = readState('survivor').epoch as string
    expect(epoch).toMatch(/^[0-9a-f]{12}$/)
    await rpc({
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: 'survivor', name: 'Survivor', everyMs: EVERY_MS, check: fireCheck(['c', 'd']) }] },
    })
    expect(await rpc({ cmd: 'triggers.run', triggerId: 'survivor' })).toMatchObject({ started: true })
    const fire = await waitFor(() => firedFor('survivor')[1], 20_000, "the survivor's post-restart fire")
    expect(fire.epoch, 'the same epoch as before the restart').toBe(epoch)
    expect(fire.seq, 'seq continues rather than restarting at 1').toBe(2)
    expect((fire.items as Array<{ id: string }>).map((i) => i.id), 'only the new item').toEqual(['d'])
    expect(await rpc({ cmd: 'triggers.ack', triggerId: 'survivor', seq: 2 })).toMatchObject({ acked: true })
  }, 60_000)
})
