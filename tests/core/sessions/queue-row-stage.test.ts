/**
 * The queue card's stage of a row: waiting, written, taken (sessions/queue-row-view.ts).
 *
 * 2026-11-06, the user's phone: a message sat as "Delivering…" for 27 s, though
 * the CLI had read it 12 s after it was written; the row stays queued after the
 * CLI took its line, until the model answers (line-answer-v1). The queue read
 * now says how far each row got, from the runner's own word on the line.
 *
 * What's real: SessionRunner (injectMidTurn), ClaudeCodeSession (writeMessage,
 * the stream handler), the disk queue, getSessionQueuePayload. Mocked: the
 * transport (no process, no daemon), as in tests/providers/line-answer-hold.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-queue-row-stage'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { createSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { closeDb } from '../../../src/core/session-db.js'
import { ClaudeCodeSession, SessionRunner } from '../../../src/providers/claude-code-session.js'
import { editMessage, enqueueMessage, getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import { noteHeld, resetLineConsumption } from '../../../src/providers/line-consumption.js'
import { bus } from '../../../src/core/event-bus.js'
import { getSessionQueuePayload } from '../../../src/core/sessions/session-extras.js'
import { NO_LINE_WORDS, QUEUE_STAGES, queueRowFacts, queueRowView, queueImageUrl } from '../../../src/core/sessions/queue-row-view.js'
import { composeHinted } from '../../../src/core/hints/hint-format.js'
import { withImagePaths } from '../../../src/core/sessions/cloud-images.js'
import { withFilePaths } from '../../../src/core/sessions/session-uploads.js'

const SID = '10000000-0000-4000-8000-000000000c01'

function harness() {
  const writes: Array<{ message: string; uuid?: string }> = []
  const transport = {
    writeMessage: async (message: string, o?: { uuid?: string; onDispatch?: () => void }) => {
      o?.onDispatch?.()
      writes.push({ message, uuid: o?.uuid })
      return true
    },
    writeRaw: () => true,
    writeSyntheticUserEvent: () => {},
    deletePipe: () => {},
    stopTail: () => {},
    flushTail: () => {},
    kill: () => {},
    stop: async () => {},
    interrupt: async () => {},
    hasPipe: true,
    fileSize: 0,
    pid: 12345,
    judgesAnswers: true,
  }
  const session = new ClaudeCodeSession('stage-task', 'test', '/bin/true')
  Object.assign(session, {
    claudeSessionId: SID, _transport: transport, _processStatus: 'running', _active: true, pid: 12345,
    _sawCommandLifecycle: true,
  })
  const runner = new SessionRunner('/bin/true')
  const internals = runner as unknown as { sessions: Map<string, ClaudeCodeSession>; injectMidTurn(sid: string): Promise<void> }
  internals.sessions.set('stage-task', session)
  const line = (ev: Record<string, unknown>) => (session as unknown as { handleStreamLine(l: string): void }).handleStreamLine(JSON.stringify(ev))
  return {
    internals, writes,
    lifecycle: (uuid: string, state: string) => line({ type: 'command_lifecycle', command_uuid: uuid, state }),
    answer: () => line({ type: 'assistant', parent_tool_use_id: null, message: { id: `m-${Math.random()}`, role: 'assistant', content: [{ type: 'text', text: 'the answer' }] } }),
  }
}

type Row = { id: string; status: string; stage: string; delivered: boolean; message: string; words?: string; rawMessage?: string; images?: unknown; files?: unknown }
const payload = async () => (await getSessionQueuePayload(SID)).messages as Row[]
const settle = () => new Promise((r) => setTimeout(r, 50))

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  resetLineConsumption()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  await createSessionRecord(SID, 'stage-task', 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
})

afterEach(async () => {
  bus.clear()
  resetLineConsumption()
  resetCache()
  closeDb()
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 })
})

describe('a queued row says how far it got', () => {
  it('waiting, then written, then taken (delivered), then gone once answered', async () => {
    const h = harness()
    const row = await enqueueMessage(SID, 'question', { sentBy: 'person' })
    expect(await payload()).toMatchObject([{ id: row.id, status: 'pending', stage: 'waiting', delivered: false, sentBy: 'person' }])

    // Written into the CLI's stdin mid-turn: it reads it after its current step.
    await h.internals.injectMidTurn(SID)
    expect(h.writes).toHaveLength(1)
    expect(await payload()).toMatchObject([{ id: row.id, status: 'processing', stage: 'written', delivered: false }])

    // The CLI read it: the model has it, only the answer is to come. Still in the queue.
    h.lifecycle(h.writes[0].uuid!, 'started')
    await settle()
    expect(await payload()).toMatchObject([{ id: row.id, status: 'processing', stage: 'taken', delivered: true }])

    h.answer()
    await vi.waitFor(async () => expect(await payload()).toEqual([]))
  })

  it('a row held back behind a line still being confirmed was never written: waiting', async () => {
    await enqueueMessage(SID, 'first')
    const h = harness()
    await h.internals.injectMidTurn(SID)
    const [row] = await getQueue(SID)
    expect(row.status).toBe('processing')
    noteHeld(SID, [row.id], 'Waiting for the earlier message to be confirmed')
    expect(await payload()).toMatchObject([{ id: row.id, status: 'processing', stage: 'waiting', delivered: false }])
  })

  it('written only when the runner holds the line as in the CLI: a processing row it does not hold is waiting', () => {
    const live = { taken: new Set<string>(), awaited: new Set(['other']), held: new Set<string>() }
    expect(queueRowFacts({ id: 'mid-delivery', status: 'processing', message: 'x' }, SID, live)).toEqual({ stage: 'waiting', delivered: false })
    expect(queueRowFacts({ id: 'other', status: 'processing', message: 'x' }, SID, live)).toEqual({ stage: 'written', delivered: false })
  })

  it('with no live word (idle, cold resume, an untracked engine) every row reads waiting', () => {
    for (const status of ['processing', 'pending', 'parked', 'held']) {
      expect(queueRowFacts({ id: 'a', status, message: 'x' }, SID, NO_LINE_WORDS)).toEqual({ stage: 'waiting', delivered: false })
    }
  })
})

describe('a queued row names its typed words, pictures and files; `message` keeps its frozen meaning', () => {
  it('the payload keeps `message` as before, puts the typed words in `words`, and names the pictures and files', async () => {
    const text = withImagePaths(withFilePaths('look at these', ['/data/up/clip.mov']), ['/data/images/a.png', '/data/images/b.jpg'])
    const row = await enqueueMessage(SID, text, { sentBy: 'person' })
    const [shown] = await payload()
    // An older phone resends `message` as it is (Undo): it still carries the headers.
    expect(shown.message).toBe(text)
    expect(shown.words).toBe('look at these')
    expect(shown.images).toEqual([
      { path: '/data/images/a.png', url: queueImageUrl('/data/images/a.png', SID) },
      { path: '/data/images/b.jpg', url: queueImageUrl('/data/images/b.jpg', SID) },
    ])
    expect(shown.files).toEqual([{ path: '/data/up/clip.mov', name: 'clip.mov' }])
    expect(queueImageUrl('/data/images/a.png', SID)).toBe(`/api/v1/media?path=%2Fdata%2Fimages%2Fa.png&session=${SID}`)
    expect(shown.id).toBe(row.id)
  })

  it('a row with no attachment is unchanged and carries no images or files keys', () => {
    const shown = queueRowView({ id: 'q', status: 'pending', message: 'plain words' }, SID, NO_LINE_WORDS)
    expect(shown).toEqual({ id: 'q', status: 'pending', message: 'plain words', words: 'plain words', stage: 'waiting', delivered: false })
  })

  it('an edit made from the card (words only) keeps the pictures and files it carried', async () => {
    const text = withImagePaths(withFilePaths('first words', ['/data/up/doc.pdf']), ['/data/images/a.png'])
    const row = await enqueueMessage(SID, text)
    expect(await editMessage(SID, row.id, 'better words')).toBe(true)
    const [stored] = await getQueue(SID)
    expect(stored.message).toBe(withImagePaths(withFilePaths('better words', ['/data/up/doc.pdf']), ['/data/images/a.png']))
    const [shown] = await payload()
    expect(shown.words).toBe('better words')
    expect(shown.images).toHaveLength(1)
    // An editor that sent its own headers keeps its own (it removed a file).
    expect(await editMessage(SID, row.id, withImagePaths('only the picture', ['/data/images/a.png']))).toBe(true)
    expect((await getQueue(SID))[0].message).toBe(withImagePaths('only the picture', ['/data/images/a.png']))
    // An older phone's edit of the whole `message` (headers included) keeps its own headers.
    const [again] = await payload()
    expect(await editMessage(SID, row.id, again.message.replace('only the picture', 'the picture'))).toBe(true)
    expect((await getQueue(SID))[0].message).toBe(withImagePaths('the picture', ['/data/images/a.png']))
  })

  it('a picture with no words under a hint block: an edit adds the words as their own paragraph', async () => {
    const lang = '<system-reminder>\nWalnut (reply-language): Answer in English.\n</system-reminder>'
    const text = composeHinted(withImagePaths('', ['/i/a.png']), { before: [lang], after: [] })
    const row = await enqueueMessage(SID, text)
    expect(await editMessage(SID, row.id, 'caption')).toBe(true)
    const [stored] = await getQueue(SID)
    expect(stored.message).toContain('- /i/a.png\n\ncaption')
    expect(stored.message).not.toContain('a.pngcaption')
    const [shown] = await payload()
    expect(shown.words).toBe('caption')
    expect((shown.images as Array<{ path: string }>).map((i) => i.path)).toEqual(['/i/a.png'])
  })
})

/**
 * Every call site of the queue read in src/, counted per file. A call site that lists
 * rows to a person maps them through queueRowView or queueRowFacts within a few lines;
 * every other one is internal (delivery, recovery, counts). A new call site anywhere
 * changes its file's count and fails until it is classified here.
 */
