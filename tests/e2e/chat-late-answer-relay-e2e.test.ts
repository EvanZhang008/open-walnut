/**
 * A phone on the cloud replica gets a stalled turn's late answer, end to end.
 *
 *   phone (HTTP + SSE, a phone device token)
 *     -> replica (real child process, WALNUT_CLOUD_MODE=1, booted below)
 *     -> /bridge -> the primary's local daemon (real, spawned by the primary)
 *     -> primary (this process, startServer): api-v1 turn, chat-turn relay, mirror
 *     -> back down the same bridge -> replica -> the phone's SSE stream
 *
 * Gate finding (2026-09-30), reproduced on this topology with the real CLI:
 * the phone got the stall notice and then nothing, while the late answer was
 * filed on the Mac. Three things dropped it: the replica took the notice as the
 * turn's end and threw away later frames, `message-late` was not relayable, and
 * the primary disarmed its mirror when the turn function returned at the stall.
 * And the phone app already on the phone ignores `message-late`, so the answer
 * now also ends with the ordinary `message-end` it does act on.
 *
 * Substituted, and only this: runLaneTurn (in this process). A stall takes 15
 * minutes of silence; its rules are pinned in tests/core/lane-turn-liveness.test.ts.
 * The stub returns the verdict lane-turn.ts returns, so no CLI is spawned.
 * Everything between the phone and the lane is the shipped code. Isolation: each
 * server has its own HOME, data dir and daemon dir under one temp base; nothing
 * is copied from the user's data, auth.json is written fresh with random tokens,
 * and the replica's PATH leads with a `claude` that refuses to run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import yaml from 'js-yaml'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { LaneTurnResult } from '../../src/core/sessions/lane-turn.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-late-relay-primary'))

type LaneStub = (agentId: string, conversationId: string, message: string, opts: {
  onSessionId?: (sid: string) => void
  onQueued?: () => void
}) => Promise<LaneTurnResult>
const lane = vi.hoisted(() => ({ next: [] as LaneStub[], calls: [] as string[] }))
vi.mock('../../src/core/sessions/lane-turn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/sessions/lane-turn.js')>()),
  runLaneTurn: (a: string, c: string, m: string, opts: Parameters<LaneStub>[3]) => {
    lane.calls.push(m)
    const stub = lane.next.shift()
    if (!stub) throw new Error(`no lane stub queued for "${m}"`)
    return stub(a, c, m, opts)
  },
}))

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { LANE_STALL_NOTICE } from '../../src/web/routes/lane-turn-late.js'

const LANE_SID = 'late-relay-lane-0000-1111'
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

let base = ''
let primaryConn: { disconnect: () => void } | null = null
const tokens = { mac: '', phone: '', machine: '' }
const replica = { port: 0, proc: null as ChildProcess | null, log: '', data: '', daemonDir: '' }

const sha256 = (t: string): string => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const newToken = (): string => crypto.randomBytes(16).toString('hex')

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

/**
 * A cloud companion in its own process: its own HOME, data dir and daemon dir,
 * the three devices this test needs (the Mac, a phone, the Mac's machine
 * credential for /bridge), and a boot script that refuses any other data dir.
 */
