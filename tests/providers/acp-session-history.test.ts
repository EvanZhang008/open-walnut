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
  _resetAcpHistoryCacheForTesting,
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
  // The fold cache is process-global; without this, a second test reading the
  // same runtimeId+path silently gets the first test's fold.
  _resetAcpHistoryCacheForTesting()
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

describe('ACP streaming fold (range-reader path)', () => {
  const chunkLine = (text: string, ts: number) => JSON.stringify({
    kind: 'acp', ts, source: 'live',
    frame: {
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    },
  }) + '\n'
  const promptLine = (n: number, text: string, ts: number) => JSON.stringify({
    kind: 'meta', ts,
    event: { type: 'prompt-accepted', commandId: `acp-prompt:qm-${n}`, walnutMessageId: `qm-${n}`, text },
  }) + '\n'

  /** Range-capable reader over an in-memory buffer, counting range calls. */
  const rangeReader = (state: { data: Buffer; rangeCalls: number }) => ({
    readFile: async () => { throw new Error('whole-file read must not be used on the streaming path') },
    stat: async () => ({ mtimeMs: 1, size: state.data.length }),
    readRangeBytes: async (_p: string, start: number, length: number) => {
      state.rangeCalls++
      const end = Math.min(start + length, state.data.length)
      return {
        buf: state.data.subarray(start, end),
        fileSize: state.data.length,
        eof: end >= state.data.length,
      }
    },
  })
  const journalRecord = (n: string) => ({
    claudeSessionId: `provider-${n}`,
    acpRuntimeId: `runtime-${n}`,
    acpJournalPath: `/virtual/runtime-${n}.acp.jsonl`,
  })

  it('folds a journal via bounded range reads and serves later reads incrementally', async () => {
    const state = { data: Buffer.from(promptLine(1, 'first question', 1) + chunkLine('first answer', 2)), rangeCalls: 0 }
    const reader = rangeReader(state)
    const record = journalRecord('stream')

    const first = await readAcpSessionHistoryState(record, { reader })
    expect(first.windowed).toBeUndefined()
    expect(first.messages.map((m) => m.text)).toEqual(['first question', 'first answer'])
    const callsAfterFirst = state.rangeCalls

    // Append one turn; the next read must fold ONLY the appended bytes (one
    // range call) and keep the earlier messages without re-reading them.
    state.data = Buffer.concat([state.data, Buffer.from(promptLine(2, 'second question', 3) + chunkLine('second answer', 4))])
    const second = await readAcpSessionHistoryState(record, { reader })
    expect(second.messages.map((m) => m.text))
      .toEqual(['first question', 'first answer', 'second question', 'second answer'])
    expect(state.rangeCalls).toBe(callsAfterFirst + 1)

    // Unchanged journal → zero additional range reads.
    await readAcpSessionHistoryState(record, { reader })
    expect(state.rangeCalls).toBe(callsAfterFirst + 1)
  })

  it('a chunk boundary can split a multi-byte char and a record without tearing either', async () => {
    // 1MB chunks: build >1MB of records where the boundary lands mid-record,
    // with CJK text so a boundary can also land mid-char.
    const filler = '中文字符边界测试'.repeat(2000) // ~48KB of 3-byte chars per line
    let content = promptLine(1, 'q', 1)
    for (let i = 0; i < 30; i++) content += chunkLine(filler, 2 + i)
    const state = { data: Buffer.from(content), rangeCalls: 0 }
    expect(state.data.length).toBeGreaterThan(1024 * 1024)

    const result = await readAcpSessionHistoryState(journalRecord('mbchar'), { reader: rangeReader(state) })
    expect(state.rangeCalls).toBeGreaterThan(1)
    // All chunks share one segment → one assistant message, byte-identical text.
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].text).toBe(filler.repeat(30))
  })

  it('a trailing partial line (mid-write) is not consumed and completes on the next read', async () => {
    const full = chunkLine('complete answer', 2)
    const state = {
      data: Buffer.concat([Buffer.from(promptLine(1, 'q', 1)), Buffer.from(full.slice(0, 20))]),
      rangeCalls: 0,
    }
    const reader = rangeReader(state)
    const record = journalRecord('torn')

    const first = await readAcpSessionHistoryState(record, { reader })
    expect(first.messages.map((m) => m.text)).toEqual(['q'])

    // Writer finishes the line.
    state.data = Buffer.concat([state.data, Buffer.from(full.slice(20))])
    const second = await readAcpSessionHistoryState(record, { reader })
    expect(second.messages.map((m) => m.text)).toEqual(['q', 'complete answer'])
  })

  it('tail-bounded cold read folds a window (windowed:true); a full read replaces it and clears the flag', async () => {
    let content = ''
    for (let n = 1; n <= 40; n++) content += promptLine(n, `question ${n}`, n * 2 - 1) + chunkLine(`answer ${n}`, n * 2)
    const state = { data: Buffer.from(content), rangeCalls: 0 }
    const reader = rangeReader(state)
    const record = journalRecord('window')
    const windowBytes = Math.floor(state.data.length / 4)

    const windowed = await readAcpSessionHistoryState(record, { reader, maxColdReadBytes: windowBytes })
    expect(windowed.windowed).toBe(true)
    expect(windowed.messages.length).toBeGreaterThan(0)
    expect(windowed.messages.length).toBeLessThan(80)
    expect(windowed.messages.at(-1)?.text).toBe('answer 40')

    // Full caller (Load earlier messages sends no tail) gets the whole journal.
    const full = await readAcpSessionHistoryState(record, { reader })
    expect(full.windowed).toBeUndefined()
    expect(full.messages).toHaveLength(80)
    expect(full.messages[0].text).toBe('question 1')

    // The full fold now serves windowed callers too — no re-window.
    const callsAfterFull = state.rangeCalls
    const again = await readAcpSessionHistoryState(record, { reader, maxColdReadBytes: windowBytes })
    expect(again.windowed).toBeUndefined()
    expect(again.messages).toHaveLength(80)
    expect(state.rangeCalls).toBe(callsAfterFull)
  })

  it('truncates fat tool results to the DTO cap (native parity)', async () => {
    const fat = 'x'.repeat(20000)
    const content = promptLine(1, 'q', 1)
      + JSON.stringify({
        kind: 'acp', ts: 2, source: 'live',
        frame: {
          method: 'session/update',
          params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call_0', title: 'Bash', rawInput: { command: 'ls' } } },
        },
      }) + '\n'
      + JSON.stringify({
        kind: 'acp', ts: 3, source: 'live',
        frame: {
          method: 'session/update',
          params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_0', status: 'completed', rawOutput: fat } },
        },
      }) + '\n'
    const state = { data: Buffer.from(content), rangeCalls: 0 }

    const result = await readAcpSessionHistoryState(journalRecord('fat'), { reader: rangeReader(state) })
    const tool = result.messages.find((m) => m.tools)?.tools?.[0]
    expect(tool?.result).toHaveLength(5000)
  })

  it('legacy journal (command-accepted era) still recovers user prompts on the streaming path', async () => {
    const legacy = [
      { kind: 'meta', ts: 1, event: { type: 'command-accepted', op: 'prompt', commandId: 'cmd-1' } },
      {
        kind: 'acp', ts: 2, source: 'provider-replay',
        frame: {
          method: 'session/update',
          params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'legacy question' } } },
        },
      },
      {
        kind: 'acp', ts: 3, source: 'live',
        frame: {
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'legacy answer' } } },
        },
      },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n'
    const state = { data: Buffer.from(legacy), rangeCalls: 0 }

    const result = await readAcpSessionHistoryState(journalRecord('legacy'), { reader: rangeReader(state) })
    expect(result.messages.map((m) => m.text)).toEqual(['legacy question', 'legacy answer'])
  })

  it('a journal that vanishes mid-stream is NOT cached as a complete history', async () => {
    let content = ''
    for (let n = 1; n <= 30; n++) content += promptLine(n, `q${n}`, n * 2 - 1) + chunkLine(`a${n}`, n * 2)
    const data = Buffer.from(content)
    let vanishAfterCalls = 1 // first range read succeeds, then the file "disappears"
    let calls = 0
    const reader = {
      readFile: async () => { throw new Error('whole-file read must not be used on the streaming path') },
      stat: async () => ({ mtimeMs: 1, size: data.length }),
      readRangeBytes: async (_p: string, start: number, length: number) => {
        calls++
        if (calls > vanishAfterCalls) return null // vanished between stat and read
        const end = Math.min(start + Math.min(length, 4096), data.length)
        return { buf: data.subarray(start, end), fileSize: data.length, eof: end >= data.length }
      },
    }
    const record = journalRecord('vanish')

    // Streaming path returns null internally → candidate loop exhausts → journalExists:false,
    // and crucially the partial fold must NOT be cached.
    const first = await readAcpSessionHistoryState(record, { reader })
    expect(first.journalExists).toBe(false)
    expect(first.messages).toEqual([])

    // File "reappears" (e.g. later candidate resolves / transient flap over) —
    // a fresh read must fold the WHOLE journal, not resume a poisoned entry.
    vanishAfterCalls = Number.POSITIVE_INFINITY
    const second = await readAcpSessionHistoryState(record, { reader })
    expect(second.journalExists).toBe(true)
    expect(second.messages).toHaveLength(60)
  })

  it('a shrunk/replaced journal invalidates the cached fold instead of serving stale messages', async () => {
    const state = { data: Buffer.from(promptLine(1, 'old world', 1) + chunkLine('old answer', 2)), rangeCalls: 0 }
    const reader = rangeReader(state)
    const record = journalRecord('shrink')
    await readAcpSessionHistoryState(record, { reader })

    state.data = Buffer.from(promptLine(9, 'new world', 9))
    const result = await readAcpSessionHistoryState(record, { reader })
    expect(result.messages.map((m) => m.text)).toEqual(['new world'])
  })

  it('an epoch change invalidates the fold even when the replacement file is LONGER', async () => {
    const state = {
      data: Buffer.from(promptLine(1, 'incarnation one', 1) + chunkLine('answer one', 2)),
      rangeCalls: 0,
      epoch: 'dev:1:100',
    }
    const reader = {
      ...rangeReader(state),
      stat: async () => ({ mtimeMs: 1, size: state.data.length, epoch: state.epoch }),
    }
    const record = journalRecord('epoch')
    await readAcpSessionHistoryState(record, { reader })

    // Same path, new incarnation, REGROWN PAST the old offset — the size test
    // alone cannot catch this; the epoch must.
    let replacement = ''
    for (let n = 1; n <= 6; n++) replacement += promptLine(n, `incarnation two q${n}`, n)
    state.data = Buffer.from(replacement)
    state.epoch = 'dev:2:200'
    const result = await readAcpSessionHistoryState(record, { reader })
    expect(result.messages).toHaveLength(6)
    expect(result.messages[0].text).toBe('incarnation two q1')
  })

  it('a windowed cold read warms the full fold in the background — the next poll is complete', async () => {
    let content = ''
    for (let n = 1; n <= 40; n++) content += promptLine(n, `question ${n}`, n * 2 - 1) + chunkLine(`answer ${n}`, n * 2)
    const state = { data: Buffer.from(content), rangeCalls: 0 }
    const reader = rangeReader(state)
    const record = journalRecord('warmup')
    const windowBytes = Math.floor(state.data.length / 4)

    const windowed = await readAcpSessionHistoryState(record, { reader, maxColdReadBytes: windowBytes })
    expect(windowed.windowed).toBe(true)

    // Let the fire-and-forget warm-up drain, then poll with the SAME tail
    // bound: it must now serve the complete history with no windowed flag and
    // without the user ever requesting a full read.
    await vi.waitFor(async () => {
      const next = await readAcpSessionHistoryState(record, { reader, maxColdReadBytes: windowBytes })
      expect(next.windowed).toBeUndefined()
      expect(next.messages).toHaveLength(80)
    })
  })

  it('served payloads are isolated from the cache — caller mutation cannot poison later reads', async () => {
    const state = { data: Buffer.from(promptLine(1, 'pristine question', 1) + chunkLine('pristine answer', 2)), rangeCalls: 0 }
    const reader = rangeReader(state)
    const record = journalRecord('mutate')

    const first = await readAcpSessionHistoryState(record, { reader })
    // Simulate rewriteHistoryRemoteImages: in-place mutation of served objects.
    first.messages[1].text = '/local/mirror/path.png'

    const second = await readAcpSessionHistoryState(record, { reader })
    expect(second.messages[1].text).toBe('pristine answer')
  })

  it('legacy journal with a torn trailing line stays cached (no re-fold per poll)', async () => {
    const legacyRecords = [
      { kind: 'meta', ts: 1, event: { type: 'command-accepted', op: 'prompt', commandId: 'cmd-1' } },
      {
        kind: 'acp', ts: 2, source: 'provider-replay',
        frame: {
          method: 'session/update',
          params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'legacy question' } } },
        },
      },
      {
        kind: 'acp', ts: 3, source: 'live',
        frame: {
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'legacy answer' } } },
        },
      },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n'
    // Mid-write crash: the file ends in a PARTIAL line (no trailing newline).
    const torn = legacyRecords + '{"kind":"acp","ts":4,"sour'
    const state = { data: Buffer.from(torn), rangeCalls: 0 }
    const reader = rangeReader(state)
    const record = journalRecord('legacy-torn')

    const first = await readAcpSessionHistoryState(record, { reader })
    expect(first.messages.map((m) => m.text)).toEqual(['legacy question', 'legacy answer'])
    const callsAfterFirst = state.rangeCalls

    const second = await readAcpSessionHistoryState(record, { reader })
    expect(second.messages.map((m) => m.text)).toEqual(['legacy question', 'legacy answer'])
    expect(state.rangeCalls).toBe(callsAfterFirst)
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
