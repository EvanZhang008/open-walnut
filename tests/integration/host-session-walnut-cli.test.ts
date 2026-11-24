/**
 * Which `walnut` a session this host assembles itself runs, on a REAL standalone daemon with the
 * host's Walnut server beside it (tests/helpers/host-call-rig.ts).
 *
 * Such a session (judge 'host') names the host server's own root as OPEN_WALNUT_API_URL, a root that
 * takes no call without a credential. A box that installed an older released `walnut` earlier on PATH
 * ran that one, which spoke plain HTTP to the root and answered 401 not_paired (2026-11-24). Pinned,
 * with such a `walnut` first on the daemon's PATH:
 *   - a native start and an ACP start for the Walnut this host follows run the shim first (with the
 *     entry's socket), and a native session's bare `walnut tools call` is answered: by the host call
 *     entry while it is on, by the gateway socket while it is off;
 *   - the same while the follower is away: its socket closed (a restart), and after the daemon was
 *     taken over by a new one, before any follower's hello (the spec it keeps, server-*.json);
 *   - the hub's own session (a Walnut with no follower here, naming its loopback address) keeps the
 *     installed CLI first.
 *
 * MACHINE SAFETY: every dir is the rig's temp dir; the processes signalled are the daemons and the
 * stand-in CLIs and servers this file started, by the pids they logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { WebSocket } from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { acpWorkerBundle } from '../helpers/acp-worker-bundle.js'
import { BUN, HOME, HOST_SERVER_PORT, cmd, endRigs, lines, report, restartDaemon, rig, rigBase, startRigs, waitFor, type Daemon } from '../helpers/host-call-rig.js'

const HOST_ROOT = `http://127.0.0.1:${HOST_SERVER_PORT}`
const MOCK_AGENT = path.resolve(__dirname, '../providers/mock-acp-agent.mjs')

/**
 * A session's CLI (or, with `--acp <bun> <agent>`, an ACP adapter): says its pid, what `walnut`
 * resolves to and its entry socket. As a CLI it then runs one bare `walnut tools call task_list`,
 * says what it answered and idles; as an adapter it runs the mock agent on its own stdio (a call
 * from it would need the home the leader records for an ACP session, which this rig does not send).
 */
const FAKE = `
const fs = require('fs')
const { spawn, spawnSync, execFile } = require('child_process')
const [out, mode, bun, agent] = process.argv.slice(2)
const say = (o) => fs.appendFileSync(out, JSON.stringify({ pid: process.pid, ...o }) + '\\n')
const walnut = spawnSync('/bin/sh', ['-c', 'command -v walnut'], { env: process.env, encoding: 'utf8' }).stdout.trim()
say({ walnut, path: process.env.PATH, callSocket: process.env.WALNUT_CALL_SOCKET ?? null })
if (mode === '--acp') {
  const child = spawn(bun, [agent], { stdio: 'inherit', env: process.env })
  child.on('exit', (c) => process.exit(c ?? 0))
  process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0) })
} else {
  execFile('/bin/sh', ['-c', "walnut tools call task_list '{}'"], { env: process.env, encoding: 'utf8', timeout: 60000 }, (err, stdout, stderr) => {
    say({ code: err ? (err.code ?? 1) : 0, stdout, stderr })
  })
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
  setTimeout(() => process.exit(0), 120000).unref()
  process.on('SIGTERM', () => process.exit(0))
  process.stdin.on('data', () => {})
  setInterval(() => {}, 1000)
}
`

let oldBin = ''
let fake = ''

beforeAll(() => {
  startRigs('hsw-')
  // An older released `walnut` the box installed itself: it speaks plain HTTP to the address it is
  // given, which a host server answers 401 without a credential.
  oldBin = path.join(rigBase(), 'old-walnut', 'bin')
  fs.mkdirSync(oldBin, { recursive: true })
  fs.writeFileSync(path.join(oldBin, 'walnut'), '#!/bin/sh\necho \'{"code":"not_paired"}\' >&2\nexit 1\n', { mode: 0o755 })
  fake = path.join(rigBase(), 'fake-session.cjs')
  fs.writeFileSync(fake, FAKE)
})
afterAll(endRigs)

/** The daemon's env: the older `walnut` first on PATH, a plain sh, a home of its own (no rc file). */
function rigEnv(name: string): NodeJS.ProcessEnv {
  const home = path.join(rigBase(), `${name}-home`)
  fs.mkdirSync(home, { recursive: true })
  return { PATH: guardedPath([oldBin]), SHELL: '/bin/sh', HOME: home }
}

type Said = { walnut: string; path: string; callSocket: string | null; code: number; stdout: string; stderr: string }

async function said(out: string, sid: string, called = true): Promise<Said> {
  await waitFor(() => lines(out).some((l) => (called ? 'code' : 'walnut') in l), 90_000, `what ${sid} said`)
  return { ...lines(out).find((l) => 'walnut' in l)!, ...lines(out).find((l) => 'code' in l) } as Said
}

