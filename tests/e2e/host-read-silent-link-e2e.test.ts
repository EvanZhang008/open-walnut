/**
 * The host-read deadline (core/hosts/remote-read-bound.ts) on a companion that
 * was CONNECTED and then stopped answering: the tunnel stays up, nothing comes
 * back. The pool still says connected, so the "still connecting" shortcut does
 * not apply; a read that goes quiet asks the link (one probe), and a silent
 * cloud link is closed at once.
 *
 *   primary (this process) ──silent-link proxy──▶ replica (real child process,
 *   WALNUT_CLOUD_MODE=1) ──/daemon-tunnel──▶ tunnel daemon ──▶ mock claude CLI
 *
 * Measured before this bound, every route fired at once the way a page opening
 * a session fires them: Files 30s then 500, file content 60s, the folder picker
 * 30s then 400, history 60s then 502, Changes over 130s, the slash palette 30s,
 * images 60s, quick-start's mkdir 30s; the pool noticed at 58.5s (three missed
 * 15s pings). Now every route answers within the quiet point plus one probe,
 * degraded and in the host's label, and the pool notices with it. Also pinned:
 * with no reads the cloud keepalive alone drops the link within 24 to 32s
 * (three missed 8s pings), and a slow link that still answers is never dropped:
 * the read and the liveness checks count PROGRESS (bytes from the box on any of
 * its sockets), not wall time on one socket, so a large file on one shared slow
 * link arrives instead of being cut (a 24MB read at 1MB/s was cut at 20s, every
 * retry starting over).
 *
 * Isolation as in cloud-box-tunnel-e2e: one temp base, own HOME and data dirs,
 * no pid in any fixture, only the CLI is a mock, and no real ssh is reachable
 * (tests/helpers/isolate-ssh.ts). Timings go to HOST_READ_SILENT_OUT (JSON) when
 * that is set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { seedPrimaryPairing, startCloudBoxReplica, type CloudBoxReplica } from '../helpers/cloud-box-replica.js'
import { startSilentLinkProxy, type SilentLinkProxy } from '../helpers/silent-link-proxy.js'
import { isolateFromRealSsh, type SshIsolation } from '../helpers/isolate-ssh.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-read-silent-link'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { CLOUD_BOX_HOST_ALIAS as A } from '../../src/core/hosts/cloud-box-host.js'
import { refreshCloudBoxHost } from '../../src/core/hosts/cloud-box-probe.js'
import { getDaemonConnectState } from '../../src/providers/daemon-connection.js'

const OUT = process.env.HOST_READ_SILENT_OUT
const report: Record<string, unknown> = {}
const save = () => { if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2)) }

let base = ''
let replica: CloudBoxReplica
let proxy: SilentLinkProxy
let port = 0
let sid = ''
let dir = ''
let isolation: SshIsolation | null = null

const enc = encodeURIComponent
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, init)

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms
  let last: unknown
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`)
}

async function cloudConnected(): Promise<boolean> {
  const body = await (await api('/api/hosts/status', { signal: AbortSignal.timeout(5_000) })).json() as { hosts?: Array<{ host: string; connected?: boolean }> }
  return body.hosts?.find((h) => h.host === A)?.connected === true
}

/** Polls the pool's own verdict (the status route) until stopped; the first moment it says not connected. */
function watchConnected(t0: number): { stop: () => number | null; samples: () => number } {
  let flippedAt: number | null = null
  let samples = 0
  let on = true
  void (async () => {
    while (on) {
      try {
        samples++
        if (flippedAt === null && !(await cloudConnected())) flippedAt = Date.now() - t0
      } catch { /* a slow status answer is a sample lost, not a flip */ }
      await sleep(200)
    }
  })()
  return { stop: () => { on = false; return flippedAt }, samples: () => samples }
}

/** The first moment the pool stops saying connected, in ms after `t0` (null: not within `maxMs`). */
async function untilDropped(t0: number, maxMs: number): Promise<number | null> {
  while (Date.now() - t0 < maxMs) {
    try { if (!(await cloudConnected())) return Date.now() - t0 } catch { /* a lost sample */ }
    await sleep(100)
  }
  return null
}