const INTERNAL_QUEUE_READS: Record<string, number> = {
  'core/session-title-reconciler.ts': 1,
  'core/user-status-sync.ts': 1,
  'core/org/retired-lead.ts': 1,
  'core/sessions/queue-after-turn.ts': 1,
  'core/sessions/session-lifecycle.ts': 4,
  'core/sessions/session-stop.ts': 1,
  'core/sessions/team-stop.ts': 1,
  'core/sessions/auto-recover-env.ts': 3,
  'core/sessions/subtask-notices.ts': 2,
  'core/sessions/session-send-core.ts': 1,
  'core/sessions/undelivered-requests.ts': 2,
  'core/sessions/folder-gone.ts': 3,
  'core/sessions/idle-compaction.ts': 1,
  'core/sessions/request-reached.ts': 1, // takenBackIds: rows the queue took back void their reached stamp
  'providers/claude-code-session.ts': 8, // +1: the retry clock of a delivery that threw (retryAfterDeliveryThrow)
  'providers/acp-stranded-rows.ts': 1, // settles an ACP row left 'processing' with no delivery in flight
  'core/sessions/queued-change.ts': 1, // queueOf: was a refused Edit or Delete's row taken or gone
  'core/sessions/lane-turn.ts': 2, // a joined message: which rows wait, and whether its own row was taken
}
const DISPLAY_QUEUE_READS: Record<string, number> = {
  'core/sessions/session-extras.ts': 1, // GET /api/v1/sessions/:id/queue and the Mac relay
  'web/routes/session-chat.ts': 1, // WS session:get-queue
}

