/**
 * host_copy through a REAL server (core/hosts/host-copy.ts, routes/host-copy-v1.ts,
 * ops/host-copy.ts, and host_exec's grants and letters): a task's session on one host
 * copies a file from or to another host only under the user's grant there, asked for
 * by ONE letter; between two other hosts it needs both. The bytes land exactly; a
 * folder, a file over the cap and a copy whose checksum fails are refused, and the
 * last two write nothing at the target. On a Mac, a place macOS guards is refused
 * until the caller passes allow_prompts. A slow copy answers running by the caller's own
 * deadline (x-walnut-answer-by) and host_copy_result waits as long as it is asked; a
 * grant the user revokes in Settings stops a copy that is under way.
 *
 * Real: the server, the inbox and its answer route, the grants file, the op executor,
 * the relay (relayFile) and each receiver's fs.writePart core. Fake: only the
 * transport to each host, a daemon in-process over a temp home
 * (tests/helpers/fake-copy-host.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { fakeCopyHost, type FakeCopyHost } from '../helpers/fake-copy-host.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-copy-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import * as daemonConnections from '../../src/providers/daemon-connection.js'
import * as sendCore from '../../src/core/sessions/session-send-core.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { __setTransferConnectionResolverForTesting } from '../../src/core/transfer/daemon-transfer-client.js'
import { MAX_COPY_BYTES, resetHostCopyForTest, setHostCopyTuningForTest } from '../../src/core/hosts/host-copy.js'
import { recordProbedFacts } from '../../src/core/hosts/host-profile.js'

let server: HttpServer
let port: number
let root: string
let taskId = ''
const SID = 'host-copy-e2e-session'
const hosts: Record<string, FakeCopyHost> = {}
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

async function api(method: string, p: string, body?: unknown, sid?: string, extra: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}

async function until(fn: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function put(host: string, rel: string, data: Buffer | string): string {
  const p = path.join(hosts[host].home, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  return p
}

const writes = (host: string) => hosts[host].sent.filter((s) => s.cmd === 'fs.writePart')
const asOp = (name: string, args: Record<string, unknown>) =>
  executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN, callerSid: SID }) as Promise<{ ok: boolean; result: Record<string, unknown>; message?: string }>

beforeAll(async () => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-copy-e2e-')))
  // The caller runs on strangerbox, a host not in Settings: its task asks the user by letter.
  for (const h of ['strangerbox', 'macbox', 'linuxbox']) hosts[h] = fakeCopyHost(path.join(root, h))
  __setTransferConnectionResolverForTesting(async (h) => (hosts[h] ? [hosts[h].conn] : []))
  // The server's own links to those hosts answer nothing (it reads their health on its own).
  const inert = (hostKey: string) => ({ connected: true, hostKey, connect: async () => {}, hasCapability: () => false, send: async () => ({ ok: false, error: 'unknown command' }) })
  const real = daemonConnections.getDaemonConnection
  vi.spyOn(daemonConnections, 'getDaemonConnection').mockImplementation(async (key, target) =>
    Object.hasOwn(hosts, key) ? inert(key) as unknown as daemonConnections.DaemonConnection : real(key, target))
  // What a session is told (the grant notice); never a real delivery into a CLI.
  vi.spyOn(sendCore, 'deliverToSession').mockImplementation((async () => ({ ok: true })) as never)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  await updateConfig({ hosts: { macbox: { hostname: 'macbox.example', label: 'Mac box' }, linuxbox: { hostname: 'linuxbox.example' } } } as never)
  const created = await api('POST', '/api/v1/tasks', { title: 'Test the iOS app' })
  taskId = created.body.task?.id ?? created.body.id
  await createSessionRecord(SID, taskId, '', '/home/me/repo', { host: 'strangerbox', title: 'iOS tests', initialProcessStatus: 'stopped' } as never)
}, 120_000)

afterAll(async () => {
  await stopServer()
  vi.restoreAllMocks()
  __setTransferConnectionResolverForTesting(null)
  setHostCopyTuningForTest(null)
  resetHostCopyForTest()
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  if (root?.includes('walnut-host-copy-e2e-')) fs.rmSync(root, { recursive: true, force: true })
})

describe('host_copy', () => {
  it('without a grant answers 403 exec_grant_required, asks by one letter, and touches no host', async () => {
    put('strangerbox', 'work/src.tgz', 'x')
    expect(await api('POST', '/api/v1/host-copy', { from: '~/work/src.tgz', to_host: 'macbox', to: '~/in/' })).toMatchObject({ status: 403, body: { code: 'session_only' } })
    const first = await api('POST', '/api/v1/host-copy', { from: '~/work/src.tgz', to_host: 'macbox', to: '~/in/' }, SID)
    expect(first).toMatchObject({ status: 403, body: { code: 'exec_grant_required', letterId: expect.any(String) } })
    const again = await api('POST', '/api/v1/host-copy', { from: '~/work/src.tgz', to_host: 'macbox', to: '~/in/' }, SID)
    expect(again.body.letterId).toBe(first.body.letterId)
    const inbox = (await api('GET', '/api/v1/human-inbox?limit=50')).body
    const asks = ((inbox.letters ?? inbox.items ?? []) as Array<{ id: string; subject: string }>).filter((l) => l.subject.includes('" use '))
    expect(asks).toMatchObject([{ id: first.body.letterId, subject: 'Let "Test the iOS app" use Mac box?' }])
    expect(Object.values(hosts).flatMap((h) => h.sent)).toEqual([])
  })

  it('after Allow the bytes land exactly, through the op an agent calls, and come back with host_copy_result', async () => {
    const letterId = (await api('POST', '/api/v1/host-copy', { from: '~/work/src.tgz', to_host: 'macbox', to: '~/in/' }, SID)).body.letterId as string
    expect((await api('POST', `/api/v1/human-inbox/${letterId}/answer`, { actionId: 'allow' })).status).toBeLessThan(300)
    await until(async () => ((await api('GET', '/api/v1/host-exec/grants')).body.grants ?? []).some((g: { host: string }) => g.host === 'macbox'), 'the grant')

    const body = crypto.randomBytes(3 * 1024 * 1024 + 5)
    put('strangerbox', 'work/src.tgz', body)
    const sent = await asOp('host_copy', { from: '~/work/src.tgz', to_host: 'macbox', to: '~/in/' })
    expect(sent).toMatchObject({ ok: true, result: { running: false, from_host: 'strangerbox', to_host: 'macbox', to: '~/in/src.tgz', bytes: body.length, sha256: sha(body), replaced: false } })
    expect(String(sent.result.outcome)).toMatch(new RegExp(`^Copied 3\\.0 MB from strangerbox:~/work/src\\.tgz to macbox:~/in/src\\.tgz in [\\d.]+ m?s \\(sha256 ${sha(body)}\\)\\.$`))
    expect(fs.readFileSync(path.join(hosts.macbox.home, 'in', 'src.tgz')).equals(body)).toBe(true)

    const read = await asOp('host_copy_result', { copy_id: String(sent.result.copyId), wait_ms: 0 })
    expect(read).toMatchObject({ ok: true, result: { running: false, sha256: sha(body) } })
    expect(await api('GET', '/api/v1/host-copy/hc-nosuch', undefined, SID)).toMatchObject({ status: 404, body: { code: 'unknown_copy' } })

    // Back to the caller's own host: only macbox's grant is needed.
    const results = crypto.randomBytes(200_000)
    put('macbox', 'build/results.tgz', results)
    const back = await api('POST', '/api/v1/host-copy', { from_host: 'macbox', from: '~/build/results.tgz', to: '~/task/' }, SID)
    expect(back).toMatchObject({ status: 200, body: { from_host: 'macbox', to_host: 'strangerbox', to: '~/task/results.tgz', bytes: results.length } })
    expect(fs.readFileSync(path.join(hosts.strangerbox.home, 'task', 'results.tgz')).equals(results)).toBe(true)
  }, 60_000)

  it('between two other hosts it needs both grants, then lands the exact bytes', async () => {
    const video = crypto.randomBytes(2 * 1024 * 1024 + 99)
    put('macbox', 'out/run.mp4', video)
    const ask = await api('POST', '/api/v1/host-copy', { from_host: 'macbox', from: '~/out/run.mp4', to_host: 'linuxbox', to: '~/videos/' }, SID)
    expect(ask).toMatchObject({ status: 403, body: { code: 'exec_grant_required' } })
    expect(hosts.linuxbox.sent).toEqual([])
    // The user's Allow in Settings (the person at this computer: no session header).
    expect((await api('POST', '/api/v1/host-exec/grants', { task_id: taskId, host: 'linuxbox' })).status).toBe(200)
    const copied = await api('POST', '/api/v1/host-copy', { from_host: 'macbox', from: '~/out/run.mp4', to_host: 'linuxbox', to: '~/videos/' }, SID)
    expect(copied).toMatchObject({ status: 200, body: { from_host: 'macbox', to_host: 'linuxbox', to: '~/videos/run.mp4', sha256: sha(video), chunks: 2 } })
    expect(fs.readFileSync(path.join(hosts.linuxbox.home, 'videos', 'run.mp4')).equals(video)).toBe(true)
  })

  it('refuses a folder, and a file over the cap before any write', async () => {
    fs.mkdirSync(path.join(hosts.macbox.home, 'DerivedData', 'Logs'), { recursive: true })
    const folder = await api('POST', '/api/v1/host-copy', { from_host: 'macbox', from: '~/DerivedData', to: '~/task/' }, SID)
    expect(folder).toMatchObject({ status: 400, body: { code: 'is_directory' } })
    expect(folder.body.error).toContain('tar -czf "$WALNUT_TASK_DIR/DerivedData.tgz" -C ~ DerivedData')
    expect(folder.body.error).toContain('host_exec on macbox')

    const before = writes('strangerbox').length
    const big = put('macbox', 'huge.xcresult.tgz', '')
    fs.truncateSync(big, MAX_COPY_BYTES + 1) // sparse
    const tooBig = await api('POST', '/api/v1/host-copy', { from_host: 'macbox', from: '~/huge.xcresult.tgz', to: '~/task/' }, SID)
    expect(tooBig).toMatchObject({ status: 413, body: { code: 'too_large', copyId: expect.stringMatching(/^hc-/) } })
    expect(writes('strangerbox').length).toBe(before)
    expect(fs.existsSync(path.join(hosts.strangerbox.home, 'task', 'huge.xcresult.tgz'))).toBe(false)
  })

  it('a checksum failure is reported and leaves no target file', async () => {
    put('strangerbox', 'work/app.ipa', crypto.randomBytes(500_000))
    hosts.macbox.knobs.corrupt = true
    try {
      const r = await asOp('host_copy', { from: '~/work/app.ipa', to_host: 'macbox', to: '~/in/app.ipa' })
      expect(r.ok).toBe(false)
      expect(String(r.message)).toContain('does not match what was read from strangerbox:~/work/app.ipa (sha256)')
      const direct = await api('POST', '/api/v1/host-copy', { from: '~/work/app.ipa', to_host: 'macbox', to: '~/in/app.ipa' }, SID)
      expect(direct).toMatchObject({ status: 502, body: { code: 'checksum_mismatch' } })
      expect(fs.existsSync(path.join(hosts.macbox.home, 'in', 'app.ipa'))).toBe(false)
      expect(fs.existsSync(path.join(hosts.macbox.home, 'in', 'app.ipa.walnut-part'))).toBe(false)
    } finally {
      hosts.macbox.knobs.corrupt = false
    }
  })

  it('on a Mac, a place macOS guards is refused (409 may_prompt) until the caller passes allow_prompts', async () => {
    // What macbox's daemon reported: a Mac.
    await recordProbedFacts('macbox', { os: { platform: 'darwin' }, home: hosts.macbox.home } as never)
    put('strangerbox', 'work/notes.pdf', 'pdf bytes')
    const before = hosts.macbox.sent.length
    const refused = await api('POST', '/api/v1/host-copy', { from: '~/work/notes.pdf', to_host: 'macbox', to: '~/Downloads/' }, SID)
    expect(refused).toMatchObject({ status: 409, body: { code: 'may_prompt', prompt: 'macbox:~/Downloads/' } })
    expect(refused.body.error).toContain('permission dialog on Mac box\'s screen')
    expect(hosts.macbox.sent.length).toBe(before)
    const sent = await asOp('host_copy', { from: '~/work/notes.pdf', to_host: 'macbox', to: '~/Downloads/', allow_prompts: true })
    expect(sent).toMatchObject({ ok: true, result: { to: '~/Downloads/notes.pdf', bytes: 9 } })
    expect(fs.readFileSync(path.join(hosts.macbox.home, 'Downloads', 'notes.pdf'), 'utf8')).toBe('pdf bytes')
  })

  it('a slow copy answers running by the caller\'s own deadline, and host_copy_result waits as long as it is asked', async () => {
    setHostCopyTuningForTest({ chunkBytes: 64 * 1024 })
    hosts.strangerbox.knobs.readDelayMs = 100 // 40 parts: about 4 s
    try {
      const body = crypto.randomBytes(40 * 64 * 1024)
      put('strangerbox', 'work/slow.tgz', body)
      // Its gateway gives up 9.5 s from now: 8 s are kept for the way back, so the call answers in about half a second.
      const t0 = Date.now()
      const first = await api('POST', '/api/v1/host-copy', { from: '~/work/slow.tgz', to_host: 'macbox', to: '~/in/' }, SID, { 'x-walnut-answer-by': String(Date.now() + 9_500) })
      const took = Date.now() - t0
      expect(first).toMatchObject({ status: 200, body: { running: true, copyId: expect.stringMatching(/^hc-/), to: '~/in/slow.tgz', bytes: body.length } })
      expect(took).toBeLessThan(3_000) // without the header a session on another host waits up to 11 s
      // wait_ms rides through the op to the route: 200 ms, not the call's whole hold.
      const t1 = Date.now()
      const peek = await asOp('host_copy_result', { copy_id: String(first.body.copyId), wait_ms: 200 })
      expect(peek).toMatchObject({ ok: true, result: { running: true, copyId: first.body.copyId } })
      expect(String(peek.result.outcome)).toContain(`as copy ${first.body.copyId}`)
      expect(Date.now() - t1).toBeLessThan(2_000)
      const done = await asOp('host_copy_result', { copy_id: String(first.body.copyId), wait_ms: 60_000 })
      expect(done).toMatchObject({ ok: true, result: { running: false, sha256: sha(body), chunks: 40 } })
      expect(fs.readFileSync(path.join(hosts.macbox.home, 'in', 'slow.tgz')).equals(body)).toBe(true)
    } finally {
      hosts.strangerbox.knobs.readDelayMs = 0
      setHostCopyTuningForTest(null)
    }
  }, 60_000)

  // Last: it revokes macbox's grant.
  it('a grant revoked in Settings stops a copy under way at its next check, and the receiver is not touched again', async () => {
    setHostCopyTuningForTest({ chunkBytes: 64 * 1024 }) // the real 5 s between grant checks
    hosts.strangerbox.knobs.readDelayMs = 50 // 200 parts: about 10 s
    try {
      put('strangerbox', 'work/big.tgz', crypto.randomBytes(200 * 64 * 1024))
      const before = writes('macbox').length
      const sentBefore = hosts.macbox.sent.length
      const t0 = Date.now()
      const copying = api('POST', '/api/v1/host-copy', { from: '~/work/big.tgz', to_host: 'macbox', to: '~/in/big.tgz' }, SID)
      await until(async () => writes('macbox').length > before + 2, 'the first parts')
      const grant = ((await api('GET', '/api/v1/host-exec/grants')).body.grants as Array<{ id: string; host: string; taskId: string }>)
        .find((g) => g.host === 'macbox' && g.taskId === taskId)!
      expect((await api('DELETE', `/api/v1/host-exec/grants/${grant.id}`)).status).toBe(200)
      const stopped = await copying
      expect(stopped).toMatchObject({ status: 403, body: { code: 'exec_grant_revoked', copyId: expect.stringMatching(/^hc-/), partialLeft: '~/in/big.tgz.walnut-part' } })
      expect(stopped.body.error).toContain('delete it with host_exec on macbox')
      // Stopped by the 5-second check, long before the check ahead of the last part.
      const parts = writes('macbox').slice(before)
      expect(parts.length).toBeLessThan(180)
      expect(parts.some((s) => s.params.final)).toBe(false)
      expect(Date.now() - t0).toBeLessThan(9_000)
      expect(hosts.macbox.sent.slice(sentBefore).some((s) => s.cmd === 'fs.rm')).toBe(false)
      expect(fs.existsSync(path.join(hosts.macbox.home, 'in', 'big.tgz'))).toBe(false)
      expect(fs.existsSync(path.join(hosts.macbox.home, 'in', 'big.tgz.walnut-part'))).toBe(true)
    } finally {
      hosts.strangerbox.knobs.readDelayMs = 0
      setHostCopyTuningForTest(null)
    }
  }, 60_000)
})
