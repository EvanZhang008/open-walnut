/**
 * A Walnut call that got no answer is counted (lib/no-answer-report.ts, usage-watch/record.ts).
 *
 * 2026-11-24 daily audit: session transcripts held 12 failures where no Walnut answered and
 * `usage_watch errors` held 3; `no_daemon` had no row at all. Every one of the 9 missed fell inside a
 * deploy restart (server_stopping to server listening): the session hook counts a failed call only
 * while the server reads the session's lines live, and the recorder dropped what it was told before
 * it started. Now the client that saw the failure tells the hub with its next call that gets through,
 * the recorder keeps what it is told before it starts, and a failure both the hook and the client
 * tell counts once. One case per shape the audit missed: the MCP server's `no_daemon` (the gateway
 * socket gone), `hub_timeout` (the daemon restarted holding the call), `hub_unreachable` (a stopping
 * daemon's answer), and the CLI's exit-1 `hub_unreachable` and `daemon_unreachable`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeUsageWatchStore, readToolErrors, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { _resetUsageRecorderForTesting, flushUsage, recordToolError, startUsageRecorder, stopUsageRecorder } from '../../../src/core/usage-watch/record.js'
import { recordNoAnswers } from '../../../src/core/usage-watch/gateway-record.js'
import { handleGatewayCapability, type CapabilityRouterDeps } from '../../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../../src/core/peers/peer-throttle.js'
import {
  hubAnswered, noAnswerSpoolFile, noAnswersOf, spoolHoldsNoAnswers, spoolNoAnswer, takeSpooledNoAnswers, tellSpooledNoAnswers,
} from '../../../src/lib/no-answer-report.js'
import { noteSessionFailure } from '../../../src/providers/session-no-answer.js'
import { createWalnutMcpHandler } from '../../../src/providers/walnut-mcp-stdio.js'
import type { GatewayResponse } from '../../../src/providers/gateway-core.js'

let dir: string
const SID = '3a7c1e52-6b0d-4f19-8e2a-5c4d9b7f0a11'
const taskOf = async () => 'mtaskaaa-0001'
const rows = () => { flushUsage(); return readToolErrors({ since: 0, limit: 100 }).sort((a, b) => a.at - b.at) }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-answer-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true, Date.now() - 3_600_000)
})

afterEach(() => {
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a client\'s report of calls no Walnut answered', () => {
  it('counts each shape the audit missed at the time it failed, with the session\'s task', async () => {
    const now = Date.parse('2026-11-24T10:38:10Z')
    const report = { no_answer: [
      { op: 'host_exec', code: 'no_daemon', client: 'mcp', ms: 27_000 },
      { op: 'subagent_send', code: 'hub_timeout', client: 'mcp', ms: 20_000 },
      { op: 'host_exec', code: 'hub_unreachable', client: 'mcp', ms: 15_000 },
      { op: 'host_copy', code: 'hub_unreachable', client: 'cli', ms: 10_000 },
      { op: 'task_get', code: 'daemon_unreachable', client: 'cli', ms: 5_000 },
    ] }
    expect(await recordNoAnswers(SID, '__local__', report, taskOf, now)).toBe(5)
    expect(rows().map((r) => ({ at: new Date(r.at).toISOString(), op: r.op, code: r.code, client: r.client, host: r.host, taskId: r.taskId }))).toEqual([
      { at: '2026-11-24T10:37:43.000Z', op: 'host_exec', code: 'no_daemon', client: 'mcp', host: 'local', taskId: 'mtaskaaa-0001' },
      { at: '2026-11-24T10:37:50.000Z', op: 'subagent_send', code: 'hub_timeout', client: 'mcp', host: 'local', taskId: 'mtaskaaa-0001' },
      { at: '2026-11-24T10:37:55.000Z', op: 'host_exec', code: 'hub_unreachable', client: 'mcp', host: 'local', taskId: 'mtaskaaa-0001' },
      { at: '2026-11-24T10:38:00.000Z', op: 'host_copy', code: 'hub_unreachable', client: 'cli', host: 'local', taskId: 'mtaskaaa-0001' },
      { at: '2026-11-24T10:38:05.000Z', op: 'task_get', code: 'daemon_unreachable', client: 'cli', host: 'local', taskId: 'mtaskaaa-0001' },
    ])
  })

  it('names only ops, no-answer codes, a client and how long ago: anything else is dropped', () => {
    expect(noAnswersOf({ no_answer: [
      { op: 'task_get', code: 'no_daemon', client: 'mcp', ms: 5 },
      { op: 'Task Get', code: 'no_daemon', client: 'mcp', ms: 5 },
      { op: 'task_get', code: 'bad_args', client: 'mcp', ms: 5 },
      { op: 'task_get', code: 'no_daemon', client: 'browser', ms: 5 },
      { op: 'task_get', code: 'no_daemon', client: 'cli', ms: -1 },
      { op: 'task_get', code: 'no_daemon', client: 'cli', ms: 2 * 86_400_000 },
    ] })).toEqual([{ op: 'task_get', code: 'no_daemon', client: 'mcp', ms: 5 }])
    expect(noAnswersOf({ short_list: { given: 0, full: 3, ms: 1 } })).toEqual([])
    expect(noAnswersOf(null)).toEqual([])
  })

  it('the hub takes it on tools.list, beside a short list, and a bare walnut counts nothing', async () => {
    const deps: CapabilityRouterDeps = { throttle: new PeerThrottle(), cloudMode: false, taskOfCaller: taskOf, pluginsLoading: async () => false, listingRole: async () => undefined }
    expect(await handleGatewayCapability('tools.list', SID, { report: { no_answer: [{ op: 'task_create', code: 'no_daemon', client: 'mcp', ms: 4_000 }] } }, 'clouddev', deps))
      .toEqual({ ok: true, result: { recorded: true, no_answer: 1 } })
    const { EXTERNAL_CALLER_SID } = await import('../../../src/providers/gateway-core.js')
    expect(await handleGatewayCapability('tools.list', EXTERNAL_CALLER_SID, { report: { no_answer: [{ op: 'task_create', code: 'no_daemon', client: 'cli', ms: 4_000 }] } }, 'clouddev', deps))
      .toEqual({ ok: true, result: { recorded: false } })
    expect(rows().map((r) => [r.op, r.code, r.host, r.taskId])).toEqual([['task_create', 'no_daemon', 'clouddev', 'mtaskaaa-0001']])
  })
})

describe('the recorder and the hook', () => {
  it('keeps what it is told before it starts: a server\'s first seconds after a restart', () => {
    _resetUsageRecorderForTesting(false)
    recordToolError({ sid: SID, host: 'local', op: 'host_exec', client: 'mcp', code: 'no_daemon' })
    startUsageRecorder()
    try { expect(rows().map((r) => r.code)).toEqual(['no_daemon']) } finally { stopUsageRecorder() }
  })

  it('a failure the hook read live and the client then reports counts once; two real retries stay two', async () => {
    const now = Date.now()
    recordToolError({ at: now - 30_000, sid: SID, host: 'local', op: 'task_create', client: 'mcp', code: 'no_daemon' })
    recordToolError({ at: now - 25_000, sid: SID, host: 'local', op: 'task_create', client: 'mcp', code: 'no_daemon' })
    // The client tells both, a few seconds off the hook's clock, plus one the hook never saw.
    expect(await recordNoAnswers(SID, 'local', { no_answer: [
      { op: 'task_create', code: 'no_daemon', client: 'mcp', ms: 28_000 },
      { op: 'task_create', code: 'no_daemon', client: 'mcp', ms: 23_000 },
      { op: 'task_send', code: 'no_daemon', client: 'mcp', ms: 20_000 },
    ] }, taskOf, now)).toBe(1)
    // The other order: the client's report first, the hook's late read of the same result after it.
    expect(recordToolError({ at: now - 19_000, sid: SID, host: 'local', op: 'task_send', client: 'mcp', code: 'no_daemon' })).toBe(false)
    expect(rows().map((r) => r.op)).toEqual(['task_create', 'task_create', 'task_send'])
  })

  it('a report of a failure hours old never clears what waits for its match (2026-11-24 review)', async () => {
    const now = Date.now()
    recordToolError({ at: now - 10_000, sid: SID, host: 'local', op: 'task_get', client: 'mcp', code: 'no_daemon' })
    expect(await recordNoAnswers(SID, 'local', { no_answer: [{ op: 'task_get', code: 'no_daemon', client: 'mcp', ms: 3 * 3600_000 }] }, taskOf, now)).toBe(1)
    // The hook's own failure is still there to match the client's report of it.
    expect(await recordNoAnswers(SID, 'local', { no_answer: [{ op: 'task_get', code: 'no_daemon', client: 'mcp', ms: 9_000 }] }, taskOf, now)).toBe(0)
  })

  it('a report of a failure the hook recorded before this server started is not counted again', async () => {
    const at = Date.now() - 60_000
    recordToolError({ at, sid: SID, host: 'local', op: 'host_exec', client: 'mcp', code: 'hub_timeout' })
    flushUsage()
    // A restart: this server's recorder starts now, with nothing of the old one in memory.
    _resetUsageRecorderForTesting(true, Date.now())
    expect(await recordNoAnswers(SID, 'local', { no_answer: [{ op: 'host_exec', code: 'hub_timeout', client: 'mcp', ms: 58_000 }] }, taskOf)).toBe(0)
    expect(await recordNoAnswers(SID, 'local', { no_answer: [{ op: 'host_exec', code: 'hub_timeout', client: 'mcp', ms: 50_000 }] }, taskOf)).toBe(1)
    expect(rows().map((r) => r.code)).toEqual(['hub_timeout', 'hub_timeout'])
  })

  it('a report whose answer was slow lands, is sent again with the next call, and counts once (2026-11-25 review)', async () => {
    const file = noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)
    spoolNoAnswer(file, 'task_get', 'hub_unreachable', 'cli', Date.now() - 20_000)
    spoolNoAnswer(file, 'task_get', 'hub_unreachable', 'cli', Date.now() - 10_000)
    // The server takes it, but its answer comes after the client gave up: the lines stay.
    await tellSpooledNoAnswers(file, async (report) => { await recordNoAnswers(SID, 'local', { no_answer: report }, taskOf); throw new Error('timed out') })
    expect(spoolHoldsNoAnswers(file)).toBe(true)
    let counted = -1
    await tellSpooledNoAnswers(file, async (report) => { counted = await recordNoAnswers(SID, 'local', { no_answer: report }, taskOf); return { ok: true, result: { recorded: true } } })
    expect(counted).toBe(0)
    expect(spoolHoldsNoAnswers(file)).toBe(false)
    // Two real failures of one op stay two.
    expect(rows().map((r) => r.op)).toEqual(['task_get', 'task_get'])
  })

  it('a resend after a server restart is counted once: the ids outlive the process (B2)', async () => {
    const report = { no_answer: [{ op: 'task_get', code: 'hub_unreachable', client: 'cli', ms: 300_000, id: 'abcdef0123456789' }] }
    expect(await recordNoAnswers(SID, 'local', report, taskOf)).toBe(1)
    flushUsage()
    // A restart, told in the new server's first seconds, before its recorder starts (it keeps what it is
    // told then): nothing of the old process is in memory and no start time to match the store by.
    _resetUsageRecorderForTesting(false, 0)
    expect(await recordNoAnswers(SID, 'local', report, taskOf)).toBe(0)
    // And once it runs.
    _resetUsageRecorderForTesting(true, Date.now())
    expect(await recordNoAnswers(SID, 'local', report, taskOf)).toBe(0)
    expect(rows()).toHaveLength(1)
  })

  it('other codes are never matched away: each failure the hook reads counts', () => {
    recordToolError({ sid: SID, host: 'local', op: 'search', client: 'mcp', code: 'bad_args' })
    recordToolError({ sid: SID, host: 'local', op: 'search', client: 'mcp', code: 'bad_args' }, 'client')
    expect(rows()).toHaveLength(2)
  })
})

describe('the Walnut MCP server tells its calls no Walnut answered with its next call that gets through', () => {
  const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]
  const spoolOf = () => noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)
  const call = (handle: ReturnType<typeof createWalnutMcpHandler>, id: number, name: string) =>
    handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })

  it('no_daemon, hub_unreachable and hub_timeout, then one report after a call that worked', async () => {
    const answers: Array<() => Promise<GatewayResponse>> = [
      async () => { throw Object.assign(new Error('connect ENOENT /tmp/open-walnut/agent-gateway.sock'), { code: 'ENOENT' }) },
      async () => ({ ok: false, error: { code: 'hub_unreachable', message: 'daemon is shutting down', detail: { stopping: true } } }),
      async () => ({ ok: false, error: { code: 'hub_timeout', message: 'the daemon restarted while the Walnut server had this call' } }),
    ]
    const reports: unknown[] = []
    const handle = createWalnutMcpHandler({
      formatError, lostFollowMs: 1, noAnswerSpool: spoolOf(),
      request: async (op, args) => {
        if (op === 'tools.list') { reports.push(args.report); return { ok: true, result: { recorded: true } } }
        if ((args as { name?: string }).name === 'op_result') return { ok: false, error: { code: 'hub_timeout', message: 'x' } }
        const next = answers.shift()
        return next ? next() : { ok: true, result: { id: 'x' } }
      },
    })
    for (const [i, op] of (['task_create', 'host_exec', 'subagent_send'] as const).entries()) {
      expect(((await call(handle, i + 1, op))?.result as { isError?: boolean }).isError).toBe(true)
    }
    expect(reports).toEqual([])
    await call(handle, 9, 'task_get')
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(reports).toEqual([{ no_answer: [
      { op: 'task_create', code: 'no_daemon', client: 'mcp', ms: expect.any(Number), id: expect.any(String) },
      { op: 'host_exec', code: 'hub_unreachable', client: 'mcp', ms: expect.any(Number), id: expect.any(String) },
      { op: 'subagent_send', code: 'hub_timeout', client: 'mcp', ms: expect.any(Number), id: expect.any(String) },
    ] }])
    // Told once: the next call that works sends nothing more (a report goes before the answer it rides
    // returns, so the answer of a third call shows the second sent none).
    await call(handle, 10, 'task_get')
    await call(handle, 11, 'task_get')
    expect(reports).toHaveLength(1)
  })

  it('an op\'s own refusal is no no-answer, and a report that did not go is kept for the next', async () => {
    let up = false
    const reports: unknown[] = []
    const handle = createWalnutMcpHandler({
      formatError, noAnswerSpool: spoolOf(),
      request: async (op, args) => {
        if (op === 'tools.list') { reports.push(args.report); return up ? { ok: true, result: {} } : { ok: false, error: { code: 'hub_unreachable', message: 'away' } } }
        if ((args as { name?: string }).name === 'bad') return { ok: false, error: { code: 'bad_request', message: 'Invalid arguments for bad' } }
        if ((args as { name?: string }).name === 'gone') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        return { ok: true, result: {} }
      },
    })
    await call(handle, 1, 'bad')
    await call(handle, 2, 'gone')
    await call(handle, 3, 'task_get')
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    up = true
    await call(handle, 4, 'task_get')
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    const told = (r: unknown) => (r as { no_answer: Array<{ op: string; code: string }> }).no_answer.map((n) => `${n.op}:${n.code}`)
    expect(reports.map(told)).toEqual([['gone:no_daemon'], ['gone:no_daemon']])
  })
})

describe('the CLI keeps them beside the daemon socket, one file per session', () => {
  it('kept, read oldest first, and left on disk until the server took them; told drops exactly those', () => {
    const sock = path.join(dir, 'agent-gateway.sock')
    const file = noAnswerSpoolFile(sock, SID)
    expect(file).toBe(path.join(dir, 'no-answer', `${SID}.ndjson`))
    expect(noAnswerSpoolFile(sock, '../etc')).toBeNull()
    expect(spoolHoldsNoAnswers(file)).toBe(false)
    const t0 = Date.parse('2026-11-23T16:35:16Z')
    spoolNoAnswer(file, 'task_get', 'daemon_unreachable', 'cli', t0 + 1_000)
    spoolNoAnswer(file, 'task_get', 'bad_args', 'cli', t0)
    spoolNoAnswer(file, 'host_copy', 'hub_unreachable', 'cli', t0)
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600)
    const first = takeSpooledNoAnswers(file, t0 + 11_000)
    expect(first.report).toEqual([
      { op: 'host_copy', code: 'hub_unreachable', client: 'cli', ms: 11_000, id: expect.stringMatching(/^[a-z0-9]{6,40}$/) },
      { op: 'task_get', code: 'daemon_unreachable', client: 'cli', ms: 10_000, id: expect.stringMatching(/^[a-z0-9]{6,40}$/) },
    ])
    // Not told yet: still on disk, the same lines with the same ids (2026-11-25 review: once taken they
    // lived only in the taking process's memory).
    expect(spoolHoldsNoAnswers(file)).toBe(true)
    expect(takeSpooledNoAnswers(file, t0 + 11_000).report).toEqual(first.report)
    // One more comes in before the first report is told: telling drops only what it sent.
    spoolNoAnswer(file, 'task_send', 'no_daemon', 'mcp', t0 + 5_000)
    first.told()
    expect(takeSpooledNoAnswers(file, t0 + 11_000).report.map((r) => r.op)).toEqual(['task_send'])
  })

  it('a night of failures stays small and keeps its newest, told 50 at a time (2026-11-25 review: past 64 KB all were lost)', () => {
    const file = noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)
    const t0 = Date.now() - 3_600_000
    for (let i = 0; i < 1_000; i++) spoolNoAnswer(file, `op_${i}`, 'hub_unreachable', 'mcp', t0 + i)
    expect(fs.statSync(file!).size).toBeLessThan(20 * 1024)
    const { report, told } = takeSpooledNoAnswers(file)
    expect(report).toHaveLength(50)
    expect(report[0].op).toBe('op_950')
    expect(report[49].op).toBe('op_999')
    told()
    // What the cap kept beyond the newest 50 is told next, never dropped unread.
    const rest = takeSpooledNoAnswers(file).report
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every((r) => Number(r.op.slice(3)) < 950)).toBe(true)
  })

  it('a file grown past the read limit anyway is read by its tail', () => {
    const file = noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)!
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const t0 = Date.now() - 3_600_000
    // An older client wrote 2,000 lines with no id and no cap.
    fs.writeFileSync(file, Array.from({ length: 2_000 }, (_, i) => JSON.stringify({ at: t0 + i, op: `op_${i}`, code: 'no_daemon', client: 'cli' })).join('\n') + '\n', { mode: 0o600 })
    const { report } = takeSpooledNoAnswers(file)
    expect(report.map((r) => r.op).slice(-2)).toEqual(['op_1998', 'op_1999'])
    expect(report).toHaveLength(50)
    // A line with no id gets the same id for every reader, so two of them telling it count it once.
    expect(takeSpooledNoAnswers(file).report.map((r) => r.id)).toEqual(report.map((r) => r.id))
  })

  it('what a rewrite left aside is put back once it is old, whatever its pid; a fresh one is a rewrite in progress', () => {
    const file = noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)!
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const line = (op: string) => JSON.stringify({ at: Date.now() - 1_000, op, code: 'no_daemon', client: 'mcp', id: `id${op.replace(/_/g, '')}0000` }) + '\n'
    const aged = (f: string, ms: number) => { const t = new Date(Date.now() - ms); fs.utimesSync(f, t, t) }
    // A pid that is alive (this test's parent) or reused does not keep an old one forever (B5).
    fs.writeFileSync(`${file}.${process.ppid}.ab12.taking`, line('task_alive_pid'), { mode: 0o600 })
    aged(`${file}.${process.ppid}.ab12.taking`, 60_000)
    // The name an earlier reclaim left (`.taking.<pid>`) is read too (B4).
    fs.writeFileSync(`${file}.999999999.cd34.taking.4242`, line('task_old_name'), { mode: 0o600 })
    aged(`${file}.999999999.cd34.taking.4242`, 60_000)
    // Moved aside a moment ago: another process's rewrite, left alone whatever its pid.
    fs.writeFileSync(`${file}.999999999.ef56.taking`, line('task_fresh'), { mode: 0o600 })
    expect(spoolHoldsNoAnswers(file)).toBe(true)
    const { report } = takeSpooledNoAnswers(file)
    expect(report.map((r) => r.op).sort()).toEqual(['task_alive_pid', 'task_old_name'])
    expect(fs.existsSync(`${file}.${process.ppid}.ab12.taking`)).toBe(false)
    expect(fs.existsSync(`${file}.999999999.cd34.taking.4242`)).toBe(false)
    expect(fs.existsSync(`${file}.999999999.ef56.taking`)).toBe(true)
  })

  it('a tail that starts right at a line keeps that line (B3)', () => {
    const file = noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)!
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // Lines of exactly 128 bytes: the 64 KB tail of 600 of them starts exactly at line 88.
    const t0 = Date.now() - 3_600_000
    const lineOf = (i: number) => {
      const base = { at: t0 + i, op: `op_${String(i).padStart(4, '0')}`, code: 'no_daemon', client: 'cli', id: `x${String(i).padStart(5, '0')}` }
      const bare = JSON.stringify(base)
      return JSON.stringify({ ...base, id: `x${String(i).padStart(5, '0')}${'a'.repeat(127 - bare.length)}` })
    }
    const lines = Array.from({ length: 600 }, (_, i) => lineOf(i))
    expect(lines.every((l) => l.length === 127)).toBe(true)
    fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
    const { report, told } = takeSpooledNoAnswers(file)
    expect(report).toHaveLength(50)
    told()
    // The tail held lines 88 to 599: 512, of which 50 were told.
    const left = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).op as string)
    expect(left).toHaveLength(462)
    expect(left[0]).toBe('op_0088')
  })

  it('one report of a spool at a time: two calls ending together send it once (B1)', async () => {
    const file = noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)
    spoolNoAnswer(file, 'task_get', 'hub_unreachable', 'mcp', Date.now() - 5_000)
    const sent: unknown[] = []
    let let_go: () => void = () => {}
    const slow = new Promise<void>((r) => { let_go = r })
    const send = async (report: unknown) => { sent.push(report); await slow; return { ok: true, result: { recorded: true } } }
    const first = tellSpooledNoAnswers(file, send)
    const second = tellSpooledNoAnswers(file, send)
    await second
    let_go()
    await first
    expect(sent).toHaveLength(1)
    expect(spoolHoldsNoAnswers(file)).toBe(false)
  })

  it('another process sending holds the spool; a mark it left when it ended is taken over (B1)', async () => {
    const file = noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)!
    spoolNoAnswer(file, 'task_get', 'hub_unreachable', 'cli', Date.now() - 5_000)
    const sent: unknown[] = []
    const send = async (report: unknown) => { sent.push(report); return { ok: true, result: { recorded: true } } }
    fs.writeFileSync(`${file}.sending`, '', { mode: 0o600 })
    await tellSpooledNoAnswers(file, send)
    expect(sent).toHaveLength(0)
    expect(spoolHoldsNoAnswers(file)).toBe(true)
    const t = new Date(Date.now() - 20_000)
    fs.utimesSync(`${file}.sending`, t, t)
    await tellSpooledNoAnswers(file, send)
    expect(sent).toHaveLength(1)
    expect(fs.existsSync(`${file}.sending`)).toBe(false)
  })

  it('never writes through a link planted where the file goes', () => {
    const sock = path.join(dir, 'agent-gateway.sock')
    const file = noAnswerSpoolFile(sock, SID)!
    const target = path.join(dir, 'target.txt')
    fs.writeFileSync(target, 'mine\n')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.symlinkSync(target, file)
    spoolNoAnswer(file, 'task_get', 'no_daemon', 'cli')
    expect(fs.readFileSync(target, 'utf-8')).toBe('mine\n')
  })

  it('never writes into a spool folder that is a link, or that others can open', () => {
    const sock = path.join(dir, 'agent-gateway.sock')
    const file = noAnswerSpoolFile(sock, SID)!
    const elsewhere = path.join(dir, 'elsewhere')
    fs.mkdirSync(elsewhere, { mode: 0o700 })
    fs.symlinkSync(elsewhere, path.dirname(file))
    spoolNoAnswer(file, 'task_get', 'no_daemon', 'cli')
    expect(fs.readdirSync(elsewhere)).toEqual([])
    fs.rmSync(path.dirname(file))
    fs.mkdirSync(path.dirname(file), { mode: 0o755 })
    fs.chmodSync(path.dirname(file), 0o755)
    spoolNoAnswer(file, 'task_get', 'no_daemon', 'cli')
    expect(fs.existsSync(file)).toBe(false)
    fs.chmodSync(path.dirname(file), 0o700)
    spoolNoAnswer(file, 'task_get', 'no_daemon', 'cli')
    expect(fs.existsSync(file)).toBe(true)
  })

})

describe('2026-11-25 audit: every client of a session keeps its failures in one place, and only the server takes a report', () => {
  const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]
  const spoolOf = () => noAnswerSpoolFile(path.join(dir, 'agent-gateway.sock'), SID)
  const call = (handle: ReturnType<typeof createWalnutMcpHandler>, id: number, name: string) =>
    handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })
  const told = (r: unknown) => (r as { no_answer: Array<{ op: string; code: string; client: string }> }).no_answer.map((n) => `${n.client}:${n.op}:${n.code}`)

  it('a report the host daemon answered for an away server (its offline catalog) is kept, and told once the server is back', async () => {
    // task_get cffc7f02, 22:05:24: no_daemon, then a call answered 4 s later, and no row.
    let back = false
    const reports: unknown[] = []
    let first = true
    let offlineCall = false
    const handle = createWalnutMcpHandler({
      formatError, noAnswerSpool: spoolOf(),
      request: async (op, args) => {
        if (op === 'tools.list') {
          reports.push(args.report)
          return back ? { ok: true, result: { recorded: true, no_answer: 1 } } : { ok: true, result: { ops: [{ name: 'task_get' }], offline: true, hint: 'away' } }
        }
        if (first) { first = false; throw Object.assign(new Error('connect ENOENT /tmp/open-walnut/agent-gateway.sock'), { code: 'ENOENT' }) }
        return { ok: true, result: offlineCall ? { id: 'x', offline: true } : { id: 'x' } }
      },
    })
    await call(handle, 1, 'task_get')
    // Answered from the daemon's own copy: no sign the hub is back, so nothing is told.
    offlineCall = true
    await call(handle, 2, 'task_get')
    expect(reports).toHaveLength(0)
    // The hub's answer, but the report is answered by the daemon for an away hub: kept.
    offlineCall = false
    await call(handle, 3, 'task_get')
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    await vi.waitFor(() => expect(spoolHoldsNoAnswers(spoolOf())).toBe(true))
    back = true
    await call(handle, 4, 'task_get')
    await vi.waitFor(() => expect(reports).toHaveLength(2))
    expect(told(reports[1])).toEqual(['mcp:task_get:no_daemon'])
    await vi.waitFor(() => expect(spoolHoldsNoAnswers(spoolOf())).toBe(false))
  })

  it('a failure outlives the MCP process that saw it: the session\'s next process tells it', async () => {
    const reports: unknown[] = []
    const gone = createWalnutMcpHandler({
      formatError, noAnswerSpool: spoolOf(),
      request: async () => ({ ok: false, error: { code: 'hub_unreachable', message: 'daemon is shutting down', detail: { stopping: true } } }),
    })
    await call(gone, 1, 'task_send')
    // That process ends; the session's next one gets through.
    const next = createWalnutMcpHandler({
      formatError, noAnswerSpool: spoolOf(),
      request: async (op, args) => {
        if (op === 'tools.list') { reports.push(args.report); return { ok: true, result: { recorded: true } } }
        return { ok: true, result: {} }
      },
    })
    await call(next, 1, 'task_get')
    await vi.waitFor(() => expect(reports).toHaveLength(1))
    expect(told(reports[0])).toEqual(['mcp:task_send:hub_unreachable'])
  })

  it('a caller with no session of its own keeps nothing', async () => {
    const handle = createWalnutMcpHandler({ formatError, request: async () => ({ ok: false, error: { code: 'hub_unreachable', message: 'away' } }) })
    await call(handle, 1, 'task_get')
    expect(fs.existsSync(path.join(dir, 'no-answer'))).toBe(false)
  })

  it('the server took it only when it answered as itself', () => {
    expect(hubAnswered({ ok: true, result: { recorded: true } })).toBe(true)
    expect(hubAnswered({ ok: true, result: { recorded: false } })).toBe(true)
    expect(hubAnswered({ ok: true, result: { ops: [], offline: true } })).toBe(false)
    expect(hubAnswered({ ok: false })).toBe(false)
    expect(hubAnswered(null)).toBe(false)
  })

  it('a client over HTTP keeps only the codes of no answer, under the code its agent read', () => {
    const sock = path.join(dir, 'agent-gateway.sock')
    const env = { WALNUT_AGENT_SOCKET: sock, WALNUT_SESSION_ID: SID } as NodeJS.ProcessEnv
    for (const code of ['hub_unreachable', 'hub_timeout', 'request_failed', 'conflict', 'bad_args', 'other']) noteSessionFailure('task_get', code, 'cli', env)
    const file = noAnswerSpoolFile(sock, SID)
    expect(takeSpooledNoAnswers(file).report.map((n) => n.code)).toEqual(['hub_unreachable', 'hub_timeout', 'request_failed'])
  })
})
