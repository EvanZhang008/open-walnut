/**
 * Two host aliases of one daemon, through the REAL server and a REAL daemon (source twin,
 * with its trigger sidecar): one armed set for both, whichever links are up.
 *
 * 2026-11-15: a machine joined the host network as `<name>-net` beside its SSH row. Both links
 * reached the same daemon, which keeps ONE set per Walnut, and the net link's push of its own
 * empty set replaced the SSH row's 78 triggers. Here:
 *   1. a routine checks on the SSH alias every 10 s; the net alias then connects to the same
 *      daemon: the routine stays armed and the daemon keeps checking it on its own clock, and a
 *      check and a clock routine of the net alias join the set (the clock held as the net alias's);
 *   2. the server restarts with only the net link back (the SSH one never comes): everything stays
 *      armed and the SSH routine keeps checking;
 *   3. the server restarts with only the SSH link back: the same, the net alias's clock included.
 * The two links are two pooled connections to one daemon (two URLs of its one port), as two
 * config rows reach it. No CLI runs: the clock routine is hourly, and only its placement is looked at.
 * Isolation: mock constants (temp WALNUT_HOME), a temp daemon dir, the daemon killed by the pid
 * it wrote there.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { buildSync } from 'esbuild'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-same-daemon-e2e'))
// The SSH row is config only: no path of this server may reach a real host over ssh (a boot-start
// preflight, a session or clock look-up of a host). Every `ssh` the server spawns runs `false`
// instead, so it fails at once as an unreachable host does; the daemon is reached by its direct
// links alone. Everything else spawns as it is (the daemon twin itself included).
const sshCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const isSsh = (cmd: unknown) => typeof cmd === 'string' && /(^|\/)ssh$/.test(cmd)
  const swap = <A extends unknown[]>(fn: (cmd: string, ...rest: A) => unknown) => (cmd: string, ...rest: A) => {
    if (!isSsh(cmd)) return fn(cmd, ...rest)
    sshCalls.n++
    // Its arguments go; its options and callback stay, so the caller sees an ordinary failed ssh.
    const after = Array.isArray(rest[0]) ? rest.slice(1) : rest
    return fn('false', ...([[], ...after] as unknown as A))
  }
  const stubbed = {
    spawn: swap(real.spawn as never),
    execFile: swap(real.execFile as never),
    spawnSync: swap(real.spawnSync as never),
    execFileSync: swap(real.execFileSync as never),
  }
  return { ...real, ...stubbed, default: { ...real, ...stubbed } }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { walnutScopeDir } from '../helpers/walnut-scope-dir.js'
import { disconnectAllDaemons, getDirectDaemonConnection } from '../../src/providers/daemon-connection.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { readHostProfile } from '../../src/core/hosts/host-profile.js'
import { __setSshResolverForTest, _resetSameDaemonRecordForTest } from '../../src/core/hosts/same-daemon-record.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SSH = 'studio'
const NET = 'studio-net'

let dir = ''
let daemon: ChildProcess | null = null
let daemonPid = 0
let daemonPort = 0
let port = 0
let itemsFile = ''
let taskId = ''
let sshJob = ''
let netJob = ''
let clockJob = ''
const SID = 'feedface-9999-4999-8999-999999999999'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, any> }
}

/** The defs the daemon holds armed for this Walnut, from its own file. */
function armedDefs(): Array<{ id: string; clock?: unknown }> {
  try {
    return JSON.parse(fs.readFileSync(path.join(walnutScopeDir(dir, WALNUT_HOME), 'triggers.json'), 'utf8')).triggers as Array<{ id: string; clock?: unknown }>
  } catch { return [] }
}
const armed = (): string[] => armedDefs().map((t) => t.id)

/** Each alias as a link of its own to the one daemon (two pool keys, one port). */
const urlOf = (alias: string) => alias === SSH ? `ws://127.0.0.1:${daemonPort}` : `ws://127.0.0.1:${daemonPort}/`

async function bootServer(links: string[]): Promise<void> {
  const server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  for (const alias of links) await link(alias)
}

/** The link for an alias, once its push (the whole set, compiled now) went out. */
async function link(alias: string): Promise<void> {
  const conn = await getDirectDaemonConnection(alias, urlOf(alias))
  await conn.pushTriggersNow()
}

/** The server stops, and its links and pool with it: the next boot starts with nothing in memory. */
async function stopAll(): Promise<void> {
  await stopServer()
  disconnectAllDaemons()
  _resetSameDaemonRecordForTest()
}

const lastCheckAt = async (jobId: string): Promise<number> => (await api('GET', `/api/routines/${jobId}`)).json.job?.state?.lastCheck?.atMs ?? 0

/** The daemon checks the routine again on its own 10 s clock, after `since` (nobody asks it to). */
async function checksOnItsOwn(jobId: string, since: number): Promise<void> {
  await waitFor(async () => (await lastCheckAt(jobId)) > since, 45_000, `a check of ${jobId} after ${new Date(since).toISOString()}`)
}