interface Route {
  name: string; path: string; method?: string; body?: unknown; expect: (r: Row) => void
  /** This route's own bound when it is not the wave's (a user action that waits on a dial). */
  capMs?: number
}
interface Row { route: string; status: number; ms: number; body: string; json: Record<string, unknown> | null }

async function hit(r: Route): Promise<Row> {
  const t0 = Date.now()
  let status = 0
  let body = ''
  try {
    const res = await api(r.path, {
      method: r.method ?? 'GET',
      headers: r.body ? { 'content-type': 'application/json' } : undefined,
      body: r.body ? JSON.stringify(r.body) : undefined,
      signal: AbortSignal.timeout(90_000),
    })
    status = res.status
    const ct = res.headers.get('content-type') ?? ''
    body = ct.includes('json') || ct.includes('text') ? await res.text() : `<${ct} ${(await res.arrayBuffer()).byteLength}B>`
  } catch (e) {
    body = `FETCH ERROR ${String(e)}`
  }
  let json: Record<string, unknown> | null = null
  try { json = JSON.parse(body) as Record<string, unknown> } catch { /* not json */ }
  return { route: r.name, status, ms: Date.now() - t0, body: body.slice(0, 400), json }
}

/** Every human sentence in an answer (data fields such as `host` legitimately carry the alias). */
const SENTENCE_KEYS = new Set(['error', 'message', 'staleReason', 'label', 'hint', 'detail', 'reason'])
function sentencesOf(v: unknown, key = '', out: string[] = []): string[] {
  if (typeof v === 'string') { if (SENTENCE_KEYS.has(key)) out.push(v) }
  else if (Array.isArray(v)) v.forEach((x) => sentencesOf(x, key, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) sentencesOf(x, k, out)
  return out
}

const code = (row: Row) => {
  const err = row.json?.error
  return (row.json?.code ?? (err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined)) as string | undefined
}
const reconnecting = (row: Row) => {
  expect(row.status, row.route).toBe(503)
  expect(code(row), row.route).toBe('host_reconnecting')
}

/** `waveName` is the wave the list is for: the link is still connected in `connectedSilent`. */
function routes(waveName: string): Route[] {
  const readme = `${dir}/README.md`
  const projects = `${replica.box.projects}/`
  return [
    { name: 'files/list', path: `/api/files/list?host=${A}&path=${enc(dir)}`, expect: reconnecting },
    { name: 'files/list +session', path: `/api/files/list?host=${A}&path=${enc(dir)}&sessionId=${sid}&cwd=${enc(dir)}`, expect: reconnecting },
    { name: 'files/list-many', method: 'POST', path: '/api/files/list-many', body: { paths: [dir, `${dir}/src`], host: A }, expect: (r) => expect(r.status, r.route).not.toBe(500) },
    { name: 'files/resolve-path', path: `/api/files/resolve-path?rel=README.md&cwd=${enc(dir)}&host=${A}&sessionId=${sid}`, expect: (r) => expect(r.status, r.route).not.toBe(500) },
    {
      // The viewer's payload carries its failure in `error` (200), as it always has.
      name: 'file-content', path: `/api/file-content?path=${enc(readme)}&host=${A}`,
      expect: (r) => { expect(r.status, r.route).toBe(200); expect(r.json?.content ?? null, r.route).toBeNull(); expect(r.json?.error, r.route).toMatch(/Cloud/) },
    },
    { name: 'sessions/list-dirs', path: `/api/sessions/list-dirs?host=${A}&prefix=${enc(projects)}`, expect: reconnecting },
    {
      name: 'sessions/list-dirs pending=1', path: `/api/sessions/list-dirs?host=${A}&prefix=${enc(projects)}&pending=1`,
      expect: (r) => { expect(r.status, r.route).toBe(200); expect(r.json?.pending ?? r.json?.hostError, r.route).toBeTruthy() },
    },
    { name: 'v1 sessions/list-dirs', path: `/api/v1/sessions/list-dirs?host=${A}&prefix=${enc(projects)}`, expect: reconnecting },
    {
      name: 'sessions/:id/history', path: `/api/sessions/${sid}/history?tail=400`,
      expect: (r) => { expect(r.status, r.route).toBe(200); expect(r.json?.stale, r.route).toBe(true) },
    },
    { name: 'sessions/:id/changes swr', path: `/api/sessions/${sid}/changes?light=1&swr=1`, expect: (r) => expect([200, 503], r.route).toContain(r.status) },
    { name: 'v1 sessions/:id/changes', path: `/api/v1/sessions/${sid}/changes?light=1`, expect: (r) => expect([200, 503], r.route).toContain(r.status) },
    {
      name: 'slash-commands (host)', path: `/api/slash-commands?host=${A}&cwd=${enc(dir)}&fresh=1`,
      expect: (r) => { expect(r.status, r.route).toBe(200); expect(r.json?.degraded, r.route).toBe(true) },
    },
    {
      name: 'sessions/:id/slash-commands', path: `/api/sessions/${sid}/slash-commands?fresh=1`,
      expect: (r) => { expect(r.status, r.route).toBe(200); expect(r.json?.degraded, r.route).toBe(true) },
    },
    { name: 'v1 media', path: `/api/v1/media?path=${enc(`${dir}/pic.png`)}&session=${sid}`, expect: (r) => expect(r.status, r.route).toBe(404) },
    { name: 'local-image', path: `/api/local-image?path=${enc(`${dir}/shot.png`)}&host=${A}`, expect: (r) => expect(r.status, r.route).toBe(404) },
    { name: 'v1 sessions/:id/plan', path: `/api/v1/sessions/${sid}/plan`, expect: reconnecting },
    { name: 'v1 sessions/:id/subagent history', path: `/api/v1/sessions/${sid}/subagent/abc123/history`, expect: (r) => expect([200, 503], r.route).toContain(r.status) },
    { name: 'service-preview', method: 'POST', path: `/api/sessions/${sid}/service-preview`, body: { url: 'http://localhost:8080/' }, expect: reconnecting },
    { name: 'vscode-embed', method: 'POST', path: `/api/sessions/${sid}/vscode-embed?install=false`, expect: reconnecting },
    {
      // A user action, not a background read: while the host is connecting it
      // waits for that dial (15s at most, as it always did), so a send right
      // after the folder picker started a first connect still goes through.
      // Its mkdir on a connected link is held to the read bound.
      name: 'quick-start createCwd', method: 'POST', path: '/api/sessions/quick-start',
      body: { cwd: `${dir}/fresh-dir`, host: A, createCwd: true, message: 'never sent', overrideReadiness: true },
      // The link, said as reconnecting (gate links F10: it was 400 "Cannot create
      // directory on Cloud: the connection timed out"). On the connected silent link the
      // mkdir went out before the link went quiet, so the folder may or may not exist;
      // after the drop it waits for a re-dial that never answers and sends nothing.
      expect: (r) => {
        expect(r.status, r.route).toBe(503)
        expect(r.json, r.route).toMatchObject({
          error: waveName === 'connectedSilent'
            ? 'Cloud stopped answering while creating the folder, so it may or may not exist. Try again: creating it twice is safe.'
            : 'Reconnecting to Cloud, so the folder was not created. Try again in a moment.',
          code: 'host_reconnecting',
        })
      },
      capMs: 16_500,
    },
  ]
}

/** Every route at once; each answers within `capMs`, as designed, and no sentence names the alias. */
async function wave(name: string, capMs: number): Promise<Row[]> {
  const list = routes(name)
  const rows = await Promise.all(list.map(hit))
  report[name] = rows.map(({ json, ...row }) => ({ ...row, sentences: json ? sentencesOf(json) : [], aliasAnywhere: row.body.includes(A) }))
  save()
  rows.forEach((row, i) => {
    const cap = Math.max(capMs, list[i].capMs ?? 0)
    expect(row.ms, `${row.route} took ${row.ms}ms: ${row.body}`).toBeLessThan(cap)
    const sentences = row.json ? sentencesOf(row.json) : [row.body]
    expect(sentences.filter((t) => t.includes(A)), row.route).toEqual([])
    list[i].expect(row)
  })
  return rows
}

beforeAll(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-host-read-silent-link-'))
  isolation = isolateFromRealSsh(base)
  replica = await startCloudBoxReplica(base, undefined, { machineOwner: 'mac-primary' })
  proxy = await startSilentLinkProxy(replica.port)
  dir = path.join(replica.box.projects, 'alpha')
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fsp.writeFile(path.join(WALNUT_HOME, 'config.yaml'), 'version: 1\nuser:\n  name: Tester\ndefaults:\n  priority: none\n')
  await seedPrimaryPairing(WALNUT_HOME, `127.0.0.1:${proxy.port}`, replica.tokens)
  const server = await startServer({ port: 0, dev: true })
  port = (server.address() as net.AddressInfo).port
}, 420_000)

