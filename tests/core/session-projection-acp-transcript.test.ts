/**
 * buildSessionTranscript for ACP/codex sessions — regression for the
 * 2026-08-16 empty-transcript incident: an engine=codex record has NO claude
 * JSONL (history lives in the ACP journal, keyed by the runtimeId), so the
 * claude-only readSessionHistoryTail silently returned [] and every export /
 * fresh=1 read / cloud tail served `messages: []` for a session whose web
 * console showed a full conversation. The transcript builder must take the
 * same engine branch the /history route takes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-transcript'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import {
  createSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb, SESSION_DB_PATH } from '../../src/core/session-db.js'
import { buildSessionTranscript } from '../../src/core/session-projection.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-transcript-test-'))
  closeDb()
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(SESSION_DB_PATH + suffix, { force: true })
  }
  _resetSessionTrackerForTesting()
})

afterEach(() => {
  closeDb()
  _resetSessionTrackerForTesting()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeJournal(journalPath: string): void {
  const lines = [
    {
      kind: 'meta', ts: 1,
      event: {
        type: 'prompt-accepted',
        commandId: 'acp-prompt:qm-1',
        walnutMessageId: 'qm-1',
        text: 'sort the models by capability',
      },
    },
    {
      kind: 'acp', ts: 2, source: 'live',
      frame: {
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Done — sorted low to high.' },
          },
        },
      },
    },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(journalPath, lines)
}

describe('buildSessionTranscript (engine=codex)', () => {
  it('serves the ACP journal history instead of an empty claude-JSONL read', async () => {
    const runtimeId = 'acp-transcript-rt-1'
    const journalPath = path.join(tmpDir, `${runtimeId}.acp.jsonl`)
    writeJournal(journalPath)
    await createSessionRecord('acp-sid-transcript-1', 'task-1', 'Project', tmpDir, {
      engine: 'codex',
      acpRuntimeId: runtimeId,
      acpJournalPath: journalPath,
      initialProcessStatus: 'idle',
      messageCount: 1,
    })

    const transcript = await buildSessionTranscript('acp-sid-transcript-1')
    expect(transcript.sessionId).toBe('acp-sid-transcript-1')
    const texts = transcript.messages.map((m) => m.text)
    expect(texts).toContain('sort the models by capability')
    expect(texts).toContain('Done — sorted low to high.')
    // Roles survive the projection (user prompt + assistant reply).
    expect(transcript.messages.find((m) => m.text === 'sort the models by capability')?.role).toBe('user')
    expect(transcript.messages.find((m) => m.text === 'Done — sorted low to high.')?.role).toBe('assistant')
  })

  it('claude-engine sessions still take the JSONL tail path (no regression)', async () => {
    // No engine → claude. The mocked reader finds no JSONL for this sid, so
    // the tail read returns empty — the point is that the codex branch did
    // NOT hijack the default path (no journal lookup for claude records).
    await createSessionRecord('claude-sid-transcript-1', 'task-2', 'Project', tmpDir, {
      initialProcessStatus: 'idle',
      messageCount: 0,
    })
    const transcript = await buildSessionTranscript('claude-sid-transcript-1')
    expect(transcript.sessionId).toBe('claude-sid-transcript-1')
    expect(Array.isArray(transcript.messages)).toBe(true)
  })
})
