/**
 * A host replica runs and judges a session itself (docs/plan/one-service-every-host.md, phase 2;
 * src/core/session-channel/host-boot.ts): a real child process is the host's one Walnut service,
 * started as the launcher starts it (`--service` with a mode file naming this executable and the
 * follower spec a daemon kept: src/binary/service-entry.ts, through the test's runner of that entry,
 * tests/providers/fixtures/one-service-runner.ts), with the switch on (WALNUT_HOST_RUNS_SESSIONS=1).
 * Its session runner reaches the runtime in its own process through the own-sessions link
 * (daemon-connection.ts assertLocalDialAllowed). A session is started through its leader door's
 * `/host-api/sessions/start`, and a reader on `/host-api/session-channel` (standing in for the
 * leader) gets that session's records in order: its row born as this host's (`judge: 'host'`),
 * then its facts, each with its sequence number. The reader parses no CLI line: it gets bus
 * events, never the session's output.
 *
 * The test stands in for the follower link only (sockets of one loopback port go to the leader
 * door, as the link does with the streams the daemon relays from the Mac). The CLI is a shell
 * script answering every stdin user line with one assistant line and one result line.
 *
 * A Codex session started the same way is assembled here too, so its provider is decided here, from
 * this host's copy of the leader's config: a fake `codex` records the command line and CODEX_CONFIG
 * its app-server is started with. The leader's `engines.codex.provider` names the leader's own
 * 127.0.0.1 proxy, which reaches nothing on this host: the session carries this host's own provider
 * (the copy's `host_engines` row); with none of its own the start is refused with what to set, and
 * no Codex runs (providers/codex-engine-config.ts codexProviderForPlace).
 *
 * Isolation: one temp base for HOME, data dir, run dir, the runtime's daemon and state dirs;
 * PATH leads with the fake `claude`, then the test run's exec guard (guardedPath,
 * childExecGuardEnv), then the system dirs. The child is stopped by the pid this test spawned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from '#ws'
import type { ChannelFrame } from '../../src/core/session-channel/channel.js'
import type { FactRecord } from '../../src/core/session-channel/fact-log.js'
import { childExecGuardEnv, guardedPath } from '../setup/exec-guard.js'
import { configCopyRows } from '../../src/core/replication/config-allowlist.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const SRC = path.join(REPO_ROOT, 'src')
const WALNUT_ID = '5e1f2d3c4b5a69788796a5b4c3d2e1f0'
const HOST_KEY = 'marina-box'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let base = ''
let child: ChildProcess | null = null
let stderr = ''
let doorPort = 0
let dataDir = ''
const work = () => path.join(base, 'work')
const codexLog = () => path.join(base, 'codex-argv.log')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)) })
  })
}

const FAKE_CLI = [
  '#!/bin/sh',
  'sid=fake',
  'while [ $# -gt 0 ]; do',
  '  if [ "$1" = "--session-id" ]; then sid="$2"; fi',
  '  shift',
  'done',
  'echo "{\\"type\\":\\"system\\",\\"subtype\\":\\"init\\",\\"session_id\\":\\"$sid\\",\\"model\\":\\"fake\\",\\"tools\\":[]}"',
  'n=0',
  'while IFS= read -r line; do',
  '  case "$line" in',
  '    *\'"type":"user"\'*)',
  '      n=$((n+1))',
  '      echo "{\\"type\\":\\"assistant\\",\\"session_id\\":\\"$sid\\",\\"message\\":{\\"id\\":\\"msg_fake_$n\\",\\"type\\":\\"message\\",\\"role\\":\\"assistant\\",\\"model\\":\\"fake\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"answer $n\\"}],\\"stop_reason\\":\\"end_turn\\",\\"usage\\":{\\"input_tokens\\":1,\\"output_tokens\\":1}}}"',
  '      echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"session_id\\":\\"$sid\\",\\"num_turns\\":$n,\\"result\\":\\"answer $n\\"}"',
  '      ;;',
  '  esac',
  'done',
  '',
].join('\n')

/** A `codex` that says its version and, as an app-server, writes its command line and CODEX_CONFIG, then fails. */
const FAKE_CODEX = (log: string) => [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then echo "codex-cli 0.150.0"; exit 0; fi',
  `printf 'ARGV %s\\n' "$*" >> ${JSON.stringify(log)}`,
  `printf 'CODEX_CONFIG %s\\n' "$CODEX_CONFIG" >> ${JSON.stringify(log)}`,
  'exit 1',
  '',
].join('\n')

