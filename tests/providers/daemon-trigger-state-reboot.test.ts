/**
 * A trigger's memory outlives a reboot, against BOTH real daemon twins.
 *
 * 2026-10-06: the Mac rebooted, macOS emptied /tmp, and with it the production
 * daemon's trigger-state dir. The error-card watch then re-reported all eight cards
 * it had already reported, ran ten hours early, and its script's own state (the day
 * its week started) began again. The production daemon now keeps that memory under
 * HOME; this file plays the production layout with two dirs: a runtime dir that
 * the "reboot" deletes whole, and the durable dir (WALNUT_TRIGGER_STATE_DIR, the
 * test stand-in for ~/.open-walnut/tmp/trigger-state) that it does not touch.
 *
 * What's real: the standalone twin under bun, the source twin (getDaemonSource)
 * under node with its trigger sidecar built by bun, a node check script, the state
 * files, the timers. What's mocked: nothing (a trigger has no session).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(__dirname, '../..')

function findBun(): string | null {
  // BUN_INSTALL first: the test setup swaps HOME for a fake one and points this at the real bun.
  for (const candidate of [process.env.BUN_PATH, process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

const BUN = findBun()
const d = BUN ? describe : describe.skip
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

for (const twin of ['standalone', 'source'] as const) {
  d(`trigger memory across a reboot (${twin} twin)`, () => {
    const BASE = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-trig-reboot-${twin}-`))
    /** What /tmp/open-walnut is in production: gone after a reboot. */
    const RUN_DIR = path.join(BASE, 'run')
    /** What ~/.open-walnut/tmp/trigger-state is in production: survives it. */
    const DURABLE = path.join(BASE, 'durable')
    const LEGACY = path.join(RUN_DIR, 'trigger-state')
    const BIN = path.join(BASE, 'bin')
    const FEED = path.join(BASE, 'feed.txt')
    const CHECK = path.join(BASE, 'check.cjs')

    let daemonPid: number | null = null
    let ws: WebSocket
    const events: Array<Record<string, unknown>> = []
    let nextId = 1
    const waiters = new Map<number, (reply: Record<string, unknown>) => void>()

    async function waitFor<T>(pick: () => T | undefined, ms: number, what: string): Promise<T> {
      const start = Date.now()
      while (Date.now() - start < ms) {
        const hit = pick()
        if (hit !== undefined) return hit
        await sleep(150)
      }
      throw new Error(`timed out waiting for ${what}; events so far: ${JSON.stringify(events)}`)
    }

    function rpc(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
      const id = nextId++
      return new Promise((resolve) => {
        waiters.set(id, resolve)
        ws.send(JSON.stringify({ id, ...frame }))
      })
    }

    /** One fire per (epoch, seq): a replay repeats both, a state file that started over repeats only seq. */
    const firesOf = (id: string) => [...new Map(events.filter((e) => e.ev === 'trigger.fired' && e.id === id).map((e) => [`${e.epoch}:${e.seq}`, e])).values()]
    const checksOf = (id: string) => events.filter((e) => e.ev === 'trigger.checked' && e.id === id)
    const itemIds = (fire: Record<string, unknown>) => (fire.items as Array<{ id: string }>).map((i) => i.id)
    const readState = (dir: string, id: string) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')) as Record<string, unknown>

    async function startDaemon(): Promise<void> {
      const env: NodeJS.ProcessEnv = {
        ...process.env, WALNUT_DAEMON_DIR: RUN_DIR, WALNUT_TRIGGER_STATE_DIR: DURABLE, WALNUT_TRIGGER_REPLAY_MS: '1500',
      }
      delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID
      delete env.VITEST_POOL_ID; delete env.OPEN_WALNUT_HOME
      const [cmd, args] = twin === 'standalone'
        ? [BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start']]
        : [process.execPath, [path.join(BIN, 'daemon.cjs'), '--start']]
      const proc = spawn(cmd, args, { detached: true, stdio: 'ignore', env })
      proc.unref()
      const portFile = path.join(RUN_DIR, 'daemon.port')
      await waitFor(() => (fs.existsSync(portFile) ? true : undefined), 30_000, 'the daemon port file')
      const port = parseInt(fs.readFileSync(portFile, 'utf-8').trim(), 10)
      daemonPid = parseInt(fs.readFileSync(path.join(RUN_DIR, 'daemon.pid'), 'utf-8').trim(), 10)
      ws = new WebSocket(`ws://localhost:${port}`)
      await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej) })
      ws.on('message', (data: Buffer | string) => {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as Record<string, unknown>
        if (typeof msg.ev === 'string') { events.push(msg); return }
        const waiter = typeof msg.id === 'number' ? waiters.get(msg.id) : undefined
        if (waiter) { waiters.delete(msg.id as number); waiter(msg) }
      })
    }

    async function stopDaemon(): Promise<void> {
      const pid = daemonPid!
      ws.close()
      process.kill(pid, 'SIGTERM')
      await waitFor(() => { try { process.kill(pid, 0); return undefined } catch { return true } }, 15_000, 'the daemon to exit')
      waiters.clear()
      daemonPid = null
    }

    /** The server's push at connect: the same set, every time. */
    const configure = (ids: string[]) => rpc({
      cmd: 'triggers.configure',
      config: { version: 1, triggers: ids.map((id) => ({ id, name: id, everyMs: 3_600_000, check: { run: `${JSON.stringify(process.execPath)} ${JSON.stringify(CHECK)}` } })) },
    })

    /** Run now and wait for the outcome event (the clock's own first run may be in flight). */
    async function runOnce(id: string): Promise<void> {
      for (;;) {
        const before = checksOf(id).length + firesOf(id).length
        const reply = await rpc({ cmd: 'triggers.run', triggerId: id })
        await waitFor(() => (checksOf(id).length + firesOf(id).length > before ? true : undefined), 15_000, `the ${id} check`)
        if (reply.started === true) return
      }
    }

    beforeAll(async () => {
      if (twin === 'source') {
        fs.mkdirSync(BIN, { recursive: true })
        fs.writeFileSync(path.join(BIN, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
        // The source twin answers "triggers unsupported" without its sidecar.
        execFileSync(BUN!, ['build', '--target=node', '--format=cjs', '--outfile', path.join(BIN, 'trigger-check-core.cjs'),
          path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')], { stdio: 'ignore' })
      }
      // A check like the error-card watch: every line of the feed is an item, and the
      // script keeps the moment it first ran in its own state.
      fs.writeFileSync(CHECK, [
        "const fs = require('fs')",
        "let raw = ''",
        "process.stdin.on('data', (c) => { raw += c }).on('end', () => {",
        "  const input = JSON.parse(raw || '{}')",
        "  const startedAt = (input.state && input.state.startedAt) || Date.now()",
        `  const ids = fs.readFileSync(${JSON.stringify(FEED)}, 'utf8').split('\\n').filter(Boolean)`,
        "  console.log(JSON.stringify({ fire: ids.length > 0, items: ids.map((id) => ({ id })), state: { startedAt } }))",
        '})',
      ].join('\n') + '\n')
      // A daemon from before the move left this file in the runtime dir.
      fs.mkdirSync(LEGACY, { recursive: true })
      fs.writeFileSync(path.join(LEGACY, 'upgraded.json'), JSON.stringify({
        version: 1, epoch: 'abcdef012345', seen: { x: Date.now() }, state: { startedAt: 1_000 },
        budget: { used: 0, atMs: Date.now() }, pendingFires: [], consecutiveErrors: 0, seq: 3,
      }))
      fs.writeFileSync(FEED, 'x\ny\n')
      await startDaemon()
      const hello = await rpc({ cmd: 'hello' })
      expect(hello.capabilities as string[]).toContain('triggers-v1')
    }, 60_000)

    afterAll(async () => {
      try { ws?.close() } catch { /* already gone */ }
      if (daemonPid) { try { process.kill(daemonPid, 'SIGTERM') } catch { /* already exited */ } }
      await sleep(500)
      for (const dir of [BASE, `${RUN_DIR}-streams`]) {
        try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
      }
    })

    it('a file the old daemon left in the runtime dir is moved, and the upgrade reports only what is new', async () => {
      expect(await configure(['upgraded'])).toMatchObject({ ok: true, count: 1 })
      expect(fs.existsSync(path.join(DURABLE, 'upgraded.json')), 'moved at arming').toBe(true)
      expect(fs.existsSync(path.join(LEGACY, 'upgraded.json')), 'and gone from the old dir').toBe(false)

      await runOnce('upgraded')
      const [fire] = firesOf('upgraded')
      expect(itemIds(fire), 'x was reported before the upgrade').toEqual(['y'])
      expect(fire.epoch, 'the old numbering continues').toBe('abcdef012345')
      expect(fire.seq).toBe(4)
      expect(await rpc({ cmd: 'triggers.ack', triggerId: 'upgraded', seq: 4 })).toMatchObject({ acked: true })
      expect((readState(DURABLE, 'upgraded').state as { startedAt: number }).startedAt, 'the script kept its own state').toBe(1_000)
    }, 60_000)

    it('a reboot that empties the runtime dir forgets nothing: no re-fire, same epoch, same script state', async () => {
      fs.writeFileSync(FEED, 'a\nb\n')
      expect(await configure(['watch'])).toMatchObject({ ok: true })
      await runOnce('watch')
      const [first] = firesOf('watch')
      expect(itemIds(first)).toEqual(['a', 'b'])
      expect(await rpc({ cmd: 'triggers.ack', triggerId: 'watch', seq: first.seq as number })).toMatchObject({ acked: true })
      // Read from wherever it is, so a daemon that still writes the runtime dir fails
      // on the re-fire below (the user's symptom), not on a missing file.
      const stateDir = fs.existsSync(path.join(DURABLE, 'watch.json')) ? DURABLE : LEGACY
      const before = readState(stateDir, 'watch')

      // The reboot: the daemon stops and its whole runtime dir is gone, triggers.json included.
      await stopDaemon()
      fs.rmSync(RUN_DIR, { recursive: true, force: true })
      await startDaemon()
      expect(await configure(['watch'])).toMatchObject({ ok: true, count: 1 })

      await runOnce('watch')
      expect(checksOf('watch').at(-1), 'nothing it reported is reported again').toMatchObject({ outcome: 'quiet', reason: 'all-seen' })
      expect(firesOf('watch')).toHaveLength(1)
      expect(stateDir, 'the memory never lived in the runtime dir').toBe(DURABLE)
      const after = readState(DURABLE, 'watch')
      expect(after.epoch).toBe(before.epoch)
      expect((after.state as { startedAt: number }).startedAt, 'the week the script counts did not start over')
        .toBe((before.state as { startedAt: number }).startedAt)

      // And the next new item is the only thing reported, numbered after the old fires.
      fs.writeFileSync(FEED, 'a\nb\nc\n')
      await runOnce('watch')
      const second = firesOf('watch')[1]
      expect(itemIds(second)).toEqual(['c'])
      expect(second.epoch).toBe(before.epoch)
      expect(second.seq).toBe((first.seq as number) + 1)
      expect(await rpc({ cmd: 'triggers.ack', triggerId: 'watch', seq: second.seq as number })).toMatchObject({ acked: true })
    }, 90_000)
  })
}
