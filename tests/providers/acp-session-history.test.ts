import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import {
  acceptAcpPrompt,
  createSessionRecord,
  getSessionByClaudeId,
  querySessions,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb, SESSION_DB_PATH } from '../../src/core/session-db.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import {
  readAcpSessionHistory,
  readAcpSessionHistoryState,
} from '../../src/providers/acp-session-history.js'
import { AcpSession } from '../../src/providers/acp-session.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-history-test-'))
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(SESSION_DB_PATH + suffix, { force: true })
  }
  _resetSessionTrackerForTesting()
})

afterEach(() => {
  bus.unsubscribe('main-ai')
  bus.unsubscribe('web-ui')
  closeDb()
  _resetSessionTrackerForTesting()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('ACP session history', () => {
  it('reads the ACP journal path and returns the canonical projected transcript', async () => {
    const journalPath = path.join(tmpDir, 'runtime-1.acp.jsonl')
    const lines = [
      {
        kind: 'meta', ts: 1,
        event: {
          type: 'prompt-accepted',
          commandId: 'acp-prompt:qm-1',
          walnutMessageId: 'qm-1',
          text: 'exact user text',
        },
      },
      {
        kind: 'acp', ts: 2, source: 'provider-replay',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'old replay' },
            },
          },
        },
      },
      {
        kind: 'acp', ts: 3, source: 'live',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'new answer' },
            },
          },
        },
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n'

    const history = await readAcpSessionHistory({
      claudeSessionId: 'provider-1',
      acpRuntimeId: 'runtime-1',
      acpJournalPath: journalPath,
    }, {
      reader: { readFile: async (requestedPath) => requestedPath === journalPath ? lines : null },
    })

    expect(history.map((m) => m.text)).toEqual(['exact user text', 'new answer'])
  })

  it('distinguishes an empty existing journal from a missing journal', async () => {
    const record = {
      claudeSessionId: 'provider-empty',
      acpRuntimeId: 'runtime-empty',
      acpJournalPath: path.join(tmpDir, 'runtime-empty.acp.jsonl'),
    }
    const empty = await readAcpSessionHistoryState(record, {
      reader: { readFile: async () => '' },
    })
    const missing = await readAcpSessionHistoryState(record, {
      reader: { readFile: async () => null },
    })

    expect(empty).toEqual({ messages: [], journalExists: true })
    expect(missing).toEqual({ messages: [], journalExists: false })
  })
})