/** The leader's config as this host's copy holds it: the leader's real copy rows, where the config copy kind keeps them. */
async function leaderCopyIs(leaderConfig: Record<string, unknown>): Promise<void> {
  const { rows } = configCopyRows(leaderConfig)
  const file = path.join(dataDir, 'cache', 'replica', 'config.json')
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fsp.writeFile(file, JSON.stringify({ v: 1, asOf: Date.now(), at: Date.now(), hashes: {}, rows: Object.fromEntries(rows.map((r) => [r.key, r])) }), { mode: 0o600 })
}

const RUNNER = path.join(REPO_ROOT, 'tests/providers/fixtures/one-service-runner.ts')

/** What the service imports once its server answers (WALNUT_TEST_SERVICE_AFTER): checks, and the door on a loopback port. */
const AFTER = (data: string) => `
const c = await import(${JSON.stringify(path.join(SRC, 'constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(data)}) { process.stderr.write('REFUSING: wrong data dir ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { getHostReplicaLeaderDoor } = await import(${JSON.stringify(path.join(SRC, 'web/server.ts'))})
const door = getHostReplicaLeaderDoor()
if (!door) { process.stderr.write('NO DOOR\\n'); process.exit(4) }
const boot = await import(${JSON.stringify(path.join(SRC, 'core/session-channel/host-boot.ts'))})
if (!boot.hostSessionsRunning()) { process.stderr.write('NO HOST SESSIONS\\n'); process.exit(5) }
const net = await import('node:net')
const s = net.createServer((sock) => door.accept(sock))
s.listen(0, '127.0.0.1', () => process.stdout.write('DOOR_PORT=' + s.address().port + '\\n'))
`

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-runs-sessions-'))
  const d = {
    home: path.join(base, 'home'), data: path.join(base, 'home', '.open-walnut-host', 'data'), run: path.join(base, 'home', '.open-walnut-host', 'run'),
    // The runtime's own dirs, as the launcher names them: its daemon dir, its state dir (the install root) and the launcher's marks.
    hostd: path.join(base, 'hostd'), state: path.join(base, 'state'), launcher: path.join(base, 'state', 'launcher'),
  }
  const fakeBin = path.join(base, 'fakebin')
  for (const x of [d.data, d.run, d.hostd, path.join(d.state, 'host-server'), d.launcher, fakeBin, work()]) await fsp.mkdir(x, { recursive: true, mode: 0o700 })
  await fsp.writeFile(path.join(fakeBin, 'claude'), FAKE_CLI, { mode: 0o755 })
  await fsp.writeFile(path.join(fakeBin, 'codex'), FAKE_CODEX(codexLog()), { mode: 0o755 })
  dataDir = d.data
  const after = path.join(base, 'after.mts')
  await fsp.writeFile(after, AFTER(d.data))
  const port = await freePort()
  const leaderHome = '/Users/marina/.open-walnut'
  // The follower spec a daemon keeps for this Walnut (host-server-core.ts), and the mode file
  // `walnut daemon update --serve` writes: the service runs this Walnut's follower from them.
  const spec = {
    v: 1, home: leaderHome, walnutId: WALNUT_ID, command: process.execPath, args: [], cwd: d.data, log: path.join(base, 'follower.log'), port, settings: {},
    env: {
      OPEN_WALNUT_HOME: d.data, WALNUT_DAEMON_DIR: d.run, WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(port),
      WALNUT_LEADER_HOME: leaderHome, WALNUT_WALNUT_ID: WALNUT_ID, WALNUT_HOST_LABEL: HOST_KEY, WALNUT_HOST_KEY: HOST_KEY,
      WALNUT_NO_AUTO_UPDATE: '1', WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', NODE_ENV: 'production',
    },
  }
  await fsp.writeFile(path.join(d.state, 'host-server', 'server-00112233aabbccdd.json'), JSON.stringify({ spec, token: crypto.randomBytes(32).toString('hex') }), { mode: 0o600 })
  await fsp.writeFile(path.join(d.state, 'service-mode.json'), JSON.stringify({ v: 1, home: leaderHome, exe: process.execPath }), { mode: 0o600 })
  // The launcher's env for `--service`: the host's switch on, and the runtime's own files in the base.
  const env: NodeJS.ProcessEnv = {
    PATH: guardedPath([fakeBin], [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter)),
    HOME: d.home, USERPROFILE: d.home, SHELL: '/bin/sh', TMPDIR: os.tmpdir(),
    ...childExecGuardEnv(),
    WALNUT_DAEMON_DIR: d.hostd, WALNUT_DAEMON_STATE_DIR: d.state, WALNUT_DAEMON_SUPERVISOR: 'launcher', WALNUT_LAUNCHER_DIR: d.launcher,
    WALNUT_STREAMS_DIR: path.join(d.hostd, 'streams'), WALNUT_LEGACY_STREAMS_DIR: path.join(d.hostd, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(d.hostd, 'spawn-journal.jsonl'),
    WALNUT_HOST_RUNS_SESSIONS: '1', WALNUT_TEST_SERVICE_AFTER: after,
  }
  child = spawn(process.execPath, [RUNNER, '--service'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr!.on('data', (x: Buffer) => { stderr = (stderr + x.toString()).slice(-200_000) })
  if (process.env.DEBUG_LIVE) child.stderr!.on('data', (x: Buffer) => process.stderr.write(x))
  doorPort = await new Promise<number>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`no door in 180 s\n${stderr.slice(-4000)}`)), 180_000)
    child!.stdout!.on('data', (x: Buffer) => {
      out += x.toString()
      const m = /DOOR_PORT=(\d+)/.exec(out)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    child!.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the host exited early (${code})\n${stderr.slice(-4000)}`)) })
  })
}, 240_000)

afterAll(async () => {
  const pid = child?.pid
  if (child && child.exitCode === null && pid && pid > 1) {
    child.kill('SIGTERM')
    const end = Date.now() + 15_000
    while (child.exitCode === null && Date.now() < end) await sleep(100)
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  if (base) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
}, 30_000)

describe('a host that runs and judges its sessions', () => {
  it('a session started through its door reaches the channel reader in order: its row born as the host\'s, then its facts', async () => {
    const recs: FactRecord[] = []
    const ws = new WebSocket(`ws://127.0.0.1:${doorPort}/host-api/session-channel`)
    ws.on('message', (raw) => {
      const f = JSON.parse(String(raw)) as ChannelFrame
      if (f.op === 'hello') ws.send(JSON.stringify({ ch: 'sf', op: 'resume', walnutId: WALNUT_ID, hostId: HOST_KEY, permitNumber: 1, logId: f.logId, after: 0 }))
      else if (f.op === 'facts') recs.push(...f.recs)
    })
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j) })

    const sid = crypto.randomUUID()
    const taskId = 'task-marina-host-1'
    const r = await fetch(`http://127.0.0.1:${doorPort}/host-api/sessions/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        taskId, message: 'ROUND-one', cwd: work(), mode: 'bypass', preassignedSessionId: sid, project: 'Marina',
        attributed: true, attributionSource: 'test',
        startBundle: {
          task: { id: taskId, title: 'Host run', project: 'Marina', status: 'todo', phase: 'TODO', priority: 'none', source: 'local', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), tags: [] },
          sessionContext: { systemPrompt: 'You are a test session.' },
          hintsApplied: true,
        },
      }),
    })
    const started = await r.json() as { ok: boolean; sessionId?: string; error?: string }
    expect(started, stderr.slice(-3000)).toMatchObject({ ok: true, sessionId: sid })

    const end = Date.now() + 60_000
    while (!recs.some((x) => x.sid === sid && x.name === 'session:result') && Date.now() < end) await sleep(50)
    ws.close()
    const mine = recs.filter((x) => x.sid === sid)
    expect(mine.some((x) => x.name === 'session:result'), `${mine.map((x) => x.name).join(', ')}\n${stderr.slice(-3000)}`).toBe(true)
    // Born first, as this host's own row.
    expect(mine[0]!.name).toBe('row')
    expect(mine[0]!.data).toMatchObject({ born: true, patch: { claudeSessionId: sid, judge: 'host', host: HOST_KEY, taskId } })
    // In order: seq and the session's own sseq both rise by one per record of it.
    expect(mine.map((x) => x.sseq)).toEqual(mine.map((_, i) => i + 1))
    const seqs = recs.map((x) => x.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    // Bus events and channel records only: no raw CLI line reached the reader.
    const names = new Set(mine.map((x) => x.name))
    for (const n of names) expect(n === 'row' || n === 'live' || n.startsWith('session:') || n.startsWith('transfer:'), n).toBe(true)
    const result = mine.find((x) => x.name === 'session:result')!
    expect((result.data as { result?: string }).result).toBe('answer 1')
  }, 120_000)
})

describe('a Codex session this host runs itself gets the provider for this host', () => {
  const LEADER_LOOPBACK = { base_url: 'http://127.0.0.1:8402/openai/v1', name: 'local-proxy', wire_api: 'responses' }
  const HOST_OWN = { base_url: 'http://127.0.0.1:18402/v1', name: 'host-relay', wire_api: 'responses' }

  /** Start Codex through the door: the start's answer once it settled (a refusal), or null while it still runs. */
  function postStart(n: number): Promise<{ ok: boolean; error?: string }> {
    const taskId = `task-marina-codex-${n}`
    return fetch(`http://127.0.0.1:${doorPort}/host-api/sessions/start`, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        taskId, message: 'hello', cwd: work(), mode: 'bypass', engine: 'codex', preassignedSessionId: crypto.randomUUID(), project: 'Marina',
        attributed: true, attributionSource: 'test',
        startBundle: {
          task: { id: taskId, title: 'Host Codex run', project: 'Marina', status: 'todo', phase: 'TODO', priority: 'none', source: 'local', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), tags: [] },
          hintsApplied: true,
        },
      }),
    }).then((r) => r.json() as Promise<{ ok: boolean; error?: string }>)
  }

  /** Start Codex through the door; the app-server's command line and CODEX_CONFIG the fake codex wrote. */
  async function codexStart(n: number): Promise<{ argv: string; config: string }> {
    await fsp.rm(codexLog(), { force: true })
    void postStart(n).catch(() => null)
    const end = Date.now() + 60_000
    let text = ''
    while (Date.now() < end) {
      text = await fsp.readFile(codexLog(), 'utf8').catch(() => '')
      if (/^ARGV .*app-server/m.test(text) && /^CODEX_CONFIG /m.test(text)) break
      await sleep(100)
    }
    const argv = /^ARGV (.*app-server.*)$/m.exec(text)?.[1] ?? ''
    expect(argv, `no app-server start\n${stderr.slice(-3000)}`).not.toBe('')
    return { argv, config: /^CODEX_CONFIG (.*)$/m.exec(text)?.[1] ?? '' }
  }

  it('the leader\'s loopback provider with none of this host\'s own: the start is refused with what to set, and no Codex runs', async () => {
    await leaderCopyIs({ engines: { codex: { provider: LEADER_LOOPBACK, model: 'gpt-6.2-sol' } } })
    await fsp.rm(codexLog(), { force: true })
    const answer = await postStart(1)
    expect(answer.ok, stderr.slice(-3000)).toBe(false)
    expect(answer.error).toContain(`host "${HOST_KEY}"`)
    expect(answer.error).toContain(`hosts:\n  ${HOST_KEY}:\n    engines:\n      codex:\n        provider:`)
    const ran = await fsp.readFile(codexLog(), 'utf8').catch(() => '')
    expect(ran).not.toMatch(/^ARGV .*app-server/m)
  }, 120_000)

  it('this host\'s own provider from the copy\'s host_engines row is passed', async () => {
    await leaderCopyIs({
      engines: { codex: { provider: LEADER_LOOPBACK } },
      hosts: { [HOST_KEY]: { hostname: 'marina-box.invalid', engines: { codex: { provider: HOST_OWN } } }, other: { hostname: 'other.invalid' } },
    })
    const { argv, config } = await codexStart(2)
    expect(argv).toContain('model_providers.host-relay=')
    expect(argv).toContain(HOST_OWN.base_url)
    expect(argv).not.toContain(LEADER_LOOPBACK.base_url)
    expect(JSON.parse(config)).toMatchObject({ model_provider: 'host-relay' })
  }, 120_000)
})
