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
  NoAnswerLog, noAnswerSpoolFile, noAnswersOf, spoolHoldsNoAnswers, spoolNoAnswer, takeSpooledNoAnswers,
} from '../../../src/lib/no-answer-report.js'
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

  it('other codes are never matched away: each failure the hook reads counts', () => {
    recordToolError({ sid: SID, host: 'local', op: 'search', client: 'mcp', code: 'bad_args' })
    recordToolError({ sid: SID, host: 'local', op: 'search', client: 'mcp', code: 'bad_args' }, 'client')
    expect(rows()).toHaveLength(2)
  })
})

describe('the Walnut MCP server tells its calls no Walnut answered with its next call that gets through', () => {
  const formatError = (e: { code: string; message: string }) => [`walnut: ${e.code}: ${e.message}`]
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
      formatError, lostFollowMs: 1,
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
      { op: 'task_create', code: 'no_daemon', client: 'mcp', ms: expect.any(Number) },
      { op: 'host_exec', code: 'hub_unreachable', client: 'mcp', ms: expect.any(Number) },
      { op: 'subagent_send', code: 'hub_timeout', client: 'mcp', ms: expect.any(Number) },
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
      formatError,
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
  it('kept, taken once, and kept again when the report did not go', () => {
    const sock = path.join(dir, 'agent-gateway.sock')
    const file = noAnswerSpoolFile(sock, SID)
    expect(file).toBe(path.join(dir, 'no-answer', `${SID}.ndjson`))
    expect(noAnswerSpoolFile(sock, '../etc')).toBeNull()
    expect(spoolHoldsNoAnswers(file)).toBe(false)
    const t0 = Date.parse('2026-11-23T16:35:16Z')
    spoolNoAnswer(file, 'host_copy', 'hub_unreachable', 'cli', t0)
    spoolNoAnswer(file, 'task_get', 'bad_args', 'cli', t0)
    spoolNoAnswer(file, 'task_get', 'daemon_unreachable', 'cli', t0 + 1_000)
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600)
    const first = takeSpooledNoAnswers(file, t0 + 11_000)
    expect(first.report).toEqual([
      { op: 'host_copy', code: 'hub_unreachable', client: 'cli', ms: 11_000 },
      { op: 'task_get', code: 'daemon_unreachable', client: 'cli', ms: 10_000 },
    ])
    expect(spoolHoldsNoAnswers(file)).toBe(false)
    expect(takeSpooledNoAnswers(file).report).toEqual([])
    first.putBack()
    expect(takeSpooledNoAnswers(file, t0 + 11_000).report).toHaveLength(2)
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

  it('a long-lived client keeps at most its last 50', () => {
    const log = new NoAnswerLog()
    for (let i = 0; i < 60; i++) log.note(`op_${i}`, 'no_daemon', 'mcp')
    const { report } = log.take()
    expect(report).toHaveLength(50)
    expect(report[0].op).toBe('op_10')
  })
})
