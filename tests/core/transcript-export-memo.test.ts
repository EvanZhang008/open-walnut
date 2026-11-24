/**
 * The transcript sweep touches only what moved (transcript-export-memo.ts).
 * 2026-11-24: on the Mac's data every once-a-minute pass parsed the saved copies of 952 stopped
 * sessions and rewrote and pushed the tails of 111 alive ones whose content had not changed.
 *
 * Real: session records, the projection export, the sweep and its reads of JSONL on disk.
 * Mocked: constants (temp dirs) and the '__local__' daemon file reader.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-transcript-export-memo'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { CLAUDE_HOME } from '../../src/constants.js'
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import { exportSessionProjection, exportSessionTranscripts, readSessionTranscript, _resetTranscriptSweepForTesting } from '../../src/core/session-projection.js'
import { transcriptCachePath, writeTranscriptCache } from '../../src/core/projection-cache.js'
import {
  archiveHeadOf, noteTailWritten, tailDigest, tailUnchanged, UNCHANGED_TAIL_REWRITE_MS, _resetTranscriptExportMemoForTesting,
} from '../../src/core/transcript-export-memo.js'

const CWD = '/Users/test/transcript-export-memo'
const jsonlPath = (sid: string): string => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sid}.jsonl`)
let seq = 0
const line = (role: 'user' | 'assistant', text: string): string => JSON.stringify({
  type: role, uuid: `${role}-${++seq}`, timestamp: new Date(Date.UTC(2026, 10, 24, 8, 0, seq)).toISOString(),
  message: role === 'user' ? { role, content: [{ type: 'text', text }] } : { id: `msg-${seq}`, role, content: [{ type: 'text', text }] },
})
const ino = async (sid: string): Promise<number> => (await fs.stat(transcriptCachePath(sid))).ino

async function sweep(): Promise<number> {
  await exportSessionProjection()
  _resetTranscriptSweepForTesting()
  return exportSessionTranscripts()
}

beforeEach(() => { _resetTranscriptExportMemoForTesting() })

describe('alive tails', () => {
  it('an unchanged tail is not saved again; a new turn or a copy someone else wrote is', async () => {
    const sid = 'sess-memo-alive'
    await createSessionRecord(sid, '', '', CWD, { title: 'Acme rollout', initialProcessStatus: 'idle' })
    await fs.mkdir(path.dirname(jsonlPath(sid)), { recursive: true })
    await fs.writeFile(jsonlPath(sid), [line('user', 'ship the Acme rollout'), line('assistant', 'On it.')].join('\n') + '\n')
    expect(await sweep()).toBeGreaterThanOrEqual(1)
    const first = await ino(sid)
    await sweep()
    expect(await ino(sid)).toBe(first)

    await fs.appendFile(jsonlPath(sid), line('assistant', 'Rolled out to the Acme fleet.') + '\n')
    await sweep()
    expect(await ino(sid)).not.toBe(first)
    expect((await readSessionTranscript(sid))!.messages.at(-1)!.text).toBe('Rolled out to the Acme fleet.')

    // A copy rewritten elsewhere (an older content) is put right on the next pass.
    await writeTranscriptCache(sid, { version: 1, sessionId: sid, exportedAt: '2026-01-01T00:00:00.000Z', truncated: false, messages: [] })
    await sweep()
    expect((await readSessionTranscript(sid))!.messages.at(-1)!.text).toBe('Rolled out to the Acme fleet.')
  })

  it('an unchanged tail is still saved once its save is older than the rewrite interval', async () => {
    const sid = 'sess-memo-age'
    await writeTranscriptCache(sid, { version: 1, sessionId: sid, exportedAt: '2026-11-24T08:00:00.000Z', truncated: false, messages: [] })
    const d = tailDigest({ truncated: false, messages: [{ role: 'user', text: 'hi' }] })
    await noteTailWritten(sid, d, 1_000)
    expect(await tailUnchanged(sid, d, 1_000 + UNCHANGED_TAIL_REWRITE_MS - 1)).toBe(true)
    expect(await tailUnchanged(sid, d, 1_000 + UNCHANGED_TAIL_REWRITE_MS)).toBe(false)
    expect(await tailUnchanged(sid, tailDigest({ truncated: true, messages: [{ role: 'user', text: 'hi' }] }), 1_000)).toBe(false)
  })
})

describe('stopped archives', () => {
  it('a saved copy is parsed once until its file changes, and an absent one reads as absent', async () => {
    const sid = 'sess-memo-stopped'
    await writeTranscriptCache(sid, { version: 1, sessionId: sid, exportedAt: '2026-11-24T08:00:00.000Z', truncated: false, messages: [] })
    let reads = 0
    const read = async () => { reads++; return (await readSessionTranscript(sid)) }
    expect(await archiveHeadOf(sid, read)).toEqual({ exportedAt: '2026-11-24T08:00:00.000Z' })
    expect(await archiveHeadOf(sid, read)).toEqual({ exportedAt: '2026-11-24T08:00:00.000Z' })
    expect(reads).toBe(1)
    await writeTranscriptCache(sid, { version: 1, sessionId: sid, exportedAt: '2026-11-24T09:00:00.000Z', truncated: false, messages: [] })
    expect(await archiveHeadOf(sid, read)).toEqual({ exportedAt: '2026-11-24T09:00:00.000Z' })
    expect(reads).toBe(2)
    await fs.rm(transcriptCachePath(sid))
    expect(await archiveHeadOf(sid, read)).toBeNull()
    expect(reads).toBe(2)
  })

  it('the sweep reads a stopped session\'s saved copy once across passes', async () => {
    const sid = 'sess-memo-stopped-sweep'
    await createSessionRecord(sid, '', '', CWD, { title: 'Old work', initialProcessStatus: 'idle' })
    await writeTranscriptCache(sid, { version: 1, sessionId: sid, exportedAt: '2030-01-01T00:00:00.000Z', truncated: false, messages: [] })
    await updateSessionRecord(sid, { process_status: 'stopped' })
    const spy = vi.spyOn(fs, 'readFile')
    await sweep()
    await sweep()
    await sweep()
    expect(spy.mock.calls.filter(([p]) => String(p) === transcriptCachePath(sid))).toHaveLength(1)
    spy.mockRestore()
  })
})
