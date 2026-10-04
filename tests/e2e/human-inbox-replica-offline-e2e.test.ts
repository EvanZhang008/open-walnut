/**
 * The phone's inbox while the Mac is away, end to end.
 *
 *   phone (HTTP, a phone device token)
 *     -> replica (real child process, WALNUT_CLOUD_MODE=1, with the git-synced
 *        copy of the inbox in its data dir)
 *     -> /bridge -> the primary's local daemon (real, spawned by the primary)
 *     -> primary (this process, startServer): the letter store
 *
 * 2026-10-03 on the user's companion: with the Mac asleep, every inbox load and
 * every read mark answered `bridge_offline`, although the replica held a full
 * copy of the inbox. The flow pinned here is the user's: the Mac is away, the
 * phone opens the inbox, reads one letter, reads a second, pins a third; while
 * still away, an agent on the Mac answers the second. The Mac comes back. The
 * replica replays the queued changes on the bridge connect: the first is read
 * and the third pinned on the Mac, and the second stays UNREAD there (its
 * answer is newer than the phone's read). The phone then sees the Mac's state.
 *
 * No substitution on the path. Isolation: each server has its own HOME, data
 * dir and daemon dir under one temp base; letters are made here, never copied
 * from user data; auth.json is written fresh with random tokens; the replica's
 * PATH leads with a `claude` that refuses to run.
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

vi.mock('../../src/constants.js', () => createMockConstants('walnut-inbox-offline-primary'))

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { agentReply, getLetter, humanInboxPaths, sendLetter } from '../../src/core/human-inbox/store.js'
import type { LetterRecord, LetterSender } from '../../src/core/human-inbox/types.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const SENDER: LetterSender = { sessionId: 'sess-offline-e2e', host: 'workstation' }

let base = ''
let primaryConn: { disconnect: () => void } | null = null
let primaryUp = false
const tokens = { mac: '', phone: '', machine: '' }
const replica = { port: 0, proc: null as ChildProcess | null, log: '', data: '', daemonDir: '' }
const ids = { digest: '', deploy: '', review: '' }

const sha256 = (t: string): string => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const newToken = (): string => crypto.randomBytes(16).toString('hex')

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  return env
}

async function startReplica(): Promise<void> {
  const home = path.join(base, 'replica', 'home')
  replica.data = path.join(base, 'replica', 'data')
  replica.daemonDir = path.join(base, 'replica', 'daemon')
  const stubBin = path.join(base, 'replica', 'bin')
  for (const d of [home, replica.data, replica.daemonDir, stubBin, path.join(base, 'hub')]) await fsp.mkdir(d, { recursive: true })
  await fsp.writeFile(path.join(stubBin, 'claude'), '#!/bin/sh\necho "claude is disabled in this test" >&2\nexit 1\n', { mode: 0o755 })
  await fsp.writeFile(path.join(replica.data, 'config.yaml'), 'version: 1\nuser:\n  name: Box\n')
  // The inbox exactly as git-sync leaves it on a replica: a copy of the primary's.
  await fsp.cp(humanInboxPaths.dir, path.join(replica.data, 'human-inbox'), { recursive: true })
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

/** The Mac comes back: paired through its data repo's `cloud` remote, then its server and daemon start. */
async function bringPrimaryBack(): Promise<void> {
  const domain = `127.0.0.1:${replica.port}`
  execFileSync('git', ['init', '-q', WALNUT_HOME], { env: gitEnv() })
  execFileSync('git', ['-C', WALNUT_HOME, 'remote', 'add', 'cloud', `http://mac:${tokens.mac}@${domain}/git/data.git`], { env: gitEnv() })
  await fsp.mkdir(path.join(WALNUT_HOME, 'sync'), { recursive: true })
  await fsp.writeFile(path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json'), JSON.stringify({ 'bridge-local': tokens.machine }), { mode: 0o600 })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(CONFIG_FILE, yaml.dump({
    version: 1, user: { name: 'Tester' }, defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' }, agent: { provider: 'claude-code' },
  }))
  await startServer({ port: 0, dev: true })
  primaryUp = true
  // The connection a live session would hold: it pushes the bridge config to the daemon.
  const { localDaemon } = await import('../../src/providers/local-daemon.js')
  const { getDirectDaemonConnection } = await import('../../src/providers/daemon-connection.js')
  const wsUrl = localDaemon.wsUrl
  if (!wsUrl) throw new Error('the primary has no local daemon')
  primaryConn = await getDirectDaemonConnection('__local__', wsUrl)
}

