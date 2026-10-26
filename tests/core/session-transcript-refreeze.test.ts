/**
 * The transcript sweep re-freezes a stopped session's archive when that archive
 * was exported before the session ended.
 *
 * The sweep exports alive sessions at most once a minute and, once a session is
 * stopped, keeps whatever tail it has as the archive. A session that ended
 * inside that minute kept a tail without its final turn for good. The sweep now
 * rebuilds such an archive once per end, and never replaces it with an empty
 * read (the JSONL may be gone by then).
 *
 * Real: session records in SQLite, the projection export, the sweep, the read
 * pipeline against JSONL on disk. Mocked: constants (temp dirs) and the
 * '__local__' daemon file reader.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-transcript-refreeze'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { CLAUDE_HOME } from '../../src/constants.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import {
  exportSessionProjection, exportSessionTranscripts, readSessionTranscript,
  archivePredatesEnd, _resetTranscriptSweepForTesting,
} from '../../src/core/session-projection.js'
import { writeTranscriptCache } from '../../src/core/projection-cache.js'
import { DaemonFileReader } from '../../src/core/daemon-file-reader.js'

const CWD = '/Users/test/transcript-refreeze'
const jsonlPath = (sid: string): string => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sid}.jsonl`)

let seq = 0
const line = (role: 'user' | 'assistant', text: string): string => JSON.stringify({
  type: role, uuid: `${role}-${++seq}`, timestamp: new Date(Date.UTC(2026, 9, 26, 1, 0, seq)).toISOString(),
  message: role === 'user'
    ? { role, content: [{ type: 'text', text }] }
    : { id: `msg-${seq}`, role, content: [{ type: 'text', text }] },
})

async function seed(sid: string): Promise<void> {
  await createSessionRecord(sid, '', '', CWD, { title: 'Subtask', initialProcessStatus: 'idle' })
  await fs.mkdir(path.dirname(jsonlPath(sid)), { recursive: true })
  await fs.writeFile(jsonlPath(sid), [line('user', 'do it'), line('assistant', 'Final answer.')].join('\n') + '\n')
  // The archive the sweep wrote while the session was alive: before the end.
  await writeTranscriptCache(sid, {
    version: 1, sessionId: sid, exportedAt: '2026-01-01T00:00:00.000Z', truncated: false,
    messages: [{ role: 'user', text: 'do it', timestamp: '2026-01-01T00:00:00.000Z' }],
  })
  await updateSessionRecord(sid, { process_status: 'stopped' })
}

async function sweep(): Promise<number> {
  await exportSessionProjection()
  _resetTranscriptSweepForTesting()
  return exportSessionTranscripts()
}

beforeEach(() => { vi.restoreAllMocks() })

describe('transcript sweep re-freeze', () => {
  it('archivePredatesEnd compares the export time with the last activity, inside a day of it', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z')
    expect(archivePredatesEnd({ exportedAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:01.000Z', now)).toBe(true)
    expect(archivePredatesEnd({ exportedAt: '2026-01-01T00:00:01.000Z' }, '2026-01-01T00:00:01.000Z', now)).toBe(false)
    expect(archivePredatesEnd({ exportedAt: '2026-01-01T00:00:00.000Z' }, undefined, now)).toBe(false)
    expect(archivePredatesEnd({ exportedAt: 'garbage' }, '2026-01-01T00:00:01.000Z', now)).toBe(false)
    // An end more than a day ago: the archive is served as it is (no upgrade backlog).
    expect(archivePredatesEnd({ exportedAt: '2025-12-30T00:00:00.000Z' }, '2025-12-31T00:00:00.000Z', now)).toBe(false)
  })

  it('re-freezes at most ten archives per sweep, newest end first', async () => {
    const sids = Array.from({ length: 12 }, (_, i) => `sess-refreeze-burst-${String(i).padStart(2, '0')}`)
    for (const sid of sids) await seed(sid)
    await sweep()
    const fixed = async (): Promise<string[]> => {
      const out: string[] = []
      for (const sid of sids) if ((await readSessionTranscript(sid))!.messages.at(-1)!.text === 'Final answer.') out.push(sid)
      return out
    }
    // Seeded in order, so the two OLDEST ends wait for the next sweep.
    expect(await fixed()).toEqual(sids.slice(2))
    await sweep()
    expect(await fixed()).toEqual(sids)
  })

  it('rebuilds an archive exported before the end, once', async () => {
    const sid = 'sess-refreeze-stale'
    await seed(sid)
    await sweep()
    const after = await readSessionTranscript(sid)
    expect(after!.messages.at(-1)!.text).toBe('Final answer.')
    // Now newer than the end: the next sweep leaves it alone (no read at all).
    const reads = vi.spyOn(DaemonFileReader.prototype, 'stat')
    await sweep()
    expect(reads.mock.calls.filter(([p]) => String(p).includes(sid))).toHaveLength(0)
  })

  it('never replaces an archive with an empty read, and does not retry it every sweep', async () => {
    const sid = 'sess-refreeze-purged'
    await seed(sid)
    await fs.rm(jsonlPath(sid))
    const reads = vi.spyOn(DaemonFileReader.prototype, 'stat')
    await sweep()
    expect((await readSessionTranscript(sid))!.messages.map((m) => m.text)).toEqual(['do it'])
    const first = reads.mock.calls.filter(([p]) => String(p).includes(sid)).length
    expect(first).toBeGreaterThan(0)
    await sweep()
    expect(reads.mock.calls.filter(([p]) => String(p).includes(sid)).length).toBe(first)
  })
})
