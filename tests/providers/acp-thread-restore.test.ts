/**
 * A fresh provider thread minted by a failed session/load is not the
 * conversation until it finishes a turn (src/providers/acp-thread-restore.ts).
 * 2026-10-30: an interrupt killed a Codex worker, the replacement's load was
 * refused, the fallback thread failed its first turn the same way, and the
 * session kept loading the empty thread while the real one sat on disk.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findThreadToRestore, replacedThreadToRestore } from '../../src/providers/acp-thread-restore.js'

const meta = (event: Record<string, unknown>) => JSON.stringify({ kind: 'meta', ts: 1, event })
const frame = (sessionId: string) => JSON.stringify({ kind: 'acp', ts: 1, source: 'live', frame: { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } } } } })
const journal = (...lines: string[]) => lines.join('\n') + '\n'

const OLD = 'thread-old'
const NEW = 'thread-new'

describe('replacedThreadToRestore', () => {
  it('restores the earlier thread when the fresh one only ever failed (the 2026-10-30 journal shape)', () => {
    const text = journal(
      meta({ type: 'session-created', providerSessionId: OLD }),
      meta({ type: 'prompt-accepted', commandId: 'c1', text: 'hi' }),
      frame(OLD),
      meta({ type: 'turn-ended', commandId: 'c1', stopReason: 'end_turn' }),
      meta({ type: 'turn-ended', commandId: 'c2', stopReason: 'cancelled' }),
      meta({ type: 'session-created', providerSessionId: NEW }),
      meta({ type: 'prompt-accepted', commandId: 'c3', text: 'next' }),
      meta({ type: 'error', errorKind: 'protocol', message: 'ACP provider protocol operation failed', commandId: 'c3' }),
      meta({ type: 'turn-interrupted', reason: 'worker-crash', commandId: 'c3' }),
    )
    expect(replacedThreadToRestore(text, NEW)).toBe(OLD)
  })

  it('keeps the fresh thread once it finished a turn of its own', () => {
    for (const stopReason of ['end_turn', 'cancelled', 'max_tokens']) {
      const text = journal(
        meta({ type: 'session-created', providerSessionId: OLD }),
        meta({ type: 'session-created', providerSessionId: NEW }),
        meta({ type: 'turn-ended', commandId: 'c3', stopReason }),
      )
      expect(replacedThreadToRestore(text, NEW)).toBeNull()
    }
  })

  it('never fires for a thread that was loaded, or for the only thread', () => {
    expect(replacedThreadToRestore(journal(
      meta({ type: 'session-created', providerSessionId: OLD }),
      meta({ type: 'session-loaded', providerSessionId: NEW }),
    ), NEW)).toBeNull()
    expect(replacedThreadToRestore(journal(meta({ type: 'session-created', providerSessionId: NEW })), NEW)).toBeNull()
    expect(replacedThreadToRestore('', NEW)).toBeNull()
    expect(replacedThreadToRestore(journal(meta({ type: 'session-created', providerSessionId: OLD })), 'unknown')).toBeNull()
  })

  it('stops once the earlier thread was loaded back (no loop)', () => {
    // After a restore the worker journals session-loaded for OLD; the record now
    // names OLD, which was loaded last, so nothing fires.
    const text = journal(
      meta({ type: 'session-created', providerSessionId: OLD }),
      meta({ type: 'session-created', providerSessionId: NEW }),
      meta({ type: 'session-loaded', providerSessionId: OLD }),
    )
    expect(replacedThreadToRestore(text, OLD)).toBeNull()
  })

  it('takes the thread in use right before the fresh one, after several replacements', () => {
    const text = journal(
      meta({ type: 'session-created', providerSessionId: 'a' }),
      meta({ type: 'session-loaded', providerSessionId: 'b' }),
      meta({ type: 'session-created', providerSessionId: NEW }),
    )
    expect(replacedThreadToRestore(text, NEW)).toBe('b')
  })

  it('passes over a replacement of a replacement to the thread that holds the conversation', () => {
    // The provider stayed broken through two cold starts: each minted a thread
    // that never finished a turn. The conversation is still the first one.
    const text = journal(
      meta({ type: 'session-created', providerSessionId: OLD }),
      meta({ type: 'turn-ended', commandId: 'c1', stopReason: 'end_turn' }),
      meta({ type: 'session-created', providerSessionId: 'fallback-1' }),
      meta({ type: 'turn-interrupted', reason: 'worker-crash', commandId: 'c2' }),
      meta({ type: 'session-loaded', providerSessionId: 'fallback-1' }),
      meta({ type: 'session-created', providerSessionId: NEW }),
    )
    expect(replacedThreadToRestore(text, NEW)).toBe(OLD)
    // A fresh thread that later got a turn of its own is never undone, even
    // when it is not the one asked for now.
    expect(replacedThreadToRestore(journal(
      meta({ type: 'session-created', providerSessionId: OLD }),
      meta({ type: 'session-created', providerSessionId: NEW }),
      meta({ type: 'session-loaded', providerSessionId: OLD }),
      meta({ type: 'session-loaded', providerSessionId: NEW }),
      meta({ type: 'turn-ended', commandId: 'c9', stopReason: 'end_turn' }),
    ), NEW)).toBeNull()
  })

  it('keeps a fresh thread the provider worked in, even when its turn ended in an error', () => {
    // A long turn of tool calls in the fresh thread that a 429 or a hard abort
    // ended without turn-ended is real work: undoing it would make the model
    // forget it while the transcript still shows it.
    const toolFrame = (sessionId: string) => JSON.stringify({ kind: 'acp', ts: 1, source: 'live', frame: { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 't1' } } } })
    const commandsFrame = (sessionId: string) => JSON.stringify({ kind: 'acp', ts: 1, source: 'live', frame: { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } } })
    for (const work of [frame(NEW), toolFrame(NEW)]) {
      expect(replacedThreadToRestore(journal(
        meta({ type: 'session-created', providerSessionId: OLD }),
        meta({ type: 'turn-ended', commandId: 'c1', stopReason: 'end_turn' }),
        meta({ type: 'session-created', providerSessionId: NEW }),
        work,
        meta({ type: 'error', errorKind: 'protocol', message: 'x', commandId: 'c2' }),
        meta({ type: 'turn-interrupted', reason: 'worker-crash', commandId: 'c2' }),
      ), NEW)).toBeNull()
    }
    // The 2026-10-30 fresh thread sent only its command list: no work.
    expect(replacedThreadToRestore(journal(
      meta({ type: 'session-created', providerSessionId: OLD }),
      meta({ type: 'turn-ended', commandId: 'c1', stopReason: 'end_turn' }),
      meta({ type: 'session-created', providerSessionId: NEW }),
      commandsFrame(NEW),
      meta({ type: 'turn-interrupted', reason: 'worker-crash', commandId: 'c2' }),
    ), NEW)).toBe(OLD)
  })

  it('skips torn and foreign lines', () => {
    const text = [
      meta({ type: 'session-created', providerSessionId: OLD }),
      '{"kind":"meta","ts":1,"event":{"type":"session-cre',
      'not json "kind":"meta" "session-created"',
      meta({ type: 'session-created', providerSessionId: NEW }),
    ].join('\n')
    expect(replacedThreadToRestore(text, NEW)).toBe(OLD)
  })
})

describe('findThreadToRestore', () => {
  it('reads the journal file and never throws on a missing one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-restore-'))
    try {
      const file = path.join(dir, 'j.acp.jsonl')
      fs.writeFileSync(file, journal(
        meta({ type: 'session-created', providerSessionId: OLD }),
        meta({ type: 'session-created', providerSessionId: NEW }),
      ))
      expect(await findThreadToRestore(file, NEW)).toBe(OLD)
      // A journal far longer than one read chunk, streamed: the same answer.
      fs.writeFileSync(file, journal(
        meta({ type: 'session-created', providerSessionId: OLD }),
        ...Array.from({ length: 20_000 }, () => frame(OLD)),
        meta({ type: 'session-created', providerSessionId: NEW }),
      ))
      expect(await findThreadToRestore(file, NEW)).toBe(OLD)
      expect(await findThreadToRestore(file, undefined)).toBeNull()
      expect(await findThreadToRestore(path.join(dir, 'missing.jsonl'), NEW)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
