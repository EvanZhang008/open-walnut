/**
 * An adapter's turn that never gets anywhere ends as a session error that says why
 * (engine-turn-watch.ts, acp-worker/adapter-turn-watch.ts): a real AcpWorker against the scripted
 * adapter tests/providers/mock-acp-agent.mjs, which retries forever (as Codex does for an endpoint
 * nothing listens on, 2026-11-24), goes quiet, or makes slow but steady progress.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { AcpWorker } from '../../src/providers/acp-worker/worker.js'
import { readJournal } from '../../src/providers/acp-worker/journal.js'
import type { JournalRecord, WorkerStateSnapshot } from '../../src/providers/acp-worker/protocol.js'
import { classifyTurnError } from '../../src/providers/daemon-core.js'

const MOCK_AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-acp-agent.mjs')

let tmpDir: string
let worker: AcpWorker | null
let gone: number
let reqId = 0

const journalPath = () => path.join(tmpDir, 'session.acp.jsonl')
const op = (w: AcpWorker, name: string, params?: Record<string, unknown>) => w.handle({ id: ++reqId, op: name as never, params })
const records = (): JournalRecord[] => readJournal(journalPath()).records.map((r) => r.record)
const metas = () => records()
  .filter((r): r is Extract<JournalRecord, { kind: 'meta' }> => r.kind === 'meta')
  .map((r) => r.event as Record<string, unknown> & { type: string })

async function waitFor<T>(read: () => T, ok: (v: T) => boolean, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(metas().map((e) => e.type))}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function session(env: Record<string, string>): Promise<AcpWorker> {
  const w = new AcpWorker(journalPath(), () => {}, () => {}, () => { gone++ })
  worker = w
  const init = await op(w, 'initialize', { adapterCommand: [process.execPath, MOCK_AGENT], cwd: tmpDir, env })
  expect(init.ok, JSON.stringify(init)).toBe(true)
  const ns = await op(w, 'newSession', { cwd: tmpDir })
  expect(ns.ok, JSON.stringify(ns)).toBe(true)
  return w
}

const turnEnd = (commandId: string) => metas().find((e) => (e.type === 'turn-ended' || e.type === 'turn-interrupted') && e.commandId === commandId)
const errorOf = (commandId: string) => metas().find((e) => e.type === 'error' && e.commandId === commandId)

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-turn-bound-'))
  worker = null
  gone = 0
})

afterEach(async () => {
  if (worker) await op(worker, 'shutdown').catch(() => {})
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('an adapter turn past its bound', () => {
  it('an engine that retries forever ends in an error that names the retries, and the turn is cancelled', async () => {
    const w = await session({ WALNUT_ENGINE_RETRY_LIMIT_MS: '500' })
    const sent = await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'engine-retries-forever' })
    expect(sent.ok).toBe(true)
    await waitFor(() => turnEnd('c1'), Boolean, 'the turn to end')
    const err = errorOf('c1')
    expect(err?.errorKind).toBe('connection')
    expect(String(err?.message)).toMatch(/could not reach its model for \d+ seconds? \(it retried \d+ times by itself\), so Walnut stopped the turn \(network error\)\./)
    // Walnut's turn-retry reads it as transient, as it does Codex's own lost connection.
    expect(classifyTurnError(`${err?.errorKind}: ${err?.message}`)).toBe('retryable')
    expect(turnEnd('c1')?.type).toBe('turn-interrupted')
    const state = (await op(w, 'getState')).result as WorkerStateSnapshot
    expect(state.turnActive).toBe(false)
    // The adapter took the cancel: the next message runs a turn of its own on the same adapter.
    const next = await op(w, 'prompt', { commandId: 'c2', walnutMessageId: 'm2', text: 'hello' })
    expect(next.ok, JSON.stringify(next)).toBe(true)
    await waitFor(() => turnEnd('c2'), Boolean, 'the next turn')
    expect(turnEnd('c2')?.type).toBe('turn-ended')
    expect(gone).toBe(0)
  })

  it('an adapter that ignores the cancel is ended, so the next message starts it fresh', async () => {
    const w = await session({ WALNUT_ENGINE_RETRY_LIMIT_MS: '400', WALNUT_TURN_CANCEL_GRACE_MS: '300' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'engine-retries-deaf' })
    await waitFor(() => turnEnd('c1'), Boolean, 'the turn to end')
    expect(errorOf('c1')?.errorKind).toBe('connection')
    await waitFor(() => gone, (g) => g > 0, 'the adapter to be ended')
  })

  it('a turn that goes quiet ends as stalled, in words that say for how long', async () => {
    const w = await session({ WALNUT_TURN_STALL_MS: '400' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'engine-goes-quiet' })
    await waitFor(() => turnEnd('c1'), Boolean, 'the turn to end')
    const err = errorOf('c1')
    expect(err?.errorKind).toBe('turn_stalled')
    expect(String(err?.message)).toMatch(/ sent nothing for \d+ seconds?, so Walnut stopped the turn \(operation timed out\)\./)
    expect(classifyTurnError(`${err?.errorKind}: ${err?.message}`)).toBe('retryable')
  })

  it('a self-report question that goes quiet ends too, so it never holds the session', async () => {
    const w = await session({ WALNUT_TURN_STALL_MS: '400' })
    const sent = await op(w, 'prompt', { commandId: 'q1', control: 'self-report', text: 'engine-goes-quiet' })
    expect(sent.ok, JSON.stringify(sent)).toBe(true)
    const ended = await waitFor(() => metas().find((e) => e.type === 'control-ended' && e.commandId === 'q1'), Boolean, 'the question to end')
    expect(ended?.stopReason).toBe('error')
    expect(String(ended?.error)).toContain('sent nothing for')
  })
})

describe('a turn that gets somewhere is never cut', () => {
  it('steady output longer than both limits completes', async () => {
    const w = await session({ WALNUT_ENGINE_RETRY_LIMIT_MS: '300', WALNUT_TURN_STALL_MS: '300' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'steady-progress 1200' })
    await waitFor(() => turnEnd('c1'), Boolean, 'the turn to end', 10_000)
    expect(turnEnd('c1')?.type).toBe('turn-ended')
    expect(errorOf('c1')).toBeUndefined()
  })

  it('a quiet tool call is held to the longer item limit, not the idle one', async () => {
    const w = await session({ WALNUT_TURN_STALL_MS: '300', WALNUT_TURN_STALL_ITEM_MS: '20000' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'steady-tool 1200' })
    await waitFor(() => turnEnd('c1'), Boolean, 'the turn to end', 10_000)
    expect(turnEnd('c1')?.type).toBe('turn-ended')
    expect(errorOf('c1')).toBeUndefined()
  })

  it('a permission the person has not answered holds the bound', async () => {
    const w = await session({ WALNUT_TURN_STALL_MS: '300' })
    await op(w, 'prompt', { commandId: 'c1', walnutMessageId: 'm1', text: 'permission-test' })
    const pending = await waitFor(() => metas().find((e) => e.type === 'permission-requested'), Boolean, 'the permission request')
    // Well past the idle limit, still waiting on the person.
    const deadline = Date.now() + 900
    await waitFor(() => Date.now(), (now) => now > deadline, 'the idle limit to pass three times')
    expect(turnEnd('c1')).toBeUndefined()
    const resp = await op(w, 'permissionResponse', { commandId: 'p1', providerRequestId: String(pending?.providerRequestId), optionId: 'allow-once' })
    expect(resp.ok).toBe(true)
    await waitFor(() => turnEnd('c1'), Boolean, 'the turn to end')
    expect(turnEnd('c1')?.type).toBe('turn-ended')
    expect(errorOf('c1')).toBeUndefined()
  })
})
