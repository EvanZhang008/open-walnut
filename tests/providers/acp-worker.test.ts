/**
 * ACP worker unit tests — real AcpWorker against the scripted mock ACP agent
 * (tests/providers/mock-acp-agent.mjs). Only the agent binary is mocked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { AcpWorker } from '../../src/providers/acp-worker/worker.js'
import { readJournal } from '../../src/providers/acp-worker/journal.js'
import {
  WALNUT_MCP_SERVER,
  resolveWalnutMcpServers,
} from '../../src/providers/acp-worker/protocol.js'
import type { WorkerStateSnapshot, JournalRecord } from '../../src/providers/acp-worker/protocol.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MOCK_AGENT = path.join(__dirname, 'mock-acp-agent.mjs')

let tmpDir: string
let worker: AcpWorker | null
let reqId = 0

function journalPath(): string { return path.join(tmpDir, 'session.acp.jsonl') }

async function op(w: AcpWorker, opName: string, params?: Record<string, unknown>) {
  return w.handle({ id: ++reqId, op: opName as never, params })
}

async function initWorker(env?: Record<string, string>): Promise<AcpWorker> {
  const w = new AcpWorker(journalPath())
  const resp = await op(w, 'initialize', { adapterCommand: [process.execPath, MOCK_AGENT], cwd: tmpDir, env })
  expect(resp.ok).toBe(true)
  return w
}

/** Poll the journal until predicate matches (worker journals asynchronously). */
async function waitForJournal(
  predicate: (records: JournalRecord[]) => boolean,
  timeoutMs = 5000,
): Promise<JournalRecord[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { records } = readJournal(journalPath())
    const recs = records.map((r) => r.record)
    if (predicate(recs)) return recs
    if (Date.now() > deadline) throw new Error(`journal predicate not met; have: ${JSON.stringify(recs.map(r => r.kind === 'meta' ? r.event.type : 'acp'))}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const metas = (recs: JournalRecord[]) =>
  recs.filter((r): r is Extract<JournalRecord, { kind: 'meta' }> => r.kind === 'meta').map((r) => r.event)
const turnEnded = (recs: JournalRecord[]) => metas(recs).some((e) => e.type === 'turn-ended')

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-worker-test-'))
  worker = null
})

afterEach(async () => {
  if (worker) { await op(worker, 'shutdown').catch(() => {}) }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('AcpWorker lifecycle', () => {
  it('initialize → newSession returns providerSessionId and models', async () => {
    worker = await initWorker()
    const resp = await op(worker, 'newSession', { cwd: tmpDir })
    expect(resp.ok).toBe(true)
    const result = resp.result as { sessionId: string; models: { availableModels: unknown[] } }
    expect(result.sessionId).toMatch(/^mock-session-/)
    expect(result.models.availableModels.length).toBeGreaterThan(0)
    const state = (await op(worker, 'getState')).result as WorkerStateSnapshot
    expect(state.models).toEqual({
      currentModelId: 'mock-gpt-best',
      availableModels: [
        {
          modelId: 'mock-gpt-best',
          name: 'Mock GPT Best',
          description: 'Best mock model',
        },
        {
          modelId: 'mock-gpt-fast',
          name: 'Mock GPT Fast',
          description: 'Fast mock model',
        },
      ],
    })
    expect(state.configOptions.map((option) => ({
      id: option.id,
      currentValue: option.currentValue,
    }))).toEqual([
      { id: 'mode', currentValue: 'agent' },
      { id: 'collaboration_mode', currentValue: 'default' },
      { id: 'model', currentValue: 'mock-gpt-best' },
    ])

    const recs = await waitForJournal((r) => metas(r).some((e) => e.type === 'session-created'))
    const created = metas(recs).find((e) => e.type === 'session-created')
    expect(created && 'providerSessionId' in created && created.providerSessionId).toBe(result.sessionId)
  })

  it('prompt streams session/update frames raw into the journal and ends the turn', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const resp = await op(worker, 'prompt', {
      commandId: 'acp-prompt:qm-1',
      walnutMessageId: 'qm-1',
      text: 'hi there',
    })
    expect(resp.ok).toBe(true)
    expect((resp.result as { accepted: boolean }).accepted).toBe(true)

    const recs = await waitForJournal(turnEnded)
    const acpFrames = recs.filter((r) => r.kind === 'acp')
    expect(acpFrames.length).toBeGreaterThanOrEqual(2)
    const events = metas(recs).map((e) => e.type)
    expect(events).toContain('prompt-intent')
    expect(events).toContain('prompt-dispatch-attempted')
    expect(events).toContain('prompt-dispatched')
    expect(events).toContain('prompt-accepted')
    expect(events).toContain('turn-started')
    expect(events).toContain('turn-ended')
    const intentIndex = metas(recs).findIndex((e) => e.type === 'prompt-intent')
    const attemptedIndex = metas(recs).findIndex((e) => e.type === 'prompt-dispatch-attempted')
    const dispatchedIndex = metas(recs).findIndex((e) => e.type === 'prompt-dispatched')
    const acceptedIndex = metas(recs).findIndex((e) => e.type === 'prompt-accepted')
    const startedIndex = metas(recs).findIndex((e) => e.type === 'turn-started')
    expect(intentIndex).toBeLessThan(attemptedIndex)
    expect(attemptedIndex).toBeLessThan(dispatchedIndex)
    expect(dispatchedIndex).toBeLessThan(acceptedIndex)
    expect(acceptedIndex).toBeGreaterThanOrEqual(0)
    expect(acceptedIndex).toBeLessThan(startedIndex)
    const accepted = metas(recs).find((e) => e.type === 'prompt-accepted')
    expect(accepted).toEqual({
      type: 'prompt-accepted',
      commandId: 'acp-prompt:qm-1',
      walnutMessageId: 'qm-1',
      text: 'hi there',
    })
    const ended = metas(recs).find((e) => e.type === 'turn-ended')
    expect(ended && 'stopReason' in ended && ended.stopReason).toBe('end_turn')
  })

  it('rejects a user prompt without its durable message ID before adapter dispatch', async () => {
    const promptLog = path.join(tmpDir, 'missing-message-id-prompts.jsonl')
    worker = await initWorker({ MOCK_ACP_PROMPT_LOG: promptLog })
    await op(worker, 'newSession', { cwd: tmpDir })

    const rejected = await op(worker, 'prompt', {
      commandId: 'acp-prompt:missing',
      text: 'must not reach the provider',
    })

    expect(rejected.ok).toBe(false)
    expect(rejected.error).toEqual({
      kind: 'protocol',
      message: 'ACP provider protocol operation failed',
    })
    const records = await waitForJournal((recs) =>
      metas(recs).some((event) =>
        event.type === 'error' && event.errorKind === 'protocol'))
    expect(metas(records)).toContainEqual({
      type: 'error',
      errorKind: 'protocol',
      message: 'ACP provider protocol operation failed',
    })
    expect(fs.existsSync(promptLog)).toBe(false)

    const accepted = await op(worker, 'prompt', {
      commandId: 'acp-prompt:qm-after-rejection',
      walnutMessageId: 'qm-after-rejection',
      text: 'identified prompt',
    })
    expect(accepted.ok).toBe(true)
    await waitForJournal(turnEnded)
    expect(fs.readFileSync(promptLog, 'utf-8').trim().split('\n')).toHaveLength(1)
  })

  it('prompt while turn active → turn_active error', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    await op(worker, 'prompt', { commandId: 'cmd-1', walnutMessageId: 'qm-1', text: 'slow' })
    const second = await op(worker, 'prompt', { commandId: 'cmd-2', walnutMessageId: 'qm-2', text: 'hi' })
    expect(second.ok).toBe(false)
    expect(second.error?.kind).toBe('turn_active')
    await waitForJournal(turnEnded)
  })

  it('commandId dedup: retrying prompt with same commandId returns original result, no second turn', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const first = await op(worker, 'prompt', { commandId: 'cmd-x', walnutMessageId: 'qm-x', text: 'hi' })
    const retry = await op(worker, 'prompt', { commandId: 'cmd-x', walnutMessageId: 'qm-x', text: 'hi' })
    expect(retry.ok).toBe(true)
    expect(retry.result).toEqual(first.result)
    const recs = await waitForJournal(turnEnded)
    expect(metas(recs).filter((e) => e.type === 'turn-started').length).toBe(1)
  })

  it('setConfigOption switches the model once and journals an audit fact', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const params = {
      commandId: 'acp-config:model:1',
      configId: 'model',
      value: 'mock-gpt-fast',
    }
    const first = await op(worker, 'setConfigOption', params)
    const retry = await op(worker, 'setConfigOption', params)
    expect(first).toMatchObject({ ok: true })
    expect(retry.result).toEqual(first.result)

    const state = (await op(worker, 'getState')).result as WorkerStateSnapshot
    expect(state.models.currentModelId).toBe('mock-gpt-fast')
    const records = readJournal(journalPath()).records.map(({ record }) => record)
    expect(metas(records).filter((event) => event.type === 'config-option-set'))
      .toEqual([{
        type: 'config-option-set',
        configId: 'model',
        value: 'mock-gpt-fast',
      }])
  })

  it('setConfigOption updates the normalized session control currentValue', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const response = await op(worker, 'setConfigOption', {
      commandId: 'acp-config:mode:1',
      configId: 'mode',
      value: 'read-only',
    })
    expect(response.ok).toBe(true)

    const state = (await op(worker, 'getState')).result as WorkerStateSnapshot
    expect(state.configOptions.find((option) => option.id === 'mode')?.currentValue)
      .toBe('read-only')
  })

  it('persists only a safe category message for provider control errors', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const response = await op(worker, 'prompt', {
      commandId: 'acp-self-report:redaction',
      control: 'self-report',
      text: 'error',
    })
    expect(response.ok).toBe(true)

    const recs = await waitForJournal((records) =>
      metas(records).some((event) => event.type === 'control-ended'))
    const serialized = JSON.stringify(recs)
    expect(serialized).toContain('ACP provider protocol operation failed')
    expect(serialized).not.toContain('mock agent: scripted prompt failure')
  })

  it('rebuilds prompt command dedup from the journal after a worker restart', async () => {
    const promptLog = path.join(tmpDir, 'prompts.jsonl')
    worker = await initWorker({ MOCK_ACP_PROMPT_LOG: promptLog })
    await op(worker, 'newSession', { cwd: tmpDir })
    const params = {
      commandId: 'acp-prompt:qm-restart',
      walnutMessageId: 'qm-restart',
      text: 'only once',
    }
    const first = await op(worker, 'prompt', params)
    expect(first.ok).toBe(true)
    await waitForJournal(turnEnded)
    await op(worker, 'shutdown')
    worker = null

    worker = await initWorker({ MOCK_ACP_PROMPT_LOG: promptLog })
    await op(worker, 'loadSession', { providerSessionId: 'mock-session-restart', cwd: tmpDir })
    const retry = await op(worker, 'prompt', params)
    expect(retry.ok).toBe(true)
    expect(retry.result).toEqual(first.result)

    const invocations = fs.readFileSync(promptLog, 'utf-8').trim().split('\n')
    expect(invocations).toHaveLength(1)
    const recs = readJournal(journalPath()).records.map((r) => r.record)
    expect(metas(recs).filter((e) => e.type === 'prompt-accepted')).toHaveLength(1)
  })

  it('retries an intent-only command instead of falsely deduplicating it', async () => {
    const promptLog = path.join(tmpDir, 'intent-retry.jsonl')
    fs.writeFileSync(journalPath(), JSON.stringify({
      kind: 'meta',
      ts: 1,
      event: {
        type: 'prompt-intent',
        commandId: 'acp-prompt:qm-intent-only',
        walnutMessageId: 'qm-intent-only',
        text: 'recover this prompt',
      },
    }) + '\n')

    worker = await initWorker({ MOCK_ACP_PROMPT_LOG: promptLog })
    await op(worker, 'newSession', { cwd: tmpDir })
    const retry = await op(worker, 'prompt', {
      commandId: 'acp-prompt:qm-intent-only',
      walnutMessageId: 'qm-intent-only',
      text: 'recover this prompt',
    })
    expect(retry.ok).toBe(true)
    const recs = await waitForJournal(turnEnded)
    expect(fs.readFileSync(promptLog, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(metas(recs).filter((event) =>
      event.type === 'prompt-abandoned'
        && event.commandId === 'acp-prompt:qm-intent-only')).toHaveLength(1)
    expect(metas(recs).filter((event) =>
      event.type === 'prompt-dispatched'
        && event.commandId === 'acp-prompt:qm-intent-only')).toHaveLength(1)
  })

  it('recovers a dispatched command as accepted/interrupted without submitting it twice', async () => {
    const promptLog = path.join(tmpDir, 'dispatched-recovery.jsonl')
    fs.writeFileSync(journalPath(), [
      {
        kind: 'meta',
        ts: 1,
        event: {
          type: 'prompt-intent',
          commandId: 'acp-prompt:qm-dispatched',
          walnutMessageId: 'qm-dispatched',
          text: 'already crossed provider boundary',
        },
      },
      {
        kind: 'meta',
        ts: 2,
        event: { type: 'prompt-dispatched', commandId: 'acp-prompt:qm-dispatched' },
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n')

    worker = await initWorker({ MOCK_ACP_PROMPT_LOG: promptLog })
    await op(worker, 'loadSession', { providerSessionId: 'mock-session-recovery', cwd: tmpDir })
    const retry = await op(worker, 'prompt', {
      commandId: 'acp-prompt:qm-dispatched',
      walnutMessageId: 'qm-dispatched',
      text: 'already crossed provider boundary',
    })
    expect(retry.ok).toBe(true)
    expect(fs.existsSync(promptLog)).toBe(false)
    const recs = readJournal(journalPath()).records.map(({ record }) => record)
    expect(metas(recs).filter((event) =>
      event.type === 'prompt-accepted'
        && event.commandId === 'acp-prompt:qm-dispatched')).toHaveLength(1)
    expect(metas(recs)).toContainEqual({
      type: 'turn-interrupted',
      reason: 'worker-crash',
      commandId: 'acp-prompt:qm-dispatched',
    })
  })

  it('surfaces an indeterminate dispatch attempt without blindly submitting it twice', async () => {
    const promptLog = path.join(tmpDir, 'indeterminate-recovery.jsonl')
    fs.writeFileSync(journalPath(), [
      {
        kind: 'meta',
        ts: 1,
        event: {
          type: 'prompt-intent',
          commandId: 'acp-prompt:qm-indeterminate',
          walnutMessageId: 'qm-indeterminate',
          text: 'may already have crossed the provider boundary',
        },
      },
      {
        kind: 'meta',
        ts: 2,
        event: {
          type: 'prompt-dispatch-attempted',
          commandId: 'acp-prompt:qm-indeterminate',
        },
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n')

    worker = await initWorker({ MOCK_ACP_PROMPT_LOG: promptLog })
    await op(worker, 'loadSession', {
      providerSessionId: 'mock-session-indeterminate',
      cwd: tmpDir,
    })
    const retry = await op(worker, 'prompt', {
      commandId: 'acp-prompt:qm-indeterminate',
      walnutMessageId: 'qm-indeterminate',
      text: 'may already have crossed the provider boundary',
    })

    expect(retry.ok).toBe(true)
    expect(fs.existsSync(promptLog)).toBe(false)
    const recs = readJournal(journalPath()).records.map(({ record }) => record)
    expect(metas(recs)).toContainEqual({
      type: 'prompt-accepted',
      commandId: 'acp-prompt:qm-indeterminate',
      walnutMessageId: 'qm-indeterminate',
      text: 'may already have crossed the provider boundary',
    })
    expect(metas(recs)).toContainEqual({
      type: 'turn-interrupted',
      reason: 'dispatch-indeterminate',
      commandId: 'acp-prompt:qm-indeterminate',
    })
  })

  it('getState reflects session, turn, and journal offset', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const state1 = (await op(worker, 'getState')).result as WorkerStateSnapshot
    expect(state1.providerSessionId).toMatch(/^mock-session-/)
    expect(state1.turnActive).toBe(false)
    expect(state1.controlActive).toBe(false)
    expect(state1.adapterPid).toBeGreaterThan(0)
    expect(state1.journalOffset).toBeGreaterThan(0)
    expect(state1.capabilities).toEqual(expect.objectContaining({
      loadSession: true,
      listSessions: true,
      closeSession: true,
      forkSession: false,
      promptImages: true,
    }))
  })

  it('self-report control prompt is tagged, hidden from user-turn facts, and deduplicated', async () => {
    const promptLog = path.join(tmpDir, 'control-prompts.jsonl')
    worker = await initWorker({ MOCK_ACP_PROMPT_LOG: promptLog })
    await op(worker, 'newSession', { cwd: tmpDir })
    const params = {
      commandId: 'acp-self-report:report-1',
      control: 'self-report',
      text: 'self-report-test',
    }
    const first = await op(worker, 'prompt', params)
    const retry = await op(worker, 'prompt', params)
    expect(first.ok).toBe(true)
    expect(retry.result).toEqual(first.result)

    const recs = await waitForJournal((records) =>
      metas(records).some((event) =>
        event.type === 'control-ended'
          && event.commandId === 'acp-self-report:report-1'))
    expect(metas(recs).filter((event) => event.type === 'control-prompt-accepted'))
      .toHaveLength(1)
    expect(metas(recs).some((event) => event.type === 'prompt-accepted')).toBe(false)
    expect(metas(recs).some((event) => event.type === 'turn-started')).toBe(false)
    expect(metas(recs).some((event) => event.type === 'turn-ended')).toBe(false)
    const controlFrames = recs.filter((record) => record.kind === 'acp')
    expect(controlFrames.length).toBeGreaterThan(0)
    expect(controlFrames.every((record) => record.source === 'control')).toBe(true)
    expect(fs.readFileSync(promptLog, 'utf-8').trim().split('\n')).toHaveLength(1)
  })
})

describe('MCP server mounts', () => {
  /** What the CLIENT actually put on the wire, as recorded by the mock agent. */
  function sessionRequests(logPath: string): Array<{
    method: string
    sessionId?: string
    mcpServers?: Array<{ name: string; command: string; args: string[]; env: unknown[] }>
  }> {
    if (!fs.existsSync(logPath)) return []
    return fs.readFileSync(logPath, 'utf-8').trim().split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
  }

  it('resolveWalnutMcpServers is opt-in: nothing unless session.acp_walnut_mcp is true', () => {
    expect(resolveWalnutMcpServers(undefined)).toEqual([])
    expect(resolveWalnutMcpServers(null)).toEqual([])
    expect(resolveWalnutMcpServers({})).toEqual([])
    expect(resolveWalnutMcpServers({ acp_walnut_mcp: false })).toEqual([])
    expect(resolveWalnutMcpServers({ acp_walnut_mcp: true })).toEqual([
      { name: 'walnut', command: 'open-walnut', args: ['mcp'], env: [] },
    ])
  })

  it('default (no mcpServers param): newSession sends an empty mcpServers list', async () => {
    const sessionLog = path.join(tmpDir, 'sessions-default.jsonl')
    worker = await initWorker({ MOCK_ACP_SESSION_LOG: sessionLog })
    const resp = await op(worker, 'newSession', { cwd: tmpDir })
    expect(resp.ok).toBe(true)

    const requests = sessionRequests(sessionLog)
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('session/new')
    // Exactly as before the mount existed: present-but-empty, per ACP schema.
    expect(requests[0].mcpServers).toEqual([])
  })

  it('with the walnut mount: it rides BOTH newSession and loadSession', async () => {
    const sessionLog = path.join(tmpDir, 'sessions-mounted.jsonl')
    const mcpServers = resolveWalnutMcpServers({ acp_walnut_mcp: true })
    worker = await initWorker({ MOCK_ACP_SESSION_LOG: sessionLog })

    const created = await op(worker, 'newSession', { cwd: tmpDir, mcpServers })
    expect(created.ok).toBe(true)
    const loaded = await op(worker, 'loadSession', {
      providerSessionId: 'mock-session-mcp',
      cwd: tmpDir,
      mcpServers,
    })
    expect(loaded.ok).toBe(true)

    const requests = sessionRequests(sessionLog)
    expect(requests.map((r) => r.method)).toEqual(['session/new', 'session/load'])
    for (const request of requests) {
      expect(request.mcpServers).toEqual([{
        name: WALNUT_MCP_SERVER.name,
        command: WALNUT_MCP_SERVER.command,
        args: [...WALNUT_MCP_SERVER.args],
        env: [],
      }])
    }
  })

  it('forwards a custom mount verbatim, env entries included', async () => {
    const sessionLog = path.join(tmpDir, 'sessions-custom.jsonl')
    worker = await initWorker({ MOCK_ACP_SESSION_LOG: sessionLog })
    const resp = await op(worker, 'newSession', {
      cwd: tmpDir,
      mcpServers: [{
        name: 'extra',
        command: 'some-mcp',
        args: ['serve', '--stdio'],
        env: [{ name: 'EXTRA_MODE', value: 'on' }],
      }],
    })
    expect(resp.ok).toBe(true)

    expect(sessionRequests(sessionLog)[0].mcpServers).toEqual([{
      name: 'extra',
      command: 'some-mcp',
      args: ['serve', '--stdio'],
      env: [{ name: 'EXTRA_MODE', value: 'on' }],
    }])
  })
})

describe('permission round-trip', () => {
  it('requestPermission → pending in state → respond → agent sees option id', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    await op(worker, 'prompt', { commandId: 'cmd-p', walnutMessageId: 'qm-p', text: 'permission-test' })

    await waitForJournal((r) => metas(r).some((e) => e.type === 'permission-requested'))
    const state = (await op(worker, 'getState')).result as WorkerStateSnapshot
    expect(state.pendingPermissions.length).toBe(1)
    const pending = state.pendingPermissions[0]
    expect((pending.options as Array<{ optionId: string }>).map((o) => o.optionId)).toContain('allow-once')

    const resp = await op(worker, 'permissionResponse', {
      commandId: 'cmd-pr', providerRequestId: pending.providerRequestId, optionId: 'allow-once',
    })
    expect(resp.ok).toBe(true)
    expect((resp.result as { answered: boolean }).answered).toBe(true)

    const recs = await waitForJournal(turnEnded)
    // Agent's post-approval chunk carries the chosen option id.
    const confirmed = recs.some((r) => r.kind === 'acp' && JSON.stringify(r.frame).includes('permission granted: allow-once'))
    expect(confirmed).toBe(true)
    const state2 = (await op(worker, 'getState')).result as WorkerStateSnapshot
    expect(state2.pendingPermissions.length).toBe(0)
  })

  it('permissionResponse for unknown request id is a no-op, not an error', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const resp = await op(worker, 'permissionResponse', {
      commandId: 'cmd-z', providerRequestId: 'perm-999', optionId: 'allow-once',
    })
    expect(resp.ok).toBe(true)
    expect((resp.result as { answered: boolean }).answered).toBe(false)
  })

  it('cancel mid-turn answers pending permission with cancelled and ends turn', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    await op(worker, 'prompt', { commandId: 'cmd-c', walnutMessageId: 'qm-c', text: 'permission-test' })
    await waitForJournal((r) => metas(r).some((e) => e.type === 'permission-requested'))

    const resp = await op(worker, 'cancel', { commandId: 'cmd-cancel' })
    expect(resp.ok).toBe(true)

    const recs = await waitForJournal(turnEnded)
    expect(metas(recs).some((e) => e.type === 'permission-auto-cancelled')).toBe(true)
    const ended = metas(recs).find((e) => e.type === 'turn-ended')
    expect(ended && 'stopReason' in ended && ended.stopReason).toBe('cancelled')
  })
})

describe('load / resume', () => {
  it('loadSession succeeds and journals session-loaded', async () => {
    worker = await initWorker()
    const resp = await op(worker, 'loadSession', { providerSessionId: 'mock-session-42', cwd: tmpDir })
    expect(resp.ok).toBe(true)
    const recs = await waitForJournal((r) => metas(r).some((e) => e.type === 'session-loaded'))
    const loaded = metas(recs).find((e) => e.type === 'session-loaded')
    expect(loaded && 'providerSessionId' in loaded && loaded.providerSessionId).toBe('mock-session-42')
    const replay = recs.find((r) => r.kind === 'acp' && JSON.stringify(r.frame).includes('replayed: earlier reply'))
    expect(replay).toMatchObject({ kind: 'acp', source: 'provider-replay' })
    // Prompt works on the loaded session.
    const p = await op(worker, 'prompt', {
      commandId: 'acp-prompt:qm-after-load',
      walnutMessageId: 'qm-after-load',
      text: 'hello',
    })
    expect(p.ok).toBe(true)
    const after = await waitForJournal(turnEnded)
    const live = after.filter((r) =>
      r.kind === 'acp' && JSON.stringify(r.frame).includes('hello from mock-acp'))
    expect(live.length).toBeGreaterThan(0)
    expect(live.every((r) => r.kind === 'acp' && r.source === 'live')).toBe(true)
  })

  it('a resume onto a NON-EMPTY journal drops the provider replay burst', async () => {
    worker = await initWorker()
    const created = await op(worker, 'newSession', { cwd: tmpDir })
    expect(created.ok).toBe(true)
    const providerSessionId = (created.result as { sessionId: string }).sessionId
    const first = await op(worker, 'prompt', {
      commandId: 'acp-prompt:qm-replay-1',
      walnutMessageId: 'qm-replay-1',
      text: 'first turn',
    })
    expect(first.ok).toBe(true)
    await waitForJournal(turnEnded)
    await op(worker, 'shutdown')
    worker = null

    // The journal now holds the whole conversation; a resume replaying it again
    // must not append anything (that re-append is the quadratic growth).
    const before = readJournal(journalPath())
    expect(before.nextOffset).toBeGreaterThan(0)
    const sessionCreated = metas(before.records.map((r) => r.record))
      .find((event) => event.type === 'session-created')
    expect(sessionCreated && 'providerSessionId' in sessionCreated
      && sessionCreated.providerSessionId).toBe(providerSessionId)

    worker = await initWorker()
    const loaded = await op(worker, 'loadSession', { providerSessionId, cwd: tmpDir })
    expect(loaded.ok).toBe(true)
    await waitForJournal((recs) => metas(recs).some((e) => e.type === 'session-loaded'))

    const appended = readJournal(journalPath(), before.nextOffset).records
      .map(({ record }) => record)
    expect(appended.filter((record) =>
      record.kind === 'acp' && record.source === 'provider-replay')).toHaveLength(0)
    expect(appended.some((record) => JSON.stringify(record).includes('replayed: earlier reply')))
      .toBe(false)
    // The lifecycle fact is still recorded — only the duplicate frames are dropped.
    expect(metas(appended).some((event) => event.type === 'session-loaded')).toBe(true)
  })

  it('loadSession failure surfaces load_failed (fallback decision is the caller\'s)', async () => {
    worker = await initWorker({ MOCK_ACP_FAIL_LOAD: '1' })
    const resp = await op(worker, 'loadSession', { providerSessionId: 'mock-session-1', cwd: tmpDir })
    expect(resp.ok).toBe(false)
    expect(resp.error?.kind).toBe('load_failed')
    const recs = readJournal(journalPath()).records.map(({ record }) => record)
    expect(metas(recs).some((event) => event.type === 'error')).toBe(false)
  })

  it('prompt without a session → no_session error', async () => {
    worker = await initWorker()
    const resp = await op(worker, 'prompt', { commandId: 'cmd-n', walnutMessageId: 'qm-n', text: 'hi' })
    expect(resp.ok).toBe(false)
    expect(resp.error?.kind).toBe('no_session')
  })
})

describe('journal replay contract', () => {
  it('readJournal(from) resumes exactly after previously consumed records', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const r1 = readJournal(journalPath())
    await op(worker, 'prompt', { commandId: 'cmd-r', walnutMessageId: 'qm-r', text: 'hi' })
    await waitForJournal(turnEnded)
    const r2 = readJournal(journalPath(), r1.nextOffset)
    expect(r2.records.length).toBeGreaterThan(0)
    // No overlap: first new record starts at the consumed offset.
    expect(r2.records[0].offset).toBe(r1.nextOffset)
    // Full read = prefix + suffix.
    const full = readJournal(journalPath())
    expect(full.records.length).toBe(r1.records.length + r2.records.length)
  })

  it('a torn trailing line is invisible and does not advance the cursor', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    const before = readJournal(journalPath())
    // Simulate a mid-write crash: partial record, no trailing newline.
    fs.appendFileSync(journalPath(), '{"kind":"meta","ts":123,"event":{"type":"turn-')
    const after = readJournal(journalPath())
    expect(after.records.length).toBe(before.records.length)
    expect(after.nextOffset).toBe(before.nextOffset)
    // Completing the line makes it visible.
    fs.appendFileSync(journalPath(), 'started","commandId":"cmd-torn"}}\n')
    const completed = readJournal(journalPath(), after.nextOffset)
    expect(completed.records.length).toBe(1)
  })

  it('adapter death mid-turn journals turn-interrupted and auto-cancels pending permission', async () => {
    worker = await initWorker()
    await op(worker, 'newSession', { cwd: tmpDir })
    await op(worker, 'prompt', { commandId: 'cmd-die', walnutMessageId: 'qm-die', text: 'permission-test' })
    await waitForJournal((r) => metas(r).some((e) => e.type === 'permission-requested'))

    const state = (await op(worker, 'getState')).result as WorkerStateSnapshot
    process.kill(state.adapterPid!, 'SIGKILL')

    const recs = await waitForJournal((r) =>
      metas(r).some((e) => e.type === 'turn-interrupted') && metas(r).some((e) => e.type === 'permission-auto-cancelled'))
    expect(metas(recs).some((e) => e.type === 'turn-interrupted')).toBe(true)
  })
})