const routine = (name: string, host: string) => ({
  name,
  schedule: { kind: 'every', everyMs: 10_000 },
  check: { run: `cat ${itemsFile}`, cwd: dir, host },
  executor: { type: 'session', config: { target: taskId, prompt: 'Read what changed.' } },
})

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-samedaemon-e2e-'))
  itemsFile = path.join(dir, 'items.json')
  fs.writeFileSync(itemsFile, JSON.stringify({ fire: false }) + '\n')
  const script = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
  buildSync({
    entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'trigger-check-core.cjs'), logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRIGGER_REPLAY_MS: '60000',
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  daemon = spawn(SOURCE_TWIN.file, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  if (process.env.DEBUG_DAEMON) daemon.stderr?.on('data', (b) => process.stderr.write(b))
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, 'the daemon')
  daemonPort = parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10)
  daemonPid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)

  // ssh -G of the rows' names, without the real ~/.ssh: each resolves to itself.
  __setSshResolverForTest(async (name) => ({ hostname: name, port: 22, user: 'me' }))
  await bootServer([])
  // The two rows of one machine: its SSH row, and the row it joined the host network with.
  await updateConfig({
    hosts: {
      [SSH]: { hostname: 'studio.example' },
      [NET]: { hostname: 'studio.walnut-net.invalid', transport: 'net', endpoint: 'c'.repeat(64) },
    },
  } as never)
  const created = await api('POST', '/api/tasks', { title: 'Watch the queue', project: 'Acme' })
  expect(created.status, JSON.stringify(created.json)).toBeLessThan(300)
  taskId = created.json.task.id
  // The task's session runs on the net alias: a clock routine of that task is the net alias's.
  await createSessionRecord(SID, taskId, 'Acme', dir, { host: NET, title: 'Queue', initialProcessStatus: 'idle' } as never)
}, 120_000)

afterAll(async () => {
  try { await stopServer() } catch { /* best effort */ }
  disconnectAllDaemons()
  __setSshResolverForTest(null)
  if (daemonPid > 1) { try { process.kill(daemonPid, 'SIGTERM') } catch { /* gone */ } }
  try { daemon?.kill('SIGTERM') } catch { /* gone */ }
  // Its files go only once the daemon (the pid it wrote) is gone.
  await waitFor(() => { try { process.kill(daemonPid, 0); return false } catch { return true } }, 15_000, 'the daemon to exit').catch(() => undefined)
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe('two aliases of one daemon keep one armed set', () => {
  it('the net alias connecting to the same daemon keeps the SSH routine armed and checking, and adds its own', async () => {
    await link(SSH)
    const ssh = await api('POST', '/api/routines', routine('SSH watch', SSH))
    expect(ssh.status, JSON.stringify(ssh.json)).toBe(201)
    sshJob = ssh.json.job.id
    await waitFor(() => armed().includes(sshJob), 20_000, 'the SSH routine armed')

    const before = Date.now()
    // The net link's own set holds nothing of the SSH alias's: pushed alone, it would disarm it.
    await link(NET)
    expect(armed()).toContain(sshJob)
    await checksOnItsOwn(sshJob, before)
    expect(armed()).toContain(sshJob)

    const net = await api('POST', '/api/routines', routine('Net watch', NET))
    expect(net.status, JSON.stringify(net.json)).toBe(201)
    netJob = net.json.job.id
    const clock = await api('POST', '/api/routines', {
      name: 'Queue review', schedule: { kind: 'cron', expr: '0 * * * *', tz: 'UTC' },
      executor: { type: 'session', config: { target: taskId, prompt: 'Review the queue.' } },
    })
    expect(clock.status, JSON.stringify(clock.json)).toBe(201)
    clockJob = clock.json.job.id
    await link(SSH)
    await waitFor(() => armed().includes(netJob) && armedDefs().some((d) => d.id === clockJob && d.clock), 20_000, 'the net routines armed')
    expect(armed()).toEqual(expect.arrayContaining([sshJob, netJob, clockJob]))
    expect((await api('GET', `/api/routines/${clockJob}`)).json.job?.state?.clockHost).toBe(NET)
    // The pair is recorded where a server that starts later reads it.
    expect(Object.keys((await readHostProfile(SSH)).sameDaemon ?? {})).toEqual([NET])
    expect(Object.keys((await readHostProfile(NET)).sameDaemon ?? {})).toEqual([SSH])
  }, 120_000)

  for (const back of [NET, SSH]) {
    it(`a server restart with only ${back}'s link back keeps every routine armed, checking and its clock held`, async () => {
      await stopAll()
      const since = Date.now()
      await bootServer([back])
      // The first push went out, compiled with the other alias's link never back.
      expect(armed()).toEqual(expect.arrayContaining([sshJob, netJob, clockJob]))
      expect(armedDefs().find((d) => d.id === clockJob)?.clock).toBeTruthy()
      await checksOnItsOwn(sshJob, since)
      await checksOnItsOwn(netJob, since)
      expect(armed()).toEqual(expect.arrayContaining([sshJob, netJob, clockJob]))
      expect((await api('GET', `/api/routines/${clockJob}`)).json.job?.state?.clockHost).toBe(NET)
    }, 120_000)
  }
})
