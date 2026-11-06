/**
 * "Prompt is too long" recovery, the pure parts and the state machine with fake deps
 * (src/core/sessions/context-full.ts, context-full-recovery.ts). The real path through the server
 * is tests/e2e/context-full-recovery-e2e.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { hardStopTokens, isContextFullText, needsContextRecovery } from '../../../src/core/sessions/context-full.js'
import { isContextFullText as webIsContextFullText, needsContextRecovery as webNeedsContextRecovery } from '../../../web/src/utils/context-full.js'
import {
  attemptsLeft, ContextFullRecovery, MAX_ATTEMPTS_PER_HOUR, resendNoteText, compactedAtOrAfter, RESTART_CHECK_MS, type ContextFullRecoveryDeps,
} from '../../../src/core/sessions/context-full-recovery.js'
import { resetQuietTurnsForTest, quietTurnKind, isQuietTurn, noteQuietTurnDelivery, noteTurnStart, noteSessionSend, addQuietTurnEndListener } from '../../../src/core/sessions/quiet-turn.js'
import { EventNames } from '../../../src/core/event-bus.js'
import { CONTEXT_COMPACT_COMMAND as CONTEXT_COMPACT_TEXT } from '../../../src/core/sessions/walnut-commands.js'
import type { SessionRecord } from '../../../src/core/types.js'

// Every way a full context is worded to Walnut: Claude Code's own refusal at its blocking limit
// (auto-compact off), the API's 400 and Bedrock's. A new wording joins this list and must be seen.
const FULL_CONTEXT_TEXTS = [
  'Prompt is too long',
  'prompt is too long: 213456 tokens > 200000 maximum',
  'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 201000 tokens > 200000 maximum"}}',
  'Input is too long for requested model.',
  // Auto-compact on, and its own summary request failed (2026-11-05, a session on GPT-6.1 Sol via a proxy).
  'Prompt is too long · automatic compaction failed: no assistant message in summarization response',
]
const OTHER_TEXTS = [
  '',
  'Connection lost to remote host',
  'API Error: 529 overloaded',
  'Claude AI usage limit reached',
  // A model's long reply that only mentions the phrase is not the error.
  `Here is what I found. ${'The log said "Prompt is too long" once. '.repeat(30)}`,
]

describe('isContextFullText', () => {
  it('knows every wording of a full context, on the server and in the browser alike', () => {
    for (const t of FULL_CONTEXT_TEXTS) {
      expect(isContextFullText(t), t).toBe(true)
      expect(webIsContextFullText(t), t).toBe(true)
    }
    for (const t of OTHER_TEXTS) {
      expect(isContextFullText(t), t).toBe(false)
      expect(webIsContextFullText(t), t).toBe(false)
    }
  })
})

describe('needsContextRecovery', () => {
  it('offers Compact and resend for a full context, and for a recovery that failed on another error', () => {
    const cases: Array<[Parameters<typeof needsContextRecovery>[0], boolean]> = [
      [{ process_status: 'error', errorMessage: 'Prompt is too long' }, true],
      // The compaction met a 529: that is the error now, and only a compaction still helps.
      [{ process_status: 'error', errorMessage: 'API Error: 529 overloaded', contextRecovery: { state: 'failed' } }, true],
      [{ process_status: 'error', errorMessage: 'API Error: 529 overloaded', contextRecovery: { state: 'done' } }, false],
      [{ process_status: 'error', errorMessage: 'Connection lost' }, false],
      [{ process_status: 'idle', errorMessage: 'Prompt is too long' }, false],
      // A restart or a Stop left the failed recovery on a stopped session: Retry still compacts.
      [{ process_status: 'stopped', contextRecovery: { state: 'failed' } }, true],
      [{ process_status: 'stopped', errorMessage: 'Prompt is too long' }, false],
      // An ACP engine, a chat lane: Walnut does not compact them, so no Compact and resend.
      [{ process_status: 'error', errorMessage: 'Prompt is too long', engine: 'codex' }, false],
      [{ process_status: 'error', errorMessage: 'Prompt is too long', lane: 'chat' }, false],
      [{ process_status: 'error', errorMessage: 'Prompt is too long', engine: 'claude' }, true],
      [null, false],
    ]
    for (const [rec, want] of cases) {
      expect(needsContextRecovery(rec), JSON.stringify(rec)).toBe(want)
      expect(webNeedsContextRecovery(rec), JSON.stringify(rec)).toBe(want)
    }
  })
})

describe('the hard stop with auto-compact off', () => {
  it('is where Claude Code refuses: the window less 20K for the summary and 3K', () => {
    // The 2026-11-05 session: 176K of 200K, refused; 89% on the badge was in truth past the stop.
    expect(hardStopTokens(200_000)).toBe(177_000)
    expect(hardStopTokens(1_000_000)).toBe(977_000)
    // An output cap below 20K shrinks the reserve, as the CLI's min(max output, 20K) does.
    expect(hardStopTokens(200_000, 8_192)).toBe(188_808)
    expect(hardStopTokens(200_000, 64_000)).toBe(177_000)
    expect(Math.round(176_400 / hardStopTokens(200_000) * 100)).toBe(100)
  })

})

describe('resendNoteText', () => {
  it('hands back every message word for word, oldest first, and says who sent it', () => {
    const t = resendNoteText([
      { text: '<walnut-message kind="trigger">the wait ran out</walnut-message>', sentBy: 'agent', at: '2026-11-05T16:38:35Z' },
      { text: 'hi', sentBy: 'person', at: '2026-11-05T16:40:00Z' },
    ], '2026-11-05T16:38:35Z')
    expect(t).toContain('Prompt is too long')
    expect(t).toContain('Message 1 of 2, from Walnut or another task')
    expect(t).toContain('Message 2 of 2, from the user')
    expect(t.indexOf('the wait ran out')).toBeLessThan(t.indexOf('\nhi'))
  })

  it('marks a message it had to cut, and says so instead of claiming the exact words', () => {
    const t = resendNoteText([{ text: 'x'.repeat(50_000), sentBy: 'person', at: 't' }], undefined)
    expect(t).toMatch(/10000 more characters of this message are left out/)
    expect(t).toContain('the longest cut where marked')
    expect(t).not.toContain('exactly as they reached you')
  })

  it('with nothing kept, sends the session to its summary for them', () => {
    expect(resendNoteText([], '2026-11-05T16:38:35Z')).toMatch(/from 2026-11-05T16:38:35Z.*in the summary above/s)
  })
})

describe('ContextFullRecovery', () => {
  const SID = 'sess-full'
  let rec: SessionRecord
  let sends: Array<{ text: string; source: string; messageId?: string }>
  let notes: string[]
  let cards: string[]
  let failSend: boolean
  let nowMs: number
  let fence: string | null
  let taskOpen: boolean
  /** Runs once inside the next getSession: a person acting while the recovery reads the record. */
  let onRead: (() => void) | null
  /** Holds the next resend's send until released. */
  let holdResend: Promise<void> | null
  /** Runs inside the next send, before the queue asks stillWanted. */
  let beforeSend: ((source: string) => void) | null
  let taken: string[]
  /** What the host's transcript shows about a compaction a restart caught (null: unreadable). */
  let hostCompacted: boolean | null
  let recovery: ContextFullRecovery

  const ev = (name: string, data: Record<string, unknown>) => recovery.handleEvent({ name, data, source: 'test' } as never)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  /** The queue reports a message and its delivery under a turn generation. */
  const deliver = (id: string, text: string, gen: number, sentBy: 'person' | 'agent' = 'person') => {
    ev(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: SID, messageId: id, message: text, source: sentBy === 'person' ? 'ui' : 'peer', sentBy, enqueuedAt: new Date(nowMs).toISOString() })
    ev(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, messageIds: [id], turnGen: gen })
  }
  const settle = async () => { for (let i = 0; i < 8; i++) await flush() }
  const overflow = async (gen: number) => { ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: true, result: 'Prompt is too long', turnGen: gen }); await settle() }
  /** The /compact goes out alone and its turn ends: clean, or with an error. */
  const compactEnds = async (gen: number, error?: string) => {
    const row = sends.at(-1)!.messageId!
    noteQuietTurnDelivery(SID, [row])
    noteTurnStart(SID, gen)
    ev(EventNames.SESSION_RESULT, error ? { sessionId: SID, isError: true, result: error, turnGen: gen } : { sessionId: SID, isError: false, result: '', turnGen: gen })
    await settle()
  }

  beforeEach(() => {
    resetQuietTurnsForTest()
    nowMs = Date.parse('2026-11-05T16:40:00Z')
    rec = { claudeSessionId: SID, taskId: 't1', process_status: 'error', errorMessage: 'Prompt is too long' } as SessionRecord
    sends = []
    notes = []
    cards = []
    failSend = false
    fence = 'f1'
    taskOpen = true
    onRead = null
    holdResend = null
    beforeSend = null
    taken = []
    hostCompacted = null
    const deps: Partial<ContextFullRecoveryDeps> = {
      compactedSince: async () => hostCompacted,
      now: () => nowMs,
      getSession: async () => { const hook = onRead; onRead = null; hook?.(); return rec },
      saveSession: async (_id, updates) => { rec = { ...rec, ...updates } },
      send: async (_id, text, opts) => {
        // The queue's own check (session-message-queue.ts enqueueMessage): a Stop after the fence refuses.
        if (opts.stopFence !== undefined && opts.stopFence !== fence) throw Object.assign(new Error('superseded'), { code: 'SESSION_STOP_SUPERSEDED' })
        if (failSend && opts.source === 'context-recovery') throw new Error('queue refused')
        if (holdResend && opts.source === 'context-recovery') { const h = holdResend; holdResend = null; await h }
        const hook = beforeSend; beforeSend = null; hook?.(opts.source)
        // The queue's own check right before the row is stored (SendNoLongerWantedError).
        if (opts.stillWanted && !opts.stillWanted()) throw Object.assign(new Error('send no longer wanted'), { name: 'SendNoLongerWantedError' })
        sends.push({ text, source: opts.source, messageId: opts.messageId })
      },
      stopFence: async () => fence,
      taskOpen: async () => taskOpen,
      deleteQueued: async (_id, messageId) => { taken.push(messageId); return true },
      emitNote: (_s, _t, message) => { notes.push(message) },
      announce: vi.fn(),
      announceState: vi.fn(),
      gaveUp: async (_rec, words) => { cards.push(words) },
    }
    recovery = new ContextFullRecovery(deps)
  })

  it('compacts quietly, then resends exactly the messages the failed turns got', async () => {
    deliver('qm-1', 'an older answered message', 1)
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: 'ok', turnGen: 1 })
    deliver('qm-2', 'the wait ran out', 2, 'agent')
    await overflow(2)
    expect(sends).toEqual([expect.objectContaining({ text: CONTEXT_COMPACT_TEXT, source: 'context-compact' })])
    expect(quietTurnKind(SID)).toBe('context-compact')
    expect(rec.contextRecovery).toMatchObject({ state: 'compacting', attempts: ['2026-11-05T16:40:00.000Z'] })

    await compactEnds(3)
    expect(sends).toHaveLength(2)
    expect(sends[1].source).toBe('context-recovery')
    expect(sends[1].text).toContain('the wait ran out')
    expect(sends[1].text).not.toContain('an older answered message')
    expect(rec.contextRecovery).toMatchObject({ state: 'done', resent: 1 })
  })

  it('a person writing before the /compact went out: no compaction ran, so the attempt is handed back and their message starts the next', async () => {
    const off = addQuietTurnEndListener(recovery.onQuietEnd)
    try {
      deliver('qm-1', 'hi', 2)
      await overflow(2)
      // The queue drops the /compact (markProcessing): the person's message goes out alone.
      noteSessionSend(SID, 'ui')
      await settle()
      expect(quietTurnKind(SID)).toBeUndefined()
      expect(recovery.isRunning(SID)).toBe(false)
      expect(rec.contextRecovery).toMatchObject({ state: 'failed', attempts: [] })
      expect(cards).toEqual([])
      // That message gets "Prompt is too long" too: now the compaction runs, for both.
      deliver('qm-2', 'are you there?', 3)
      await overflow(3)
      expect(sends.filter((x) => x.text === CONTEXT_COMPACT_TEXT)).toHaveLength(2)
      expect(rec.contextRecovery).toMatchObject({ state: 'compacting', attempts: ['2026-11-05T16:40:00.000Z'] })
      await compactEnds(4)
      expect(sends.at(-1)!.text).toContain('hi')
      expect(sends.at(-1)!.text).toContain('are you there?')
      expect(rec.contextRecovery?.state).toBe('done')
    } finally { off() }
  })

  it('a Stop while it decides: nothing is sent to the session', async () => {
    deliver('qm-1', 'hi', 2)
    onRead = () => { fence = 'f2' }
    await overflow(2)
    expect(sends).toEqual([])
    expect(recovery.isRunning(SID)).toBe(false)
  })

  it('a Stop or a completed task while it compacts: the compaction stands, nothing is resent', async () => {
    for (const act of [() => { fence = 'f2' }, () => { taskOpen = false }]) {
      fence = 'f1'; taskOpen = true; sends = []; rec = { ...rec, contextRecovery: undefined }
      deliver('qm-1', 'hi', 2)
      await overflow(2)
      expect(sends).toHaveLength(1)
      act()
      await compactEnds(3)
      expect(sends).toHaveLength(1)
      expect(rec.contextRecovery?.state).toBe('failed')
      expect(cards).toEqual([])
    }
  })

  it('a clean turn drops only what the model took: a message written during it waits for the next turn', async () => {
    deliver('qm-1', 'answered in this turn', 1)
    ev(EventNames.SESSION_USER_LINE, { sessionId: SID, uuid: 'u1', rowIds: ['qm-1'] })
    deliver('qm-2', 'written mid-turn, not taken yet', 1)
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: 'ok', turnGen: 1 })
    // A turn someone stopped answered nothing.
    deliver('qm-3', 'sent before a stop', 2)
    ev(EventNames.SESSION_USER_LINE, { sessionId: SID, uuid: 'u3', rowIds: ['qm-3'] })
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, interrupted: true, result: '', turnGen: 2 })
    await overflow(3)
    await compactEnds(4)
    const note = sends.at(-1)!.text
    expect(note).toContain('written mid-turn, not taken yet')
    expect(note).toContain('sent before a stop')
    expect(note).not.toContain('answered in this turn')
  })

  it('resends a person\'s message as it reached the session, image references included', async () => {
    ev(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: SID, messageId: 'qm-img', message: 'what is in this?', rowText: 'what is in this?\n\n[Image: /tmp/walnut-images/a.png]', source: 'ui', sentBy: 'person' })
    ev(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, messageIds: ['qm-img'] })
    await overflow(2)
    await compactEnds(3)
    expect(sends.at(-1)!.text).toContain('[Image: /tmp/walnut-images/a.png]')
  })

  it('an overflow while the resend goes out: the next run starts after this one wrote its state, never under it', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    let release!: () => void
    holdResend = new Promise((r) => { release = r })
    await compactEnds(3)
    // The resend is on its way; its turn already overflows (the compaction freed too little).
    nowMs += 1_000
    await overflow(4)
    expect(sends.filter((x) => x.text === CONTEXT_COMPACT_TEXT)).toHaveLength(1)
    release()
    await settle()
    // Round one wrote done, then round two started: its compacting state and both attempts stand.
    expect(sends.filter((x) => x.text === CONTEXT_COMPACT_TEXT)).toHaveLength(2)
    expect(rec.contextRecovery?.state).toBe('compacting')
    expect(rec.contextRecovery!.attempts).toHaveLength(2)
    await compactEnds(5)
    expect(rec.contextRecovery?.state).toBe('done')
    expect(sends.filter((x) => x.source === 'context-recovery').at(-1)!.text).toContain('hi')
  })

  it('a Stop pressed in the panel (no fence moves) while it decides or before the resend: nothing goes out', async () => {
    deliver('qm-1', 'hi', 2)
    onRead = () => ev(EventNames.SESSION_INTERRUPT, { sessionId: SID })
    await overflow(2)
    expect(sends).toEqual([])
    expect(recovery.isRunning(SID)).toBe(false)
    // Past the compaction: the Stop lands while it reads the record before resending.
    await overflow(3)
    expect(sends).toHaveLength(1)
    onRead = () => ev(EventNames.SESSION_INTERRUPT, { sessionId: SID })
    await compactEnds(4)
    expect(sends).toHaveLength(1)
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: 'The session was stopped.' })
    expect(cards).toEqual([])
  })

  it('a stop still waiting for its host never leaves the session held: a later click compacts', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    let pending = true
    const realFence = fence
    ;(recovery as unknown as { deps: ContextFullRecoveryDeps }).deps.stopFence = async () => {
      if (pending) throw Object.assign(new Error('Session stop is awaiting host confirmation'), { code: 'SESSION_STOP_SUPERSEDED' })
      return realFence
    }
    await compactEnds(3)
    expect(recovery.isRunning(SID)).toBe(false)
    expect(sends).toHaveLength(1)
    pending = false
    expect(await recovery.recoverNow(SID)).toBe(true)
    expect(sends.filter((x) => x.text === CONTEXT_COMPACT_TEXT)).toHaveLength(2)
  })

  it('an overflow that lands while a cut-short run is still letting go starts the next run', async () => {
    const off = addQuietTurnEndListener(recovery.onQuietEnd)
    try {
      deliver('qm-1', 'hi', 2)
      await overflow(2)
      noteSessionSend(SID, 'ui')
      // No wait: the newer message's "Prompt is too long" comes while the abandon still writes.
      deliver('qm-2', 'still there?', 3)
      ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: true, result: 'Prompt is too long', turnGen: 3 })
      await settle()
      expect(sends.filter((x) => x.text === CONTEXT_COMPACT_TEXT)).toHaveLength(2)
      await compactEnds(4)
      expect(sends.at(-1)!.text).toContain('still there?')
    } finally { off() }
  })

  it('a person\'s own /compact answers nothing: the words still owed go out after it, and /clear keeps them', async () => {
    deliver('qm-1', 'the exact ask', 2)
    await overflow(2)
    await compactEnds(3, 'API Error: 529 overloaded')
    expect(rec.contextRecovery?.state).toBe('failed')
    // /clear: a command the CLI runs itself, no model reply; nothing is dropped or sent.
    deliver('qm-c', '/clear', 4)
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: '', turnGen: 4 })
    await settle()
    expect(sends).toHaveLength(1)
    expect(rec.contextRecovery?.state).toBe('failed')
    deliver('qm-k', '/compact', 5)
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: '', turnGen: 5 })
    await settle()
    expect(sends).toHaveLength(2)
    expect(sends[1]).toMatchObject({ source: 'context-recovery' })
    expect(sends[1].text).toContain('the exact ask')
    expect(rec.contextRecovery?.state).toBe('done')
  })

  it('a send the queue refuses after a Stop ends the run once, with no card', async () => {
    const off = addQuietTurnEndListener(recovery.onQuietEnd)
    try {
      deliver('qm-1', 'hi', 2)
      // The Stop lands between the last check and the /compact's send.
      let reads = 0
      ;(recovery as unknown as { deps: ContextFullRecoveryDeps }).deps.stopFence = async () => (++reads >= 3 ? 'f2' : 'f1')
      fence = 'f2'
      await overflow(2)
      expect(sends).toEqual([])
      expect(cards).toEqual([])
      expect(notes.filter((n) => /could not recover/.test(n))).toHaveLength(1)
      expect(recovery.isRunning(SID)).toBe(false)
    } finally { off() }
  })

  it('a person\'s click on a completed task\'s session compacts nothing', async () => {
    taskOpen = false
    expect(await recovery.recoverNow(SID)).toBe(false)
    expect(sends).toEqual([])
  })

  it('a queued message edited before it went out is resent with its new words', async () => {
    ev(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: SID, messageId: 'qm-e', message: 'deploy to staging', source: 'ui', sentBy: 'person' })
    recovery.noteEdited(SID, 'qm-e', 'do not deploy, just build')
    ev(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, messageIds: ['qm-e'] })
    await overflow(2)
    await compactEnds(3)
    expect(sends.at(-1)!.text).toContain('do not deploy, just build')
    expect(sends.at(-1)!.text).not.toContain('deploy to staging')
  })

  it('a Stop between the last check and the resend\'s enqueue: nothing goes out; after the enqueue, the row is taken back', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    beforeSend = (source) => { if (source === 'context-recovery') ev(EventNames.SESSION_INTERRUPT, { sessionId: SID }) }
    await compactEnds(3)
    expect(sends).toHaveLength(1)
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: 'The session was stopped.' })
    expect(cards).toEqual([])
    // Next time the resend is queued, then the person presses Stop: Walnut takes its row back.
    expect(await recovery.recoverNow(SID)).toBe(true)
    await compactEnds(5)
    const row = sends.at(-1)!
    expect(row.source).toBe('context-recovery')
    ev(EventNames.SESSION_INTERRUPT, { sessionId: SID })
    await settle()
    expect(taken.at(-1)).toBe(row.messageId)
  })

  it('a compaction a restart caught, which then finished in its host, still tells the session to answer', async () => {
    rec = { ...rec, process_status: 'running', contextRecovery: { state: 'compacting', at: '2026-11-05T16:00:00Z', attempts: ['2026-11-05T16:00:00Z'], failedSince: '2026-11-05T15:59:00Z' } }
    hostCompacted = false // still running there
    await recovery.rebuild(async () => [rec])
    await settle()
    expect(rec.contextRecovery?.state).toBe('compacting')
    expect(recovery.holds(SID)).toBe(true)
    expect(cards).toEqual([])
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: '', turnGen: 7 })
    await settle()
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ source: 'context-recovery' })
    expect(sends[0].text).toMatch(/from 2026-11-05T15:59:00Z.*in the summary above/s)
    expect(rec.contextRecovery?.state).toBe('done')
  })

  it('a clean turn that did not take the resend keeps the words owed, and sends them now that there is room', async () => {
    deliver('qm-1', 'the exact ask', 2)
    await overflow(2)
    failSend = true
    await compactEnds(3)
    expect(rec.contextRecovery?.state).toBe('failed')
    failSend = false
    // The person writes "ping" and gets an answer: the owed ask is not answered by it.
    deliver('qm-p', 'ping', 4)
    ev(EventNames.SESSION_USER_LINE, { sessionId: SID, uuid: 'u-p', rowIds: ['qm-p'] })
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: 'pong', turnGen: 4 })
    await settle()
    expect(sends.at(-1)!.source).toBe('context-recovery')
    expect(sends.at(-1)!.text).toContain('the exact ask')
    expect(sends.at(-1)!.text).not.toContain('ping')
    expect(rec.contextRecovery?.state).toBe('done')
    // Once a turn took that resend, the words are settled: no second resend.
    ev(EventNames.SESSION_USER_LINE, { sessionId: SID, uuid: 'u-r', rowIds: [sends.at(-1)!.messageId] })
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: 'answered', turnGen: 5 })
    deliver('qm-q', 'next', 6)
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: 'ok', turnGen: 6 })
    await settle()
    expect(sends.filter((x) => x.source === 'context-recovery')).toHaveLength(1)
  })

  it('a message the CLI cancelled at a Stop is never resent', async () => {
    deliver('qm-a', 'keep this', 2)
    deliver('qm-b', 'withdrawn at the stop', 2)
    ev(EventNames.SESSION_QUEUED_CANCELLED, { sessionId: SID, messageIds: ['qm-b'], messages: ['withdrawn at the stop'] })
    await overflow(3)
    await compactEnds(4)
    expect(sends.at(-1)!.text).toContain('keep this')
    expect(sends.at(-1)!.text).not.toContain('withdrawn at the stop')
  })

  it('a resend whose answering turn failed is still owed: a later clean turn does not settle it', async () => {
    deliver('qm-1', 'the exact ask', 2)
    await overflow(2)
    await compactEnds(3)
    const resend = sends.at(-1)!
    ev(EventNames.SESSION_USER_LINE, { sessionId: SID, uuid: 'u-r', rowIds: [resend.messageId] })
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: true, result: 'API Error: 529 overloaded', turnGen: 4 })
    deliver('qm-p', 'ping', 5)
    ev(EventNames.SESSION_USER_LINE, { sessionId: SID, uuid: 'u-p', rowIds: ['qm-p'] })
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: 'pong', turnGen: 5 })
    await settle()
    // Still owed: the next overflow resends it.
    deliver('qm-n', 'next', 6)
    await overflow(6)
    await compactEnds(7)
    expect(sends.at(-1)!.text).toContain('the exact ask')
  })

  it('a server stop ends the work in flight: nothing is resent after it', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    onRead = () => recovery.stop()
    const row = sends.at(-1)!.messageId!
    noteQuietTurnDelivery(SID, [row])
    noteTurnStart(SID, 3)
    // The result reaches the handler before the stop; the stop lands while it reads the record.
    recovery.handleEvent({ name: EventNames.SESSION_RESULT, data: { sessionId: SID, isError: false, result: '', turnGen: 3 }, source: 'test' } as never)
    await settle()
    expect(sends).toHaveLength(1)
  })

  it('a click while a run is letting go is not swallowed: it compacts once the run released the session', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    let release!: () => void
    holdResend = new Promise((r) => { release = r })
    await compactEnds(3)
    expect(await recovery.recoverNow(SID)).toBe(true)
    expect(sends.filter((x) => x.text === CONTEXT_COMPACT_TEXT)).toHaveLength(1)
    release()
    await settle()
    expect(sends.filter((x) => x.text === CONTEXT_COMPACT_TEXT)).toHaveLength(2)
    expect(rec.contextRecovery?.state).toBe('compacting')
  })

  it('a compaction that stopped being quiet still has a deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const off = addQuietTurnEndListener(recovery.onQuietEnd)
    try {
      const tick = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1) }
      deliver('qm-1', 'hi', 2)
      ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: true, result: 'Prompt is too long', turnGen: 2 })
      await tick()
      noteQuietTurnDelivery(SID, [sends.at(-1)!.messageId!])
      noteSessionSend(SID, 'ui')
      await tick()
      expect(recovery.isRunning(SID)).toBe(true)
      await vi.advanceTimersByTimeAsync(31 * 60_000)
      await tick()
      expect(recovery.isRunning(SID)).toBe(false)
      expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: 'The compaction did not finish.' })
      expect(await recovery.recoverNow(SID)).toBe(true)
      expect(sends.filter((x) => x.text === CONTEXT_COMPACT_TEXT)).toHaveLength(2)
    } finally { off(); vi.useRealTimers() }
  })

  it('a failed recovery settles once the session answers a turn of its own', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    await compactEnds(3, 'API Error: 529 overloaded')
    expect(rec.contextRecovery?.state).toBe('failed')
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: 'ok', turnGen: 9 })
    await settle()
    // The session has room again: the owed message goes out, and the failure is settled.
    expect(sends.at(-1)!.text).toContain('hi')
    expect(rec.contextRecovery?.state).toBe('done')
    expect(rec.contextRecovery?.reason).toBeUndefined()
  })

  it('a message sent while it compacts is not another compaction', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    deliver('qm-2', 'are you there', 3)
    await overflow(3)
    expect(sends.filter((s) => s.text === CONTEXT_COMPACT_TEXT)).toHaveLength(1)
  })

  it(`starts at most ${MAX_ATTEMPTS_PER_HOUR} by itself in an hour, then waits for a person, whose click is not capped`, async () => {
    for (let i = 0; i < MAX_ATTEMPTS_PER_HOUR; i++) {
      deliver(`qm-${i}`, `ask ${i}`, 10 + i * 2)
      await overflow(10 + i * 2)
      await compactEnds(11 + i * 2)
      nowMs += 60_000
    }
    deliver('qm-x', 'ask again', 30)
    await overflow(30)
    expect(sends.filter((s) => s.text === CONTEXT_COMPACT_TEXT)).toHaveLength(MAX_ATTEMPTS_PER_HOUR)
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: expect.stringMatching(/did not free enough room/) })
    // Only the recovery that gave up raises the session's error card.
    expect(cards).toHaveLength(1)

    expect(await recovery.recoverNow(SID)).toBe(true)
    expect(sends.filter((s) => s.text === CONTEXT_COMPACT_TEXT)).toHaveLength(MAX_ATTEMPTS_PER_HOUR + 1)
    await compactEnds(31)
    expect(sends.at(-1)!.text).toContain('ask again')
    // An hour on, it compacts by itself again.
    expect(attemptsLeft(rec.contextRecovery, nowMs + 61 * 60_000).left).toBe(MAX_ATTEMPTS_PER_HOUR)
  })

  it('a compaction that fails leaves the session for a person, with the reason', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    await compactEnds(3, 'Prompt is too long')
    expect(sends).toHaveLength(1)
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: 'The compaction itself did not fit the context window.' })
    expect(notes.at(-1)).toMatch(/could not recover/)
  })

  it('two overflows at once start one compaction and count one attempt', async () => {
    deliver('qm-1', 'hi', 2)
    await Promise.all([recovery.onOverflow(SID), recovery.onOverflow(SID)])
    expect(sends.filter((s) => s.text === CONTEXT_COMPACT_TEXT)).toHaveLength(1)
    expect(rec.contextRecovery!.attempts).toHaveLength(1)
  })

  it('a compaction a person stopped resends nothing, raises no card, and waits for the button', async () => {
    deliver('qm-1', 'hi', 2)
    await overflow(2)
    const row = sends.at(-1)!.messageId!
    noteQuietTurnDelivery(SID, [row])
    noteTurnStart(SID, 3)
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, interrupted: true, compactionStopped: true, result: '', turnGen: 3 })
    await settle()
    expect(sends).toHaveLength(1)
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: 'The compaction was stopped.' })
    expect(cards).toEqual([])
  })

  it('a send cutting in after the /compact went out: its own turn end decides, a failure is not called done', async () => {
    const off = addQuietTurnEndListener(recovery.onQuietEnd)
    try {
      deliver('qm-1', 'hi', 2)
      await overflow(2)
      noteQuietTurnDelivery(SID, [sends.at(-1)!.messageId!])
      noteSessionSend(SID, 'ui')
      await flush()
      expect(sends).toHaveLength(1)
      ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: true, result: 'API Error: 529 overloaded', turnGen: 4 })
      await settle()
      expect(sends).toHaveLength(1)
      expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: expect.stringMatching(/529/) })
    } finally { off() }
  })

  it('a resend that could not be sent keeps the words for the next try', async () => {
    deliver('qm-1', 'the exact ask', 2)
    await overflow(2)
    failSend = true
    await compactEnds(3)
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: expect.stringMatching(/resending the messages failed/) })
    failSend = false
    expect(await recovery.recoverNow(SID)).toBe(true)
    await compactEnds(5)
    expect(sends.at(-1)!.text).toContain('the exact ask')
  })

  it('a resend that overflows again still carries the words the second time', async () => {
    deliver('qm-1', 'the exact ask', 2)
    await overflow(2)
    await compactEnds(3)
    ev(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: SID, messageId: 'qm-note', message: sends.at(-1)!.text, source: 'context-recovery' })
    ev(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, messageIds: ['qm-note'] })
    await overflow(4)
    await compactEnds(5)
    const notesSent = sends.filter((s) => s.source === 'context-recovery')
    expect(notesSent).toHaveLength(2)
    expect(notesSent[1].text).toContain('the exact ask')
    expect(notesSent[1].text.match(/--- Message/g)).toHaveLength(1)
  })

  it('leaves ACP engines, lanes and archived sessions alone, and their error cards stay', async () => {
    for (const patch of [{ engine: 'codex' }, { lane: 'chat' }, { archived: true }] as Array<Partial<SessionRecord>>) {
      rec = { ...rec, engine: undefined, lane: undefined, archived: undefined, ...patch } as SessionRecord
      await overflow(2)
      expect(recovery.takes('Prompt is too long', rec)).toBe(false)
    }
    expect(sends).toEqual([])
    expect(recovery.takes('Prompt is too long', { claudeSessionId: SID } as SessionRecord)).toBe(true)
    expect(recovery.takes('API Error: 529 overloaded', { claudeSessionId: SID } as SessionRecord)).toBe(false)
  })

  it('a restart that cut a compaction off, with no compaction in its host, marks it failed, so the banner offers it again', async () => {
    rec = { ...rec, process_status: 'idle', contextRecovery: { state: 'compacting', at: '2026-11-05T16:00:00Z', attempts: ['2026-11-05T16:00:00Z'] } }
    hostCompacted = false
    expect(await recovery.rebuild(async () => [rec])).toBe(1)
    await settle()
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: expect.stringMatching(/restart.*no compaction since/) })
    expect(recovery.holds(SID)).toBe(false)
    expect(cards).toHaveLength(1)
  })

  // 2026-11-06 (f081a055): Walnut restarted while the session compacted; the compaction finished in
  // its host meanwhile, the old rule failed it at boot, the task was handed back, its asker read
  // "Prompt is too long" as the answer, and nothing was resent for six hours.
  it('a restart mid-compaction: the host shows it finished, so the words the record kept go out, with no card', async () => {
    deliver('qm-1', 'please reply to rq-1 with the result', 2, 'agent')
    await overflow(2)
    expect(rec.contextRecovery?.owed).toEqual([expect.objectContaining({ id: 'qm-1', text: 'please reply to rq-1 with the result', sentBy: 'agent' })])
    // The server restarts: a fresh recovery knows only the record.
    const saved = rec
    recovery.stop()
    recovery = new ContextFullRecovery({ ...(recovery as unknown as { deps: ContextFullRecoveryDeps }).deps })
    rec = { ...saved, process_status: 'idle' }
    sends = []
    hostCompacted = true
    expect(await recovery.rebuild(async () => [rec])).toBe(1)
    await settle()
    expect(sends).toHaveLength(1)
    expect(sends[0].source).toBe('context-recovery')
    expect(sends[0].text).toContain('please reply to rq-1 with the result')
    expect(rec.contextRecovery?.state).toBe('done')
    expect(rec.contextRecovery?.owed).toBeUndefined()
    expect(cards).toEqual([])
  })

  it('a restart mid-compaction with its host unreadable keeps looking, and fails only past the deadline', async () => {
    rec = { ...rec, process_status: 'idle', contextRecovery: { state: 'compacting', at: '2026-11-05T16:00:00Z', attempts: ['2026-11-05T16:00:00Z'] } }
    hostCompacted = null
    await recovery.rebuild(async () => [rec])
    await settle()
    expect(rec.contextRecovery?.state).toBe('compacting')
    expect(recovery.holds(SID)).toBe(true)
    recovery.stop()
    recovery = new ContextFullRecovery({ ...(recovery as unknown as { deps: ContextFullRecoveryDeps }).deps })
    onRead = () => { nowMs += RESTART_CHECK_MS + 1 }
    await recovery.rebuild(async () => [rec])
    await settle()
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: expect.stringMatching(/could not be read/) })
  })

  it('a record that failed keeps the owed words, so a click after a restart resends them', async () => {
    rec = { ...rec, process_status: 'idle', contextRecovery: { state: 'failed', at: '2026-11-05T16:00:00Z', attempts: [], reason: 'x',
      owed: [{ id: 'qm-9', text: 'the ask a restart forgot', at: '2026-11-05T15:58:00Z', sentBy: 'person' }] } }
    await recovery.rebuild(async () => [rec])
    expect(await recovery.recoverNow(SID)).toBe(true)
    await compactEnds(9)
    expect(sends.at(-1)!.text).toContain('the ask a restart forgot')
  })

  // 2026-11-06 review of the restart check: each of these sent words that should never go out again.
  it('a Stop while Walnut looks for a compaction a restart caught ends the hold, and nothing is resent', async () => {
    rec = { ...rec, process_status: 'idle', contextRecovery: { state: 'compacting', at: '2026-11-05T16:00:00Z', attempts: [],
      owed: [{ id: 'qm-1', text: 'the ask', at: '2026-11-05T15:58:00Z', sentBy: 'person' }] } }
    hostCompacted = null
    await recovery.rebuild(async () => [rec])
    await settle()
    expect(recovery.holds(SID)).toBe(true)
    ev(EventNames.SESSION_INTERRUPT, { sessionId: SID })
    await settle()
    expect(recovery.holds(SID)).toBe(false)
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: 'The compaction was stopped.' })
    expect(cards).toEqual([])
    // The host comes back showing the compaction: still nothing goes out by itself.
    hostCompacted = true
    await (recovery as unknown as { checkRestarted: (s: string, d: number) => Promise<void> }).checkRestarted(SID, nowMs + RESTART_CHECK_MS)
    await settle()
    expect(sends).toEqual([])
  })

  it('a stop of the team while the hold lasts (the fence moved) refuses the resend when the compaction turns up', async () => {
    rec = { ...rec, process_status: 'idle', contextRecovery: { state: 'compacting', at: '2026-11-05T16:00:00Z', attempts: [],
      owed: [{ id: 'qm-1', text: 'the ask', at: '2026-11-05T15:58:00Z', sentBy: 'agent' }] } }
    hostCompacted = null
    await recovery.rebuild(async () => [rec])
    await settle()
    fence = 'f2'
    hostCompacted = true
    await (recovery as unknown as { checkRestarted: (s: string, d: number) => Promise<void> }).checkRestarted(SID, nowMs + RESTART_CHECK_MS)
    await settle()
    expect(sends).toEqual([])
    expect(rec.contextRecovery).toMatchObject({ state: 'failed', reason: 'The session was stopped.' })
    expect(cards).toEqual([])
  })

  it('a compaction found in its host while the turn still runs waits for that turn to end, and its end is quiet', async () => {
    rec = { ...rec, process_status: 'running', contextRecovery: { state: 'compacting', at: '2026-11-05T16:00:00Z', attempts: [] } }
    hostCompacted = true // the boundary is written; the summary and result are not yet
    await recovery.rebuild(async () => [rec])
    await settle()
    expect(sends).toEqual([])
    expect(recovery.holds(SID)).toBe(true)
    // The compaction's turn, begun before the restart, reads as quiet to every reader of its result.
    expect(isQuietTurn(SID, 12)).toBe(true)
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: '', turnGen: 12 })
    await settle()
    expect(sends).toHaveLength(1)
    expect(sends[0].source).toBe('context-recovery')
    // Its readers that run late still read that result as quiet, after the resend went out.
    expect(isQuietTurn(SID, 12)).toBe(true)
  })

  it('a compaction a restart caught that overflowed itself compacts again', async () => {
    rec = { ...rec, process_status: 'running', contextRecovery: { state: 'compacting', at: '2026-11-05T16:00:00Z', attempts: [] } }
    hostCompacted = false
    await recovery.rebuild(async () => [rec])
    await settle()
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: true, result: 'Prompt is too long', turnGen: 12 })
    await settle()
    expect(sends.at(-1)).toMatchObject({ source: 'context-compact' })
  })

  it('words answered once are never resent by a later failure', async () => {
    rec = { ...rec, process_status: 'idle', contextRecovery: { state: 'failed', at: '2026-11-05T16:00:00Z', attempts: [], reason: 'x',
      owed: [{ id: 'qm-9', text: 'the old ask', at: '2026-11-05T15:58:00Z', sentBy: 'person' }] } }
    await recovery.rebuild(async () => [rec])
    // The person takes it back (or it was answered), and the session works again.
    ev(EventNames.SESSION_QUEUED_CANCELLED, { sessionId: SID, messageIds: ['qm-9'] })
    ev(EventNames.SESSION_RESULT, { sessionId: SID, isError: false, result: 'ok', turnGen: 3 })
    await settle()
    expect(rec.contextRecovery?.state).toBe('done')
    expect(rec.contextRecovery?.owed).toBeUndefined()
    // A fresh recovery after a restart, failing with nothing of its own, carries none of them.
    recovery.stop()
    recovery = new ContextFullRecovery({ ...(recovery as unknown as { deps: ContextFullRecoveryDeps }).deps })
    rec = { ...rec, contextRecovery: { ...rec.contextRecovery!, state: 'compacting' } }
    hostCompacted = false
    await recovery.rebuild(async () => [rec])
    await settle()
    expect(rec.contextRecovery?.state).toBe('failed')
    expect(rec.contextRecovery?.owed).toBeUndefined()
  })

  it('tells a compaction after the overflow by order, whatever the host clock says', () => {
    const ptl = { role: 'assistant', text: 'Prompt is too long', timestamp: '2026-11-05T15:50:00Z' }
    const done = { role: 'system', systemVariant: 'compact', text: 'Context compacted', timestamp: '2026-11-05T15:52:00Z' }
    // The host runs 20 minutes behind the server's 16:10.
    expect(compactedAtOrAfter([ptl, done], '2026-11-05T16:10:00Z')).toBe(true)
    // An old compaction before the overflow, stamped "now" for want of a time, is not this one.
    expect(compactedAtOrAfter([{ ...done, timestamp: '2026-11-05T16:30:00Z' }, ptl], '2026-11-05T16:10:00Z')).toBe(false)
  })

  it('reads a finished compaction in a history only at or after the time asked', () => {
    const rows = [
      { role: 'system', systemVariant: 'compact', text: 'Context compacted', timestamp: '2026-11-05T15:00:00Z' },
      { role: 'system', systemVariant: 'compact', text: 'Compaction failed', timestamp: '2026-11-05T16:30:00Z' },
    ]
    expect(compactedAtOrAfter(rows, '2026-11-05T16:00:00Z')).toBe(false)
    expect(compactedAtOrAfter([...rows, { role: 'system', systemVariant: 'compact', text: 'Context compacted', timestamp: '2026-11-05T16:01:00Z' }], '2026-11-05T16:00:00Z')).toBe(true)
  })
})
