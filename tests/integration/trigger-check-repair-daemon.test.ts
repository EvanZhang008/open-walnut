/**
 * One bad item never fails a check run, on a REAL daemon (both twins).
 *
 * The incident (2026-10-09): a check printed one item id of 490 chars; the daemon
 * rejected the whole run as a check error five times in a row, the server stopped
 * the trigger, and the other items and the script's cursor were lost with it.
 * Now the daemon shortens the id to a stable one (head + hash), drops what it
 * cannot use, and reports the repairs as warnings on the fire and the checked event.
 *
 * What's real: the daemon process (source twin under node with its trigger sidecar
 * bundled beside it; standalone twin under bun), /bin/sh checks, the state files.
 * The Walnut server is a bare WS client. Each daemon is stopped by the pid it wrote
 * into its own temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { CHECK_ITEM_ID_MAX, shortItemId } from '../../src/providers/trigger-check-core.js'

const ROOT = path.resolve(__dirname, '../..')
const TRIGGER = 'mrep0000-a1b2'

const bunPath = (() => {
  for (const p of [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) if (p && fs.existsSync(p)) return p
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}

async function spawnDaemon(twin: 'source' | 'standalone'): Promise<Daemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-trigrep-${twin}-`))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRIGGER_REPLAY_MS: '60000',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    buildSync({
      entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'trigger-check-core.cjs'), logLevel: 'silent',
    })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(bunPath!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, `${twin} daemon`)
  return {
    proc, dir,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

function stopDaemon(d: Daemon): void {
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
}

class FakeServer {
  events: Array<Record<string, unknown>> = []
  private nextId = 1
  private waiters = new Map<number, (m: Record<string, unknown>) => void>()
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>
      if (typeof msg.ev === 'string') { this.events.push(msg); return }
      const w = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (w) { this.waiters.delete(msg.id as number); w(msg) }
    })
  }
  static async connect(port: number): Promise<FakeServer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
    return new FakeServer(ws)
  }
  cmd(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m) })
      this.ws.send(JSON.stringify({ id, ...body }))
    })
  }
  of(ev: string): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.ev === ev && e.id === TRIGGER)
  }
  close(): Promise<void> {
    return new Promise((r) => { this.ws.once('close', () => r()); this.ws.close() })
  }
}

// The real shape: a pipeline approval path that grew past the limit, plus Unicode.
const LONG_ID = `${'acme/deploy-pipeline/stage-approval/'.repeat(13)}run-42-é中`

describe.each(bunPath ? ['source', 'standalone'] as const : ['source'] as const)('a check with one bad item on the real %s daemon', (twin) => {
  let d: Daemon
  let server: FakeServer
  let outFile: string

  function print(out: Record<string, unknown>): void {
    fs.writeFileSync(outFile, JSON.stringify(out) + '\n')
  }

  beforeAll(async () => {
    d = await spawnDaemon(twin)
    outFile = path.join(d.dir, 'out.json')
    print({ fire: false })
    server = await FakeServer.connect(d.port)
    expect((await server.cmd({ cmd: 'hello' })).ok).toBe(true)
    const r = await server.cmd({
      cmd: 'triggers.configure',
      config: { version: 1, triggers: [{ id: TRIGGER, name: 'Pipeline watch', everyMs: 3_600_000, check: { run: `cat ${outFile}`, timeoutSeconds: 10 } }] },
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }, 90_000)

  afterAll(async () => {
    await server?.close().catch(() => {})
    if (d) stopDaemon(d)
  })

  const statePath = () => path.join(d.dir, 'trigger-state', `${TRIGGER}.json`)
  const state = () => JSON.parse(fs.readFileSync(statePath(), 'utf8')) as { state?: unknown; consecutiveErrors?: number; seen: Record<string, number> }

  it('trigger_test shows the repair instead of an error', async () => {
    expect(LONG_ID.length).toBeGreaterThan(CHECK_ITEM_ID_MAX)
    print({ fire: true, items: [{ id: LONG_ID }] })
    const reply = await server.cmd({ cmd: 'triggers.test', check: { run: `cat ${outFile}` } })
    const result = ((reply.data ?? reply) as { result: Record<string, any> }).result
    expect(result.ok).toBe(true)
    expect(result.error).toBeNull()
    expect(result.wouldFire).toBe(true)
    expect(result.parsed.items).toEqual([{ id: shortItemId(LONG_ID), fullId: LONG_ID }])
    expect(result.parsed.warnings[0]).toContain(`items[0].id was ${LONG_ID.length} chars`)
  })

  it('fires with the good items, the shortened one, the state and the warnings, and is not an error', async () => {
    print({ fire: true, items: [{ id: 'run-41' }, { id: LONG_ID, title: 'approve' }, { title: 'no id' }], state: { cursor: 42 } })
    expect((await server.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await waitFor(() => server.of('trigger.fired').length > 0, 20_000, 'the fire')
    const fire = server.of('trigger.fired')[0]
    expect((fire.items as Array<{ id: string }>).map((i) => i.id)).toEqual(['run-41', shortItemId(LONG_ID)])
    expect((fire.items as Array<Record<string, unknown>>)[1]).toMatchObject({ fullId: LONG_ID, title: 'approve' })
    expect(fire.warnings).toEqual([
      `items[1].id was ${LONG_ID.length} chars (over ${CHECK_ITEM_ID_MAX}); the daemon shortened it to a stable id and kept the original in "fullId"`,
      '1 item dropped, the first because items[2].id must be a non-empty string',
    ])
    await server.cmd({ cmd: 'triggers.ack', triggerId: TRIGGER, seq: fire.seq })
    const s = state()
    expect(s.state).toEqual({ cursor: 42 })
    expect(s.consecutiveErrors ?? 0).toBe(0)
    expect(Object.keys(s.seen)).toContain(shortItemId(LONG_ID))
  })

  it('the same long id next run is seen: quiet, with the warning on the checked event', async () => {
    print({ fire: true, items: [{ id: LONG_ID }], state: { cursor: 43 } })
    expect((await server.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await waitFor(() => server.of('trigger.checked').some((e) => e.reason === 'all-seen'), 20_000, 'the quiet check')
    const checked = server.of('trigger.checked').find((e) => e.reason === 'all-seen')!
    expect(checked.outcome).toBe('quiet')
    expect((checked.warnings as string[])[0]).toContain('shortened it to a stable id')
    expect(server.of('trigger.fired')).toHaveLength(1)
    expect(state().state).toEqual({ cursor: 43 })
  })

  it('output with no usable item left is still an error, and keeps the cursor', async () => {
    print({ fire: true, items: [{ id: '' }, 7], state: { cursor: 99 } })
    const before = server.of('trigger.checked').length
    expect((await server.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await waitFor(() => server.of('trigger.checked').length > before, 20_000, 'the failed check')
    const last = server.of('trigger.checked').at(-1)!
    expect(last.outcome).toBe('error')
    expect(String(last.error)).toContain('no usable item: items[0].id must be a non-empty string')
    expect(state().state).toEqual({ cursor: 43 })
  })
})