function stopDaemonIn(dir: string | undefined): void {
  if (!dir) return
  try {
    const pid = Number(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf-8').trim())
    if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM')
  } catch { /* not running */ }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}\n${replica.log.slice(-3000)}`)
}

async function phone(method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`http://127.0.0.1:${replica.port}/api/v1${p}`, {
    method,
    headers: { Authorization: `Bearer ${tokens.phone}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

const find = (letters: LetterRecord[], id: string): LetterRecord => {
  const l = letters.find((x) => x.id === id)
  if (!l) throw new Error(`letter ${id} missing from the list`)
  return l
}

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-inbox-offline-e2e-'))
  tokens.mac = newToken()
  tokens.phone = newToken()
  tokens.machine = newToken()
  // The Mac's letters, made before it went away.
  ids.digest = (await sendLetter({ subject: 'Weekly digest', type: 'review', markdown: '# Digest\n\u4eca\u65e5\u8981\u70b9 and three links.', sender: SENDER })).id
  ids.deploy = (await sendLetter({ subject: 'Which region first?', type: 'review', markdown: 'Pick a region for the rollout.', sender: SENDER })).id
  ids.review = (await sendLetter({ subject: 'Review ready', type: 'completion', markdown: 'The diff is ready.', sender: SENDER })).id
  await startReplica()
}, 300_000)

afterAll(async () => {
  try { primaryConn?.disconnect() } catch { /* already closed */ }
  if (primaryUp) { try { await stopServer() } catch { /* already down */ } }
  stopDaemonIn(process.env.WALNUT_DAEMON_DIR)
  await stopReplica()
  stopDaemonIn(replica.daemonDir)
  if (process.env.DEBUG_BOX) process.stderr.write(replica.log.slice(-8000))
  if (base) await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
}, 90_000)

describe('the inbox while the Mac is away', () => {
  it('serves the cloud copy, keeps what the phone did, and hands it to the Mac when it is back', async () => {
    // ── The Mac is away ──
    const opened = await phone('GET', '/human-inbox')
    expect(opened.status).toBe(200)
    expect(opened.json.servedFrom).toBe('mirror')
    expect(opened.json.letters).toHaveLength(3)
    expect(opened.json.unreadCount).toBe(3)

    const body = await phone('GET', `/human-inbox/${ids.digest}`)
    expect(body.status).toBe(200)
    expect(body.json.letter.body).toContain('\u4eca\u65e5\u8981\u70b9') // CJK survives the copy

    for (const [p, b] of [
      [`/human-inbox/${ids.digest}/read`, { read: true }],
      [`/human-inbox/${ids.deploy}/read`, { read: true }],
      [`/human-inbox/${ids.review}/pin`, { pinned: true }],
    ] as const) {
      const r = await phone('POST', p, b)
      expect(r.status).toBe(200)
      expect(r.json.queued).toBe(true)
    }

    const reopened = await phone('GET', '/human-inbox')
    expect(reopened.json.servedFrom).toBe('mirror')
    expect(find(reopened.json.letters, ids.digest).read).toBe(true)
    expect(find(reopened.json.letters, ids.deploy).read).toBe(true)
    expect(reopened.json.letters[0].id).toBe(ids.review) // pinned first
    expect(reopened.json.unreadCount).toBe(1)

    // Still away, an agent on the Mac answers the second letter: news the
    // phone's read never saw.
    await new Promise((r) => setTimeout(r, 20))
    await agentReply(ids.deploy, { text: 'Update: us-west is ready, the others are not.' })

    // ── The Mac is back ──
    await bringPrimaryBack()
    await waitFor(async () => {
      const [digest, review] = await Promise.all([getLetter(ids.digest), getLetter(ids.review)])
      return digest?.read === true && review?.pinned === true
    }, 120_000, 'the queued read and pin replayed onto the Mac')
    expect((await getLetter(ids.deploy))?.read).toBe(false)

    // The phone now reads the Mac itself, which has all of it.
    const live = await waitFor(async () => {
      const r = await phone('GET', '/human-inbox')
      return r.status === 200 && r.json.servedFrom === undefined ? r : null
    }, 60_000, 'the list relayed from the Mac')
    expect(find(live.json.letters, ids.digest).read).toBe(true)
    expect(find(live.json.letters, ids.deploy).read).toBe(false)
    expect(find(live.json.letters, ids.deploy).thread.at(-1)?.text).toContain('us-west is ready')
    expect(find(live.json.letters, ids.review).pinned).toBe(true)

    // The replica dropped the change the Mac superseded, and keeps the two the
    // Mac took until its copy shows them. The Mac's git tick may already have
    // landed that copy (this test does not stop git-sync), so each one is either
    // still held as applied, or gone with the copy showing it.
    const queueDir = path.join(replica.data, 'cache', 'human-inbox-queue')
    const kept = fs.readdirSync(queueDir).filter((n) => n.endsWith('.json'))
    expect(kept).not.toContain(`${ids.deploy}.read.json`)
    const copy = JSON.parse(fs.readFileSync(path.join(replica.data, 'human-inbox', 'index.json'), 'utf-8')) as { letters: LetterRecord[] }
    for (const [name, shows] of [
      [`${ids.digest}.read.json`, find(copy.letters, ids.digest).read],
      [`${ids.review}.pinned.json`, find(copy.letters, ids.review).pinned],
    ] as const) {
      if (kept.includes(name)) expect(JSON.parse(fs.readFileSync(path.join(queueDir, name), 'utf-8')).state).toBe('applied')
      else expect(shows).toBe(true)
    }
    // The replica never wrote its queued read of the answered letter anywhere.
    expect(find(copy.letters, ids.deploy).read).toBe(false)
  }, 400_000)
})
