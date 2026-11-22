/**
 * A host replica runs and judges a session itself (docs/plan/one-service-every-host.md, phase 2;
 * src/core/session-channel/host-boot.ts): a real child process boots `walnut web --replica` with
 * the switch on (WALNUT_HOST_RUNS_SESSIONS=1) and the session runtime in its own process
 * (WALNUT_IN_PROCESS_DAEMON=1), a session is started through its leader door's
 * `/host-api/sessions/start`, and a reader on `/host-api/session-channel` (standing in for the
 * leader) gets that session's records in order: its row born as this host's (`judge: 'host'`),
 * then its facts, each with its sequence number. The reader parses no CLI line: it gets bus
 * events, never the session's output.
 *
 * The test stands in for the follower link only (sockets of one loopback port go to the leader
 * door, as the link does with the streams the daemon relays from the Mac) and for the runtime
 * hand-over the one-service host does itself: the boot script starts the in-process runtime and
 * gives the runner its address (setTestDaemonUrl). The CLI is a shell script answering every
 * stdin user line with one assistant line and one result line.
 *
 * Isolation: one temp base for HOME, data dir, run dir and host daemon dir; PATH leads with the
 * fake `claude`, then the test run's exec guard (guardedPath, childExecGuardEnv), then the system
 * dirs. The child is stopped by the pid this test spawned.
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

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const SRC = path.join(REPO_ROOT, 'src')
const WALNUT_ID = '5e1f2d3c4b5a69788796a5b4c3d2e1f0'
const HOST_KEY = 'marina-box'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let base = ''
let child: ChildProcess | null = null
let stderr = ''
let doorPort = 0
const work = () => path.join(base, 'work')

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

const BOOT = (data: string) => `
const c = await import(${JSON.stringify(path.join(SRC, 'constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(data)}) { process.stderr.write('REFUSING: wrong data dir ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { runWeb } = await import(${JSON.stringify(path.join(SRC, 'commands/web.ts'))})
await runWeb({ replica: true, dev: true, port: process.env.WALNUT_HOST_SERVER_PORT })
const { getHostReplicaLeaderDoor } = await import(${JSON.stringify(path.join(SRC, 'web/server.ts'))})
const door = getHostReplicaLeaderDoor()
if (!door) { process.stderr.write('NO DOOR\\n'); process.exit(4) }
// The one-service host's runtime hand-over, until it does it itself: the runtime in this process.
const ipd = await import(${JSON.stringify(path.join(SRC, 'providers/in-process-daemon.ts'))})
await ipd.startInProcessDaemon({ dir: process.env.WALNUT_DAEMON_DIR, env: { ...process.env } })
const { sessionRunner } = await import(${JSON.stringify(path.join(SRC, 'providers/claude-code-session.ts'))})
sessionRunner.setTestDaemonUrl(ipd.IN_PROCESS_DAEMON_URL)
const boot = await import(${JSON.stringify(path.join(SRC, 'core/session-channel/host-boot.ts'))})
if (!boot.hostSessionsRunning()) { process.stderr.write('NO HOST SESSIONS\\n'); process.exit(5) }
const net = await import('node:net')
const s = net.createServer((sock) => door.accept(sock))
s.listen(0, '127.0.0.1', () => process.stdout.write('DOOR_PORT=' + s.address().port + '\\n'))
`

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-runs-sessions-'))
  const d = { home: path.join(base, 'home'), data: path.join(base, 'home', '.open-walnut-host', 'data'), run: path.join(base, 'home', '.open-walnut-host', 'run'), hostd: path.join(base, 'hostd') }
  const fakeBin = path.join(base, 'fakebin')
  for (const x of [d.data, d.run, d.hostd, fakeBin, work()]) await fsp.mkdir(x, { recursive: true, mode: 0o700 })
  await fsp.writeFile(path.join(fakeBin, 'claude'), FAKE_CLI, { mode: 0o755 })
  const script = path.join(base, 'boot.mts')
  await fsp.writeFile(script, BOOT(d.data))
  const port = await freePort()
  const env: NodeJS.ProcessEnv = {
    PATH: guardedPath([fakeBin], [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter)),
    HOME: d.home, USERPROFILE: d.home, SHELL: '/bin/sh', TMPDIR: os.tmpdir(),
    ...childExecGuardEnv(),
    WALNUT_HOST_DAEMON_DIR: d.hostd,
    OPEN_WALNUT_HOME: d.data, WALNUT_HOST_SERVER: '1', WALNUT_HOST_SERVER_PORT: String(port),
    WALNUT_LEADER_HOME: '/Users/marina/.open-walnut', WALNUT_WALNUT_ID: WALNUT_ID, WALNUT_HOST_LABEL: HOST_KEY, WALNUT_HOST_KEY: HOST_KEY,
    WALNUT_NO_AUTO_UPDATE: '1', WALNUT_FOLLOWER_TOKEN: 'follower-token-e2e',
    WALNUT_DAEMON_DIR: d.run, WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host',
    WALNUT_HOST_RUNS_SESSIONS: '1', WALNUT_IN_PROCESS_DAEMON: '1',
    NODE_ENV: 'production',
  }
  child = spawn(process.execPath, [script], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