describe('ACP session record primitives', () => {
  it('accepts a prompt atomically and increments status/count exactly once', async () => {
    await createSessionRecord('provider-1', 'task-1', 'Project', tmpDir, {
      engine: 'codex',
      acpRuntimeId: 'runtime-1',
      initialProcessStatus: 'idle',
      messageCount: 0,
    })

    const first = await acceptAcpPrompt('provider-1', 'acp-prompt:qm-1')
    const duplicate = await acceptAcpPrompt('provider-1', 'acp-prompt:qm-1')
    expect(first.accepted).toBe(true)
    expect(duplicate.accepted).toBe(false)

    const record = await getSessionByClaudeId('provider-1')
    expect(record).toMatchObject({
      process_status: 'running',
      status_reason: 'message_sent',
      messageCount: 1,
      lastAcceptedAcpCommandId: 'acp-prompt:qm-1',
    })
  })

  it('seeds replay from the record and commits the cursor only at a terminal fact', async () => {
    await createSessionRecord('provider-cursor', 'task-cursor', 'Project', tmpDir, {
      engine: 'codex',
      acpRuntimeId: 'runtime-cursor',
      initialProcessStatus: 'idle',
      messageCount: 0,
    })
    await updateSessionRecord('provider-cursor', { consumedOffset: 100 })
    const session = new AcpSession({
      taskId: 'task-cursor',
      project: 'Project',
      cwd: tmpDir,
      mode: 'default',
      providerSessionId: 'provider-cursor',
      runtimeId: 'runtime-cursor',
    })
    await (session as unknown as { seedReplayCursor(): Promise<void> }).seedReplayCursor()
    const handle = (session as unknown as {
      handleDaemonEvent(event: Record<string, unknown>): void
    }).handleDaemonEvent.bind(session)

    handle({
      ev: 'jsonl',
      sid: 'runtime-cursor',
      v: 150,
      line: JSON.stringify({
        kind: 'meta',
        ts: 1,
        event: {
          type: 'prompt-accepted',
          commandId: 'acp-prompt:qm-cursor',
          walnutMessageId: 'qm-cursor',
          text: 'unfinished',
        },
      }),
    })
    expect((await getSessionByClaudeId('provider-cursor'))?.consumedOffset).toBe(100)

    handle({
      ev: 'jsonl',
      sid: 'runtime-cursor',
      v: 200,
      line: JSON.stringify({
        kind: 'meta',
        ts: 2,
        event: {
          type: 'turn-ended',
          commandId: 'acp-prompt:qm-cursor',
          stopReason: 'end_turn',
        },
      }),
    })
    const deadline = Date.now() + 2000
    while ((await getSessionByClaudeId('provider-cursor'))?.consumedOffset !== 200) {
      if (Date.now() > deadline) throw new Error('terminal cursor was not committed')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })

  it('collects self-report control chunks without committing them as a user turn', async () => {
    const session = new AcpSession({
      taskId: 'task-report',
      project: 'Project',
      cwd: tmpDir,
      mode: 'default',
      providerSessionId: 'provider-report',
      runtimeId: 'runtime-report',
    })
    let sent: Record<string, unknown> | undefined
    const internals = session as unknown as {
      establish(): Promise<string>
      ensureConn(): Promise<{
        send(command: string, params: Record<string, unknown>): Promise<{ ok: boolean }>
      }>
      handleDaemonEvent(event: Record<string, unknown>): void
    }
    internals.establish = async () => 'provider-report'
    internals.ensureConn = async () => ({
      send: async (_command, params) => {
        sent = params
        return { ok: true }
      },
    })

    const reportPromise = session.requestTurnCompleteSelfReport('self-report-test', 2_000)
    await vi.waitFor(() => expect(sent?.commandId).toEqual(expect.any(String)))
    const commandId = sent!.commandId as string
    internals.handleDaemonEvent({
      ev: 'jsonl',
      sid: 'runtime-report',
      v: 10,
      line: JSON.stringify({
        kind: 'acp',
        ts: 1,
        source: 'control',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'first ' },
            },
          },
        },
      }),
    })
    internals.handleDaemonEvent({
      ev: 'jsonl',
      sid: 'runtime-report',
      v: 20,
      line: JSON.stringify({
        kind: 'acp',
        ts: 2,
        source: 'control',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'second' },
            },
          },
        },
      }),
    })
    internals.handleDaemonEvent({
      ev: 'jsonl',
      sid: 'runtime-report',
      v: 30,
      line: JSON.stringify({
        kind: 'meta',
        ts: 3,
        event: { type: 'control-ended', commandId, stopReason: 'end_turn' },
      }),
    })

    expect(await reportPromise).toBe('first second')
  })

  it('serializes fast terminal persistence behind prompt acceptance without reopening running', async () => {
    await createSessionRecord('provider-fast', 'task-fast', 'Project', tmpDir, {
      engine: 'codex',
      acpRuntimeId: 'runtime-fast',
      initialProcessStatus: 'idle',
      messageCount: 0,
    })
    const session = new AcpSession({
      taskId: 'task-fast',
      project: 'Project',
      cwd: tmpDir,
      mode: 'default',
      providerSessionId: 'provider-fast',
      runtimeId: 'runtime-fast',
    })
    const internals = session as unknown as {
      establish(): Promise<string>
      ensureConn(): Promise<{
        send(command: string, params: Record<string, unknown>): Promise<{ ok: boolean }>
      }>
      handleDaemonEvent(event: Record<string, unknown>): void
    }
    internals.establish = async () => 'provider-fast'
    internals.ensureConn = async () => ({
      send: async (_command, params) => {
        const commandId = params.commandId as string
        internals.handleDaemonEvent({
          ev: 'jsonl',
          sid: 'runtime-fast',
          v: 10,
          line: JSON.stringify({
            kind: 'meta',
            ts: 1,
            event: {
              type: 'prompt-accepted',
              commandId,
              walnutMessageId: params.walnutMessageId,
              text: params.text,
            },
          }),
        })
        internals.handleDaemonEvent({
          ev: 'jsonl',
          sid: 'runtime-fast',
          v: 20,
          line: JSON.stringify({
            kind: 'meta',
            ts: 2,
            event: { type: 'turn-ended', commandId, stopReason: 'end_turn' },
          }),
        })
        return { ok: true }
      },
    })

    await session.sendAccepted('instant reply', 'qm-fast')

    expect(session.activity).toBe('idle')
    expect(await getSessionByClaudeId('provider-fast')).toMatchObject({
      process_status: 'idle',
      messageCount: 1,
      lastAcceptedAcpCommandId: 'acp-prompt:qm-fast',
      status_reason: 'turn_completed',
    })
  })

  it('does not reopen running when a same-batch terminal fact wins before acceptance commits', async () => {
    await createSessionRecord('provider-batched', 'task-batched', 'Project', tmpDir, {
      engine: 'codex',
      acpRuntimeId: 'runtime-batched',
      initialProcessStatus: 'idle',
      messageCount: 0,
    })
    const statuses: Array<{ processStatus: string; phase?: string }> = []
    bus.subscribe('main-ai', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED) return
      const data = event.data as { process_status?: string; phase?: string }
      statuses.push({ processStatus: data.process_status ?? '', phase: data.phase })
    })

    const session = new AcpSession({
      taskId: 'task-batched',
      project: 'Project',
      cwd: tmpDir,
      mode: 'default',
      providerSessionId: 'provider-batched',
      runtimeId: 'runtime-batched',
    })
    const internals = session as unknown as {
      handleDaemonEvent(event: Record<string, unknown>): void
    }
    const commandId = 'acp-prompt:qm-batched'

    // Journal replay delivers both records synchronously. Prompt acceptance is
    // queued, while terminal observation updates _terminalCommands immediately.
    internals.handleDaemonEvent({
      ev: 'jsonl',
      sid: 'runtime-batched',
      v: 10,
      line: JSON.stringify({
        kind: 'meta',
        ts: 1,
        event: {
          type: 'prompt-accepted',
          commandId,
          walnutMessageId: 'qm-batched',
          text: 'instant turn',
        },
      }),
    })
    internals.handleDaemonEvent({
      ev: 'jsonl',
      sid: 'runtime-batched',
      v: 20,
      line: JSON.stringify({
        kind: 'meta',
        ts: 2,
        event: { type: 'turn-ended', commandId, stopReason: 'end_turn' },
      }),
    })

    await vi.waitFor(async () => {
      expect(await getSessionByClaudeId('provider-batched')).toMatchObject({
        process_status: 'idle',
        messageCount: 1,
        lastAcceptedAcpCommandId: commandId,
        status_reason: 'turn_completed',
      })
    })
    await vi.waitFor(() => {
      expect(statuses).toEqual([{ processStatus: 'idle', phase: undefined }])
    })
    expect(statuses).not.toContainEqual({ processStatus: 'running', phase: 'IN_PROGRESS' })
  })

  it('publishes prompt and terminal status boundaries to main-ai and web-ui', async () => {
    await createSessionRecord('provider-status', 'task-status', 'Project', tmpDir, {
      engine: 'codex',
      acpRuntimeId: 'runtime-status',
      initialProcessStatus: 'idle',
      messageCount: 0,
    })
    const mainStatuses: string[] = []
    const webStatuses: string[] = []
    bus.subscribe('main-ai', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED) return
      mainStatuses.push((event.data as { process_status?: string }).process_status ?? '')
    })
    bus.subscribe('web-ui', (event) => {
      if (event.name !== EventNames.SESSION_STATUS_CHANGED) return
      webStatuses.push((event.data as { process_status?: string }).process_status ?? '')
    })

    const session = new AcpSession({
      taskId: 'task-status',
      project: 'Project',
      cwd: tmpDir,
      mode: 'default',
      providerSessionId: 'provider-status',
      runtimeId: 'runtime-status',
    })
    const handle = (session as unknown as {
      handleDaemonEvent(event: Record<string, unknown>): void
    }).handleDaemonEvent.bind(session)

    handle({
      ev: 'jsonl',
      sid: 'runtime-status',
      v: 10,
      line: JSON.stringify({
        kind: 'meta',
        ts: 1,
        event: {
          type: 'prompt-accepted',
          commandId: 'acp-prompt:qm-status',
          walnutMessageId: 'qm-status',
          text: 'status boundary',
        },
      }),
    })
    await vi.waitFor(() => {
      expect(mainStatuses).toEqual(['running'])
      expect(webStatuses).toEqual(['running'])
    })

    handle({
      ev: 'jsonl',
      sid: 'runtime-status',
      v: 20,
      line: JSON.stringify({
        kind: 'meta',
        ts: 2,
        event: {
          type: 'turn-ended',
          commandId: 'acp-prompt:qm-status',
          stopReason: 'end_turn',
        },
      }),
    })
    await vi.waitFor(() => {
      expect(mainStatuses).toEqual(['running', 'idle'])
      expect(webStatuses).toEqual(['running', 'idle'])
    })
  })

  it('never emits private self-report text to main-ai', () => {
    const captured: unknown[] = []
    bus.subscribe('main-ai', (event) => captured.push(event))
    const session = new AcpSession({
      taskId: 'task-private',
      project: 'Project',
      cwd: tmpDir,
      mode: 'default',
      providerSessionId: 'provider-private',
      runtimeId: 'runtime-private',
    })
    ;(session as unknown as {
      handleDaemonEvent(event: Record<string, unknown>): void
    }).handleDaemonEvent({
      ev: 'jsonl',
      sid: 'runtime-private',
      v: 10,
      line: JSON.stringify({
        kind: 'acp',
        ts: 1,
        source: 'control',
        frame: {
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'FULL PRIVATE SELF REPORT' },
            },
          },
        },
      }),
    })

    expect(JSON.stringify(captured)).not.toContain('FULL PRIVATE SELF REPORT')
    expect(captured).toEqual([])
  })

  it('bounds recent results but searches the full store with exact id first', async () => {
    for (let i = 0; i < 105; i++) {
      await createSessionRecord(`provider-${i}`, `task-${i}`, 'Project', tmpDir, {
        engine: 'codex',
        initialProcessStatus: 'idle',
        messageCount: 0,
        title: i === 0 ? 'old exact target' : `session ${i}`,
      })
    }

    const recent = await querySessions()
    expect(recent.sessions).toHaveLength(100)
    expect(recent).toMatchObject({ total: 105, limit: 100, hasMore: true })

    const exact = await querySessions({ query: 'provider-0' })
    expect(exact.sessions[0].claudeSessionId).toBe('provider-0')
  })
})
