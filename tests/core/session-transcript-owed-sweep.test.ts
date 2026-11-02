/**
 * A transcript sweep the throttle turns away is owed, not dropped.
 *
 * The sweep runs at most once a minute. A turn that ended just after a sweep
 * asked for one inside that minute, was turned away, and when no other session
 * event followed (an idle session), its tail stayed without the reply for good:
 * task_history read the cache and never showed the answer (2026-11-02, an older
 * Walnut's session after a join, in the Fresh Mac join CI job).
 *
 * Real: session records in SQLite, the projection export, the sweep, the read
 * pipeline against JSONL on disk. Mocked: constants (temp dirs), the '__local__'
 * daemon file reader, and the clock (fake timers for setTimeout and Date only).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-transcript-owed-sweep'))
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { CLAUDE_HOME } from '../../src/constants.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { encodeProjectPath } from '../../src/core/session-history.js'
import {
  exportSessionProjection, exportSessionTranscripts, readSessionTranscript, _resetTranscriptSweepForTesting,
} from '../../src/core/session-projection.js'

const CWD = '/Users/test/transcript-owed-sweep'
const jsonlPath = (sid: string): string => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${sid}.jsonl`)

let seq = 0
const line = (role: 'user' | 'assistant', text: string): string => JSON.stringify({
  type: role, uuid: `${role}-${++seq}`, timestamp: new Date(Date.UTC(2026, 10, 2, 17, 19, seq)).toISOString(),
  message: role === 'user'
    ? { role, content: [{ type: 'text', text }] }
    : { id: `msg-${seq}`, role, content: [{ type: 'text', text }] },
})

const texts = async (sid: string): Promise<string[]> => ((await readSessionTranscript(sid))?.messages ?? []).map((m) => m.text)

/** An idle (alive) session whose turn has started: the person's words, no reply yet. */
async function midTurn(sid: string): Promise<void> {
  await createSessionRecord(sid, '', '', CWD, { title: 'Older session', initialProcessStatus: 'idle' })
  await fs.mkdir(path.dirname(jsonlPath(sid)), { recursive: true })
  await fs.writeFile(jsonlPath(sid), line('user', 'hello after the join') + '\n')
  await exportSessionProjection()
}

afterEach(() => {
  _resetTranscriptSweepForTesting()
  vi.useRealTimers()
})

describe('transcript sweep throttle', () => {
  it('a reply that lands just after a sweep is exported when the window ends, with no further event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sid = 'sess-owed-sweep-reply'
    await midTurn(sid)
    _resetTranscriptSweepForTesting()
    expect(await exportSessionTranscripts()).toBeGreaterThan(0)
    expect(await texts(sid)).toEqual(['hello after the join'])

    // The turn ends 0.3 s later; its result asks for a sweep, inside the window.
    await vi.advanceTimersByTimeAsync(300)
    await fs.appendFile(jsonlPath(sid), line('assistant', 'echo: hello after the join') + '\n')
    expect(await exportSessionTranscripts()).toBe(0)
    expect(await texts(sid)).toEqual(['hello after the join'])

    // Nothing else happens. The owed sweep runs when the minute is up.
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(async () => expect(await texts(sid)).toEqual(['hello after the join', 'echo: hello after the join']))
  })

  it('many asks inside one window owe one sweep, not one each', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sid = 'sess-owed-sweep-once'
    await midTurn(sid)
    _resetTranscriptSweepForTesting()
    await exportSessionTranscripts()
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await exportSessionTranscripts()).toBe(0)
    }
    await fs.appendFile(jsonlPath(sid), line('assistant', 'echo: once') + '\n')
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(async () => expect(await texts(sid)).toContain('echo: once'))
    const exportedAt = (await readSessionTranscript(sid))?.exportedAt
    // No second owed sweep follows the first: the export stays as it was.
    await vi.advanceTimersByTimeAsync(180_000)
    expect((await readSessionTranscript(sid))?.exportedAt).toBe(exportedAt)
  })
})