async function startReplica(): Promise<void> {
  const home = path.join(base, 'replica', 'home')
  replica.data = path.join(base, 'replica', 'data')
  replica.daemonDir = path.join(base, 'replica', 'daemon')
  const stubBin = path.join(base, 'replica', 'bin')
  for (const d of [home, replica.data, replica.daemonDir, stubBin, path.join(base, 'hub')]) await fsp.mkdir(d, { recursive: true })
  // Nothing here may run a real CLI: the replica relays, it never answers.
  await fsp.writeFile(path.join(stubBin, 'claude'), '#!/bin/sh\necho "claude is disabled in this test" >&2\nexit 1\n', { mode: 0o755 })
  await fsp.writeFile(path.join(replica.data, 'config.yaml'), 'version: 1\nuser:\n  name: Box\n')
  const now = new Date().toISOString()
  await fsp.writeFile(path.join(replica.data, 'auth.json'), JSON.stringify({ devices: [
    { name: 'mac-primary', tokenHash: sha256(tokens.mac), createdAt: now },
    { name: 'my-phone', tokenHash: sha256(tokens.phone), createdAt: now },
    { name: 'bridge-local', tokenHash: sha256(tokens.machine), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  const script = path.join(base, 'replica', 'boot.mts')
  await fsp.writeFile(script, `
const c = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/constants.ts'))})
if (c.WALNUT_HOME !== ${JSON.stringify(replica.data)} || !c.CLOUD_MODE) { process.stderr.write('REFUSING: wrong home ' + c.WALNUT_HOME + '\\n'); process.exit(3) }
const { startServer, stopServer, armGracefulSignalExit } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/web/server.ts'))})
const server = await startServer({ port: 0, dev: true })
const addr = server.address()
process.stdout.write('WALNUT_PORT=' + (typeof addr === 'object' && addr ? addr.port : addr) + '\\n')
let closing = false
const close = async () => { if (closing) return; closing = true; try { await stopServer() } catch {} process.exit(0) }
process.on('SIGTERM', close)
process.on('SIGINT', close)
// Our handler owns the exit, so startServer() must not re-raise the signal first.
armGracefulSignalExit()
`)
  const proc = spawn(TSX, [script], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${stubBin}${path.delimiter}${process.env.PATH ?? ''}`,
      WALNUT_CLOUD_MODE: '1',
      OPEN_WALNUT_HOME: replica.data,
      HOME: home,
      USERPROFILE: home,
      SHELL: '/bin/sh',
      WALNUT_DAEMON_DIR: replica.daemonDir,
      WALNUT_GIT_HUB_DIR: path.join(base, 'hub'),
      WALNUT_DISABLE_BACKGROUND_AI: '1',
      WALNUT_DISABLE_SEARCH: '1',
      WALNUT_LOCAL_CLAUDE_PROBE: '0',
      // A replica as it runs in production, not as a test worker.
      VITEST: '', VITEST_WORKER_ID: '', VITEST_POOL_ID: '', NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  replica.proc = proc
  proc.stderr!.on('data', (b: Buffer) => { replica.log = (replica.log + b.toString()).slice(-200_000) })
  replica.port = await new Promise<number>((resolve, reject) => {
    let out = ''
    const t = setTimeout(() => reject(new Error(`replica did not report a port in 150s\n${replica.log.slice(-3000)}`)), 150_000)
    proc.stdout!.on('data', (b: Buffer) => {
      out += b.toString()
      const m = /WALNUT_PORT=(\d+)/.exec(out)
      if (m) { clearTimeout(t); resolve(Number(m[1])) }
    })
    proc.once('exit', (code) => { clearTimeout(t); reject(new Error(`replica exited early (${code})\n${replica.log.slice(-3000)}`)) })
  })
}

async function stopReplica(): Promise<void> {
  const proc = replica.proc
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>((r) => proc.once('exit', () => r()))
  proc.kill('SIGTERM')
  await Promise.race([exited, new Promise((r) => setTimeout(r, 30_000))])
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
}

/** Pair the primary with the replica: a `cloud` remote holding the Mac's device token, the machine credential cached. */
async function pairPrimary(): Promise<void> {
  const domain = `127.0.0.1:${replica.port}`
  execFileSync('git', ['init', '-q', WALNUT_HOME], { env: gitEnv() })
  execFileSync('git', ['-C', WALNUT_HOME, 'remote', 'add', 'cloud', `http://mac:${tokens.mac}@${domain}/git/data.git`], { env: gitEnv() })
  await fsp.mkdir(path.join(WALNUT_HOME, 'sync'), { recursive: true })
  await fsp.writeFile(path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json'), JSON.stringify({ 'bridge-local': tokens.machine }), { mode: 0o600 })
}

/** Kill a daemon through the pid file in its own runtime dir (never by name). */
function stopDaemonIn(dir: string | undefined): void {
  if (!dir) return
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf-8').trim())
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
  } catch { /* not running */ }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

const replicaUrl = (p: string): string => `http://127.0.0.1:${replica.port}${p}`
const asPhone = (init: RequestInit = {}): RequestInit => ({
  ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tokens.phone}`, 'Content-Type': 'application/json' },
})

interface SseEvt { event: string; data: Record<string, unknown> }
async function phoneStream(convId: string): Promise<{ events: SseEvt[]; close: () => void }> {
  const ctl = new AbortController()
  const res = await fetch(replicaUrl(`/api/v1/conversations/${convId}/stream`), { ...asPhone(), signal: ctl.signal })
  if (res.status !== 200 || !res.body) throw new Error(`phone SSE -> ${res.status}`)
  const events: SseEvt[] = []
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          let event = ''
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7)
            else if (line.startsWith('data: ')) data += line.slice(6)
          }
          if (event) events.push({ event, data: data ? JSON.parse(data) as Record<string, unknown> : {} })
        }
      }
    } catch { /* aborted */ }
  })()
  return { events, close: () => ctl.abort() }
}

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-late-relay-e2e-'))
  tokens.mac = newToken()
  tokens.phone = newToken()
  tokens.machine = newToken()
  await startReplica()

  // The Mac: paired with the replica through its data repo's `cloud` remote,
  // machine credential cached, so its daemon dials the replica's /bridge.
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(CONFIG_FILE, yaml.dump({
    version: 1, user: { name: 'Tester' }, defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' }, agent: { provider: 'claude-code' },
  }))
  await pairPrimary()
  await startServer({ port: 0, dev: true })
  // The Mac has been in use: a local session holds the pooled connection to its
  // daemon, which is what pushes the bridge config and what the daemon hands
  // relayed control requests to. There is no session here, so open that
  // connection the way a session does.
  const { localDaemon } = await import('../../src/providers/local-daemon.js')
  const { getDirectDaemonConnection } = await import('../../src/providers/daemon-connection.js')
  const wsUrl = localDaemon.wsUrl
  if (!wsUrl) throw new Error('the primary has no local daemon')
  primaryConn = await getDirectDaemonConnection('__local__', wsUrl)

  await waitFor(async () => {
    const res = await fetch(replicaUrl('/api/v1/status'), asPhone())
    if (res.status !== 200) return false
    const body = await res.json() as { bridgeHosts?: Array<{ hostAlias: string }> }
    return body.bridgeHosts?.some((h) => h.hostAlias === '__local__') ?? false
  }, 120_000, "the primary's daemon on the replica's /bridge")
}, 300_000)

afterAll(async () => {
  try { primaryConn?.disconnect() } catch { /* already closed */ }
  try { await stopServer() } catch { /* already down */ }
  // The primary's own daemon, through the pid file in THIS worker's runtime dir.
  stopDaemonIn(process.env.WALNUT_DAEMON_DIR)
  await stopReplica()
  stopDaemonIn(replica.daemonDir)
  if (process.env.DEBUG_BOX) process.stderr.write(replica.log.slice(-8000))
  if (base) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
}, 90_000)

describe('a relayed phone turn that stalls while its lane keeps running', () => {
  it('the phone gets the notice, can send again, and receives the late answer as message-late + message-end', async () => {
    const late = deferred<string | null>()
    const secondAnswer = deferred<string>()
    lane.next.push(async (_a, _c, _m, opts) => {
      opts.onSessionId?.(LANE_SID)
      return { sessionId: LANE_SID, resultText: null, failure: 'stalled', laneStillRunning: true, lateResult: late.promise }
    })
    // The follow-up as lane-turn.ts runs it on a lane held by a stalled turn.
    lane.next.push(async (_a, _c, _m, opts) => {
      opts.onQueued?.()
      await late.promise
      opts.onSessionId?.(LANE_SID)
      return { sessionId: LANE_SID, resultText: await secondAnswer.promise }
    })

    const created = await fetch(replicaUrl('/api/v1/conversations'), asPhone({ method: 'POST', body: '{}' }))
    expect(created.status).toBe(201)
    const convId = (await created.json() as { id: string }).id
    const phone = await phoneStream(convId)
    const seen = (event: string, turnId?: string) => (): boolean =>
      phone.events.some((e) => e.event === event && (turnId === undefined || e.data.turnId === turnId))
    try {
      const send = async (text: string): Promise<Response> =>
        fetch(replicaUrl(`/api/v1/conversations/${convId}/messages`), asPhone({ method: 'POST', body: JSON.stringify({ text }) }))

      const r1 = await send('a question that takes a long time')
      expect(r1.status).toBe(202)
      const t1 = (await r1.json() as { turnId: string }).turnId
      await waitFor(seen('error', t1), 60_000, 'the stall notice on the phone')
      expect(phone.events.find((e) => e.event === 'error')?.data).toMatchObject({
        message: LANE_STALL_NOTICE, turnId: t1, laneStillRunning: true,
      })

      // The notice unlocked the composer: the replica relays the next message.
      const r2 = await send('still there?')
      expect(r2.status).toBe(202)
      const t2 = (await r2.json() as { turnId: string }).turnId
      await waitFor(seen('queued', t2), 60_000, 'the follow-up waiting on the phone')

      late.resolve('the answer that took a long time')
      await waitFor(seen('message-end', t1), 60_000, 'the late message-end on the phone')
      const lateEnd = phone.events.find((e) => e.event === 'message-end' && e.data.turnId === t1)!
      expect(lateEnd.data).toMatchObject({ turnId: t1, fullText: 'the answer that took a long time', engine: 'claude-code' })
      const lateFrame = phone.events.find((e) => e.event === 'message-late')
      expect(lateFrame?.data).toEqual({ turnId: t1, fullText: 'the answer that took a long time' })

      // The follow-up is put back on screen, then answers normally.
      await waitFor(() => phone.events.filter((e) => e.event === 'message-start' && e.data.turnId === t2).length >= 2,
        30_000, 'the follow-up re-announced after the late message-end')
      secondAnswer.resolve('yes, and here is the second answer')
      await waitFor(seen('message-end', t2), 60_000, "the follow-up's own message-end")

      const order = phone.events.map((e) => `${e.event}:${String(e.data.turnId ?? '')}`)
        .filter((k) => /^(message-start|queued|error|message-late|message-end):/.test(k))
      expect(order).toEqual([
        `message-start:${t1}`,
        `error:${t1}`,
        `message-start:${t2}`,
        `queued:${t2}`,
        `message-late:${t1}`,
        `message-end:${t1}`,
        `message-start:${t2}`,
        `message-end:${t2}`,
      ])
      expect(lane.calls).toEqual(['a question that takes a long time', 'still there?'])
    } finally {
      phone.close()
    }
  }, 240_000)
})
