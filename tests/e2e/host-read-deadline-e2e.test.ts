/**
 * Session history and Changes answer within a deadline while the session's
 * host never answers (core/hosts/remote-read-bound.ts).
 *
 * Two silent hosts, the shape a hung companion or a half-open SSH path has:
 *  - Cloud: the paired companion is a TCP listener that accepts and never
 *    replies, so the tunnel upgrade hangs until its own 30s timeout;
 *  - devbox, an SSH host: `ssh` on PATH is a stand-in that never answers and
 *    exits by itself after 15s (no real ssh runs, nothing leaves this machine).
 * The gate measured 44.5s (history) and 60.4s (Changes) behind such a host.
 * Now: the request that starts a dial waits at most 5s, and every request
 * while that dial runs answers at once, from cache or degraded. The Files
 * listing and the folder picker (list-dirs without `pending`) are held to the
 * same bound; they took 15 to 30s and named the Cloud host by its internal alias.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedPrimaryPairing } from '../helpers/cloud-box-replica.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-read-deadline'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { CLOUD_BOX_HOST_ALIAS, getCloudBoxState } from '../../src/core/hosts/cloud-box-host.js'

let base = ''
let primaryPort = 0
let silent: net.Server
const held = new Set<net.Socket>()
let silentPort = 0
const pidFile = () => path.join(base, 'fake-ssh.pids')
const savedPath = process.env.PATH

const CLOUD_SID = '11111111-2222-4333-8444-555555555555'
const SSH_SID = '66666666-7777-4888-9999-000000000000'

const api = (p: string) => fetch(`http://127.0.0.1:${primaryPort}${p}`)

async function timed(p: string): Promise<{ status: number; ms: number; body: Record<string, unknown> }> {
  const t0 = Date.now()
  const r = await api(p)
  const ms = Date.now() - t0
  return { status: r.status, ms, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-host-read-deadline-'))
  silent = net.createServer((s) => { held.add(s); s.on('close', () => held.delete(s)); s.on('error', () => {}) })
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
  silentPort = (silent.address() as net.AddressInfo).port

  // `ssh` for this process: never answers, gone by itself after 15s.
  const bin = path.join(base, 'bin')
  await fsp.mkdir(bin, { recursive: true })
  // Its own sleep ends with it (TERM from an execFile timeout) or on its own.
  const pids = JSON.stringify(pidFile())
  await fsp.writeFile(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    `echo $$ >> ${pids}`,
    'sleep 14 &',
    'child=$!',
    `echo $child >> ${pids}`,
    "trap 'kill $child 2>/dev/null; exit 255' TERM INT HUP",
    'wait $child',
    'exit 255',
    '',
  ].join('\n'), { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`

  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), [
    'version: 1', 'user:', '  name: Tester', 'defaults:', '  priority: none',
    'hosts:', '  devbox:', '    hostname: 127.0.0.1', `    port: ${silentPort}`, '    label: Dev box', '',
  ].join('\n'))
  await seedPrimaryPairing(WALNUT_HOME, `127.0.0.1:${silentPort}`, { mac: 'mac-device-token', primaryMachine: 'machine-token' })

  const server = await startServer({ port: 0, dev: true })
  primaryPort = (server.address() as net.AddressInfo).port
  await createSessionRecord(CLOUD_SID, 'task-cloud', 'Tests', '/srv/projects/alpha', { host: CLOUD_BOX_HOST_ALIAS })
  await createSessionRecord(SSH_SID, 'task-ssh', 'Tests', '/home/dev/projects/beta', { host: 'devbox' })
}, 180_000)

afterAll(async () => {
  try { await stopServer() } catch { /* already down */ }
  for (const s of held) s.destroy()
  await new Promise<void>((r) => silent.close(() => r()))
  // The stand-in ssh processes end by themselves; wait for every one (never signal
  // them), the ones a dial still in flight starts after the stop included: the
  // ControlMaster's ends at 14s and its fallback `ssh ... sh -s` follows at once.
  // Only then may `ssh` stop meaning the stand-in, or that fallback would run the
  // next ssh on PATH (the real one, before tests/setup/exec-guard.ts).
  const pids = () => fs.existsSync(pidFile()) ? fs.readFileSync(pidFile(), 'utf-8').split('\n').map(Number).filter((n) => n > 1) : []
  const alive = (p: number) => { try { process.kill(p, 0); return true } catch { return false } }
  const end = Date.now() + 60_000
  let quietSince = 0
  while (Date.now() < end) {
    if (pids().some(alive)) quietSince = 0
    else if (!quietSince) quietSince = Date.now()
    else if (Date.now() - quietSince >= 2_000) break
    await new Promise((r) => setTimeout(r, 250))
  }
  process.env.PATH = savedPath
  expect(pids().filter(alive)).toEqual([])
}, 90_000)