afterAll(async () => {
  proxy?.setMode('pass')
  try { await stopServer() } catch { /* already down */ }
  await proxy?.close()
  await replica?.stop()
  isolation?.restore()
  if (process.env.DEBUG_BOX) process.stderr.write(replica?.log().slice(-6000) ?? '')
}, 90_000)

async function reconnect(): Promise<void> {
  proxy.setMode('pass')
  await api(`/api/hosts/${A}/connect`, { method: 'POST' })
  await waitFor(cloudConnected, 120_000, 'Cloud connected')
}

describe('a real companion that goes silent while connected', () => {
  it('connects, runs a turn on Cloud, and lists its files', async () => {
    await refreshCloudBoxHost()
    await api(`/api/hosts/${A}/connect`, { method: 'POST' })
    await waitFor(cloudConnected, 120_000, 'Cloud connected')
    const q = await api('/api/sessions/quick-start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: dir, host: A, message: 'snapshot-clean-turn:hello silent link', overrideReadiness: true }),
    })
    const body = await q.json() as { sessionId?: string }
    expect(q.status, JSON.stringify(body)).toBe(200)
    sid = body.sessionId!
    await waitFor(async () => {
      const f = [replica.streamFile(sid, 'mac-primary'), replica.streamFile(sid)].find((x) => fs.existsSync(x))
      return f && fs.readFileSync(f, 'utf-8').includes('"result":"hello silent link"')
    }, 120_000, 'the first turn on the box')
    // Warm the history and the listing, as an open session panel has them.
    expect((await api(`/api/sessions/${sid}/history?tail=400`)).status).toBe(200)
    const warm = await hit({ name: 'files/list warm', path: `/api/files/list?host=${A}&path=${enc(dir)}`, expect: () => {} })
    expect(warm.status).toBe(200)
    expect(warm.body).toContain('README.md')
  }, 400_000)

  it('every bounded route answers within the quiet point plus one probe, and the pool notices with them', async () => {
    proxy.setMode('blackhole')
    const t0 = Date.now()
    const dropped = untilDropped(t0, 15_000)
    await wave('connectedSilent', 10_000)
    // The probe closed the cloud link: the pool says so now, not after three missed pings.
    const droppedAt = await dropped
    report.connectedSilentPoolDroppedAtMs = droppedAt
    save()
    expect(droppedAt).not.toBeNull()
    expect(droppedAt!).toBeLessThan(10_000)

    // Every request after that, while the re-dial hangs on the silent link, answers at once
    // (or within the 5s cap of a request that started a dial).
    await wave('afterTheDrop', 6_500)
  }, 240_000)

  it('one read alone: the quiet point, then the probe, then degraded; the probe drops the link', async () => {
    await reconnect()
    await sleep(1_000)
    proxy.setMode('blackhole')
    const t0 = Date.now()
    const dropped = untilDropped(t0, 15_000)
    const row = await hit({ name: 'files/list alone', path: `/api/files/list?host=${A}&path=${enc(dir)}`, expect: reconnecting })
    const droppedAt = await dropped
    report.loneRead = { status: row.status, ms: row.ms, body: row.body, poolDroppedAtMs: droppedAt }
    save()
    expect(droppedAt).not.toBeNull()
    expect(droppedAt!).toBeLessThan(8_500)
    reconnecting(row)
    expect(row.json?.error).toBe('Reconnecting to Cloud')
    // 3s quiet + 3s probe, never the 30s command timeout.
    expect(row.ms).toBeGreaterThanOrEqual(5_500)
    expect(row.ms).toBeLessThan(8_000)
  }, 240_000)

  it('with no reads at all, the cloud keepalive drops a silent link within 24 to 32s', async () => {
    await reconnect()
    await sleep(1_000)
    proxy.setMode('blackhole')
    const t0 = Date.now()
    const at = await untilDropped(t0, 60_000)
    report.keepaliveDropAtMs = at
    save()
    expect(at).not.toBeNull()
    expect(at!).toBeGreaterThanOrEqual(20_000)
    expect(at!).toBeLessThan(36_000)
  }, 240_000)

  it('a slow link that still answers is never dropped, and its reads are answered', async () => {
    await reconnect()
    await sleep(1_000)
    proxy.setMode('slow', { delayMs: 250, bytesPerSec: 32 * 1024, shared: true })
    // Reconnects as the pool counts them: a new connection is a new connected-since clock.
    const connectedSince = getDaemonConnectState(A).connectedAt
    const t0 = Date.now()
    const watch = watchConnected(t0)
    const reads: Array<{ status: number; ms: number }> = []
    // Longer than the keepalive's three missed pings (32s) and several quiet points.
    while (Date.now() - t0 < 45_000) {
      const r = await hit({ name: 'files/list slow', path: `/api/files/list?host=${A}&path=${enc(dir)}`, expect: () => {} })
      reads.push({ status: r.status, ms: r.ms })
      await sleep(2_000)
    }
    const flipped = watch.stop()
    const after = getDaemonConnectState(A)
    report.slowLink = { flippedAtMs: flipped, samples: watch.samples(), reads, connectedSince, connectedSinceAfter: after.connectedAt }
    save()
    expect(flipped).toBeNull()
    expect(reads.every((r) => r.status === 200), JSON.stringify(reads)).toBe(true)
    // No reconnect happened behind the reads either.
    expect(after.connected).toBe(true)
    expect(after.connectedAt).toBe(connectedSince)
    proxy.setMode('pass')
  }, 240_000)

  it('a large file on one shared slow link arrives (its first 512KB) while Files keeps answering, and the link stays', async () => {
    await reconnect()
    await sleep(1_000)
    const big = path.join(dir, 'big-2m.log')
    await fsp.writeFile(big, 'a line of a large log file, 0123456789 abcdefghijklmnopqrstuvwxyz\n'.repeat(Math.ceil((2 * 1024 * 1024) / 66)))
    // One queue for both sockets: the bulk socket's 700KB of base64 holds every pong behind it.
    proxy.setMode('slow', { delayMs: 20, bytesPerSec: 64 * 1024, shared: true })
    const connectedSince = getDaemonConnectState(A).connectedAt
    const t0 = Date.now()
    const watch = watchConnected(t0)
    const file = hit({ name: 'file-content 2MB', path: `/api/file-content?path=${enc(big)}&host=${A}`, expect: () => {} })
    const lists: Array<{ status: number; ms: number }> = []
    let done = false
    void file.finally(() => { done = true })
    while (!done && Date.now() - t0 < 90_000) {
      await sleep(2_000)
      const r = await hit({ name: 'files/list beside it', path: `/api/files/list?host=${A}&path=${enc(dir)}`, expect: () => {} })
      lists.push({ status: r.status, ms: r.ms })
    }
    const row = await file
    const flipped = watch.stop()
    const after = getDaemonConnectState(A)
    report.largeOnSharedSlowLink = {
      status: row.status, ms: row.ms, chars: typeof row.json?.content === 'string' ? (row.json.content as string).length : 0,
      truncated: row.json?.truncated, error: row.json?.error, lists, flippedAtMs: flipped,
    }
    save()
    expect(row.status).toBe(200)
    expect(row.json?.error ?? null, row.body).toBeNull()
    expect((row.json?.content as string).length).toBe(512 * 1024)
    expect(row.json?.truncated).toBe(true)
    expect(row.json?.size).toBe((await fsp.stat(big)).size)
    expect(flipped).toBeNull()
    expect(after.connectedAt).toBe(connectedSince)
    expect(lists.every((r) => r.status === 200), JSON.stringify(lists)).toBe(true)
    proxy.setMode('pass')
  }, 240_000)

  it('a long history on a slow link that answers: at the stream cap the request says it is still loading, and the next one joins the read and gets it', async () => {
    await reconnect()
    await sleep(1_000)
    // The session's transcript on the box, replaced by a long one (about 3MB, its turns chained):
    // at 64KB/s one read of it takes about 90s, longer than a request may wait (60s) and
    // shorter than two waits, so a request that joins it gets it, and one that starts
    // over (behind the first, on the same link) cannot.
    const root = path.join(replica.box.home, '.claude', 'projects')
    const file = fs.readdirSync(root).map((d) => path.join(root, d, `${sid}.jsonl`)).find((f) => fs.existsSync(f))
    expect(file, 'the transcript on the box').toBeTruthy()
    const lines: string[] = []
    let size = 0
    let parent: string | null = null
    let i = 0
    for (; size < 3 * 1024 * 1024; i++) {
      const user = JSON.stringify({ type: 'user', uuid: `lh-u-${i}`, parentUuid: parent, sessionId: sid, cwd: dir, timestamp: new Date(Date.parse('2026-09-01T00:00:00Z') + i * 2000).toISOString(), message: { role: 'user', content: `long history ${i}: question` } })
      const asst = JSON.stringify({ type: 'assistant', uuid: `lh-a-${i}`, parentUuid: `lh-u-${i}`, sessionId: sid, cwd: dir, timestamp: new Date(Date.parse('2026-09-01T00:00:01Z') + i * 2000).toISOString(), message: { id: `msg_lh_${i}`, role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: `long history ${i}: answer ${'x'.repeat(4000)}` }] } })
      lines.push(user, asst)
      size += user.length + asst.length + 2
      parent = `lh-a-${i}`
    }
    await fsp.writeFile(file!, lines.join('\n') + '\n')
    const last = `long history ${i - 1}: answer`
    proxy.setMode('slow', { delayMs: 50, bytesPerSec: 64 * 1024 })
    const t0 = Date.now()
    const history = { name: 'history tail on a slow link', path: `/api/sessions/${sid}/history?tail=400`, expect: () => {} }
    // As the client does: ask again at once while the answer says "still
    // loading" (four at most, so a regression is seen, not hung on).
    const answers: Array<Awaited<ReturnType<typeof hit>> & { startedAfterMs: number }> = []
    for (let n = 0; n < 4; n++) {
      const startedAfterMs = Date.now() - t0
      const a = await hit(history)
      answers.push({ ...a, startedAfterMs })
      if (!a.json?.loading) break
    }
    const total = Date.now() - t0
    const first = answers[0]!
    const final = answers[answers.length - 1]!
    const messages = (final.json?.messages ?? []) as Array<Record<string, unknown>>
    report.longHistorySlowLink = {
      answers: answers.map((a) => ({
        status: a.status, ms: a.ms, startedAfterMs: a.startedAfterMs, stale: a.json?.stale, loading: a.json?.loading,
        messages: (a.json?.messages as unknown[] | undefined)?.length,
      })),
      totalMs: total,
    }
    save()
    proxy.setMode('pass')
    // At the cap: an answer that says the read goes on, in the host's label (not an outage).
    // Then each request joins that read, and the first after it finished gets it: ONE
    // read for all of them. How many caps that read spans is the machine's speed (a
    // loaded gate run needed two), so the shape is pinned, not the count: one or more
    // "loading", then "done", within the four asks. A read started over (2026-10-03
    // mutation: no sharing) never finished within a cap: four "loading", 229s.
    const shape = answers.map((a) => a.json?.loading ? 'loading' : 'done')
    expect(shape[shape.length - 1], `answers: ${shape.join(', ')}`).toBe('done')
    expect(shape.slice(0, -1).every((s) => s === 'loading'), `answers: ${shape.join(', ')}`).toBe(true)
    expect(shape.length).toBeGreaterThanOrEqual(2)
    expect(shape.length).toBeLessThanOrEqual(4)
    expect(first.status).toBe(200)
    expect(first.json?.stale).toBe(true)
    expect(first.json?.loading).toEqual({ from: 'Cloud' })
    expect(first.ms).toBeGreaterThanOrEqual(55_000)
    expect(first.ms).toBeLessThan(80_000)
    // Every answer before the last says the same: never an outage, never an empty history.
    for (const a of answers.slice(0, -1)) {
      expect(a.status).toBe(200)
      expect(a.json?.loading).toEqual({ from: 'Cloud' })
    }
    // The request that finds the read done gets the whole tail.
    expect(final.status).toBe(200)
    expect(final.json?.stale ?? false).toBe(false)
    expect(final.json?.loading).toBeUndefined()
    expect(messages.length).toBe(400)
    expect(JSON.stringify(messages[messages.length - 1])).toContain(last)
  }, 420_000)
})