describe('class guard: every surface that lists queue rows to a person says their stage', () => {
  it('each call site of getQueue is classified, and a listing one projects its rows', () => {
    const root = path.resolve(import.meta.dirname, '../../../src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(root)
    const counts: Record<string, number> = {}
    const unprojected: string[] = []
    for (const f of files) {
      const rel = path.relative(root, f)
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\bgetQueue\(/.test(line) || /function getQueue\(|^\s*(?:\/\/|\*)/.test(line) || /\/\/.*getQueue\(/.test(line)) return
        counts[rel] = (counts[rel] ?? 0) + 1
        // A listing site: rows of the queue filtered for a person (withoutWalnutRows).
        if (/withoutWalnutRows\(/.test(line) && !/queueRowView\(|queueRowFacts\(/.test(lines.slice(i, i + 9).join('\n'))) unprojected.push(`${rel}:${i + 1}`)
      })
    }
    const expected: Record<string, number> = { ...INTERNAL_QUEUE_READS }
    for (const [f, n] of Object.entries(DISPLAY_QUEUE_READS)) expected[f] = (expected[f] ?? 0) + n
    expect(counts).toEqual(expected)
    expect(unprojected).toEqual([])
    // The listing sites in the table are listing ones.
    for (const f of Object.keys(DISPLAY_QUEUE_READS)) {
      expect(readFileSync(path.join(root, f), 'utf8'), f).toMatch(/withoutWalnutRows\(await getQueue\(/)
    }
  })
})

describe('the phone and the server name the same stages', () => {
  it('the Swift QueueStage cases equal the server\'s stage list', () => {
    const swift = readFileSync(path.resolve(import.meta.dirname, '../../../ios-native/Walnut/Stores/SessionQueueModel.swift'), 'utf8')
    const body = /enum QueueStage\b[^{]*\{([\s\S]*?)\n\}/.exec(swift)?.[1] ?? ''
    const cases = [...body.matchAll(/^\s*case\s+([a-z][A-Za-z0-9]*)/gm)].map((m) => m[1])
    expect(cases.length).toBeGreaterThan(0)
    expect([...cases].sort()).toEqual([...QUEUE_STAGES].sort())
  })
})