/** A native session start, as the leader (or the host's own service) sends it. */
async function startNative(mac: WebSocket, sid: string, home: string, apiUrl: string): Promise<Said> {
  const out = path.join(rigBase(), `native-${sid.slice(0, 8)}.jsonl`)
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} ${JSON.stringify(out)} "$@"`
  const args = ['/bin/sh', '-c', sh, 'sh', '--output-format', 'stream-json', '--settings', JSON.stringify({ env: { OPEN_WALNUT_API_URL: apiUrl } }),
    '--input-format', 'stream-json', '--session-id', sid]
  const reply = await cmd(mac, { cmd: 'start', sid, cwd: rigBase(), message: '', mode: 'default', args, origin: { home } })
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
  return said(out, sid)
}

/** An ACP worker start; its adapter is the stand-in above, wrapping the mock agent. */
async function startAcp(mac: WebSocket, sid: string, home: string, apiUrl: string): Promise<Said> {
  const out = path.join(rigBase(), `acp-${sid.slice(0, 8)}.jsonl`)
  const reply = await cmd(mac, {
    cmd: 'acpStart', sid, cwd: rigBase(), home, env: { OPEN_WALNUT_API_URL: apiUrl, WALNUT_SESSION_ID: sid },
    workerCmd: [process.execPath, acpWorkerBundle()], adapterCmd: [process.execPath, fake, out, '--acp', process.execPath, MOCK_AGENT],
  }, 60_000)
  expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
  return said(out, sid, false)
}

/** The shim resolves for a bare `walnut`, first on PATH. */
function expectShimFirst(s: Said, d: Daemon): void {
  const shim = path.join(d.dir, 'bin', 'walnut')
  expect(s.walnut).toBe(shim)
  expect(s.path.split(':')[0]).toBe(path.dirname(shim))
}

/** The shim first, and its bare `walnut tools call` answered (by the Mac the rig plays). */
function expectShim(s: Said, d: Daemon): void {
  expectShimFirst(s, d)
  expect(s.code, s.stderr).toBe(0)
  expect(JSON.parse(s.stdout)).toEqual({ who: 'mac', op: 'task_list' })
}

describe.skipIf(!BUN)('a session this host assembles runs Walnut\'s shim for a bare `walnut`', () => {
  it('native and ACP starts, by the entry and by the socket; the hub\'s own session keeps the installed CLI', async () => {
    const r = await rig('hsa', rigEnv('hsa'))
    try {
      await waitFor(() => fs.existsSync(path.join(r.d.dir, 'bin', 'walnut')), 30_000, 'the shim')
      const viaEntry = await startNative(r.mac, 'cccccccc-0000-4000-8000-00000000000c', HOME, HOST_ROOT)
      expectShim(viaEntry, r.d)
      expect(viaEntry.callSocket).toBe(r.callSocket)
      const acp = await startAcp(r.mac, 'acacacac-0000-4000-8000-0000000000ac', HOME, HOST_ROOT)
      expectShimFirst(acp, r.d)
      expect(acp.callSocket).toBe(r.callSocket)
      // The native session's call went in by the entry.
      expect(r.entryLines.map((l) => [l.sid, l.args?.name])).toEqual([['cccccccc-0000-4000-8000-00000000000c', 'task_list']])
      await cmd(r.mac, { cmd: 'acpStop', sid: 'acacacac-0000-4000-8000-0000000000ac' }).catch(() => undefined)

      // The entry off (host_call_entry): still the shim, and its call goes over the gateway socket.
      await report(r.follower, { callSocket: null })
      const viaSocket = await startNative(r.mac, 'dddddddd-0000-4000-8000-00000000000d', HOME, HOST_ROOT)
      expectShim(viaSocket, r.d)
      expect(viaSocket.callSocket).toBeNull()
      expect(r.entryLines).toHaveLength(1)

      // The hub's own session: a Walnut with no follower here names its own loopback address.
      const hub = await startNative(r.mac, 'eeeeeeee-0000-4000-8000-00000000000e', path.join(rigBase(), 'hub-home'), 'http://127.0.0.1:1')
      expect(hub.walnut).toBe(path.join(oldBin, 'walnut'))
      expect(hub.path.split(':').at(-1)).toBe(path.dirname(path.join(r.d.dir, 'bin', 'walnut')))
    } finally {
      r.mac.close(); r.follower.close()
    }
  }, 300_000)

  it('while the follower is away: its socket closed, and after a daemon takeover before any hello', async () => {
    const r = await rig('hsb', rigEnv('hsb'))
    let mac: WebSocket = r.mac
    try {
      // The follower restarting: its socket is gone, its server spec is still kept here.
      // Whether the daemon has seen the close yet or not, the answer is the same (linked or kept).
      await new Promise<void>((resolve) => { r.follower.once('close', () => resolve()); r.follower.close() })
      const away = await startNative(r.mac, 'f0f0f0f0-0000-4000-8000-0000000000f0', HOME, HOST_ROOT)
      expectShim(away, r.d)
      expect(away.callSocket).toBeNull()

      // A new daemon takes over (a handover): it read the spec back at boot, and no follower has said
      // hello to it yet. A start replayed now still runs the shim.
      const next = await restartDaemon(r)
      mac = next.mac
      await waitFor(() => fs.existsSync(path.join(next.d.dir, 'bin', 'walnut')), 30_000, 'the shim of the new daemon')
      const replayed = await startNative(next.mac, 'f1f1f1f1-0000-4000-8000-0000000000f1', HOME, HOST_ROOT)
      expectShim(replayed, next.d)
      expect(next.macAsked.map((m) => m.payload?.name)).toContain('task_list')
    } finally {
      mac.close(); r.mac.close()
    }
  }, 300_000)
})