describe.each([
  ['Cloud (a companion that accepts TCP and never answers)', CLOUD_SID, 'Cloud', CLOUD_BOX_HOST_ALIAS],
  ['an SSH host that never answers', SSH_SID, 'Dev box', 'devbox'],
])('%s', (_label, sid, hostLabel, host) => {
  it('history: the request that starts the dial waits at most the cap, then answers stale; the next ones at once', async () => {
    if (sid === CLOUD_SID) expect(getCloudBoxState()).not.toBeNull()
    const first = await timed(`/api/sessions/${sid}/history?tail=400`)
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ messages: [], total: 0, stale: true, staleReason: `Reconnecting to ${hostLabel}` })
    expect(first.ms).toBeLessThan(7_000)

    const second = await timed(`/api/sessions/${sid}/history?tail=400`)
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ stale: true, staleReason: `Reconnecting to ${hostLabel}` })
    expect(second.ms).toBeLessThan(1_500)

    // A delta never gets a stale total: it fails in place, fast.
    const delta = await timed(`/api/sessions/${sid}/history?since=3`)
    expect(delta.status).toBe(502)
    expect(delta.ms).toBeLessThan(1_500)
  }, 60_000)

  it('Changes and the v1 reads answer 503 host_reconnecting at once while the dial runs', async () => {
    const changes = await timed(`/api/sessions/${sid}/changes?light=1&swr=1`)
    expect(changes.status).toBe(503)
    expect(changes.body).toEqual({ error: `Reconnecting to ${hostLabel}`, code: 'host_reconnecting' })
    expect(changes.ms).toBeLessThan(1_500)

    const file = await timed(`/api/sessions/${sid}/changes/file?path=${encodeURIComponent('/srv/projects/alpha/README.md')}`)
    expect(file.status).toBe(503)
    expect(file.ms).toBeLessThan(1_500)

    for (const p of [`/api/v1/sessions/${sid}/history?tail=100`, `/api/v1/sessions/${sid}/changes?light=1`]) {
      const r = await timed(p)
      expect(r.status, p).toBe(503)
      expect((r.body.error as { code?: string } | undefined)?.code, p).toBe('host_reconnecting')
      expect(r.ms, p).toBeLessThan(1_500)
    }
  }, 60_000)

  it('the Files listing and the folder picker answer within the bound, in the host\'s own name', async () => {
    const dir = sid === CLOUD_SID ? '/srv/projects/alpha' : '/home/dev/projects/beta'
    for (const p of [
      `/api/files/list?host=${host}&path=${encodeURIComponent(dir)}`,
      `/api/files/list?host=${host}&path=${encodeURIComponent(dir)}&sessionId=${sid}&cwd=${encodeURIComponent(dir)}`,
      `/api/sessions/list-dirs?host=${host}&prefix=${encodeURIComponent(`${dir}/`)}`,
    ]) {
      const r = await timed(p)
      expect(r.status, p).toBe(503)
      expect(r.body, p).toEqual({ error: `Reconnecting to ${hostLabel}`, code: 'host_reconnecting' })
      expect(r.ms, p).toBeLessThan(1_500)
      expect(JSON.stringify(r.body), p).not.toContain(CLOUD_BOX_HOST_ALIAS)
    }
    const v1 = await timed(`/api/v1/sessions/list-dirs?host=${host}&prefix=${encodeURIComponent(`${dir}/`)}`)
    expect(v1.status).toBe(503)
    expect(v1.body).toEqual({ error: { code: 'host_reconnecting', message: `Reconnecting to ${hostLabel}` } })
    expect(v1.ms).toBeLessThan(1_500)
  }, 60_000)
})
