/**
 * The turn half of "an engine that answers a turn is given the conversation".
 *
 * The mint seed closes the case where a lane is CREATED for a conversation that
 * already has turns. It cannot close this one: a lane can already exist (minted
 * on mount for an empty conversation) and THEN miss content — the Mac sleeps, the
 * cloud replica answers a turn with its own in-process fallback and persists it,
 * the Mac wakes and continues on the SAME lane. Nothing is re-minted, so nothing
 * re-seeds, and the lane denies a turn the user can see on screen.
 *
 * What is pinned here, on the REAL store and the REAL session record:
 *   - a foreign-answered turn is prepended to the next message, exactly ONCE;
 *   - a retry after a failed send still carries it (the mark advances only after
 *     a successful delivery);
 *   - the ordinary turn is byte-identical to what it was before this feature;
 *   - an ACP lane, which has no system-prompt channel, gets its recap here.
 *
 * The lane resolver and the send queue are mocked, so nothing spawns a `claude`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

const getOrCreateLaneSession = vi.hoisted(() => vi.fn())
const sendMessageToSession = vi.hoisted(() => vi.fn(async () => ({ id: 'qm-test' })))

vi.mock('../../src/core/sessions/personal-ai-lane.js', () => ({ getOrCreateLaneSession }))
vi.mock('../../src/core/session-message-queue.js', () => ({
  parkMessages: async () => 0,
  parkStalePending: async () => [],
  unparkMessage: async () => false,
  sendMessageToSession,
}))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME, conversationFile } from '../../src/constants.js'
import { runLaneTurn } from '../../src/core/sessions/lane-turn.js'
import {
  CONVERSATION_SEED_HEADER, CATCH_UP_BANNER_OPEN, CATCH_UP_BANNER_CLOSE,
  laneEngineLabel, recordLaneSeen,
} from '../../src/core/chat-history.js'

const AGENT = 'general'
const CONV = 'conv-catch-up'
const SID = '11111111-2222-3333-4444-555555555555'
const LANE = laneEngineLabel(SID)
const FOREIGN = 'walnut-agent-fallback'

let clock = Date.parse('2026-09-01T00:00:00.000Z')

interface FixtureTurn { user: string; assistant: string; engine?: string }

/** Write the conversation store directly — this file tests delivery, not writes. */
async function writeConversation(turns: FixtureTurn[], laneSeen?: Record<string, string>): Promise<void> {
  const entries: unknown[] = []
  for (const turn of turns) {
    entries.push({ tag: 'ai', role: 'user', content: turn.user, timestamp: new Date(clock += 1000).toISOString() })
    entries.push({
      tag: 'ai', role: 'assistant', content: [{ type: 'text', text: turn.assistant }],
      timestamp: new Date(clock += 1000).toISOString(),
      ...(turn.engine ? { engine: turn.engine } : {}),
    })
  }
  const file = conversationFile(AGENT, CONV)
  await fsp.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  await fsp.writeFile(file, JSON.stringify({
    version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary: null,
    entries, ...(laneSeen ? { laneSeen } : {}),
  }), 'utf-8')
}

/** Seed a lane session record; `seeded` puts the mint seed in its spawn prompt. */
async function writeRecord(opts: { seeded: boolean; acp?: boolean }): Promise<void> {
  const { createSessionRecord } = await import('../../src/core/session-tracker.js')
  await createSessionRecord(SID, '', '', WALNUT_HOME, {
    lane: `chat:${AGENT}:${CONV}`,
    ...(opts.acp
      ? { engine: 'codex' as never }
      : {
        profile: {
          systemPromptMode: 'append' as const,
          systemPrompt: opts.seeded
            ? `You are the Personal AI.\n\n${CONVERSATION_SEED_HEADER}\n\nolder recap`
            : 'You are the Personal AI.',
        },
      }),
  })
}

/** Run one turn to completion on the (reused) lane and return what was delivered. */
async function deliverTurn(message: string): Promise<string> {
  getOrCreateLaneSession.mockResolvedValue({ sessionId: SID, created: false, engine: 'claude' })
  const before = sendMessageToSession.mock.calls.length
  const turn = runLaneTurn(AGENT, CONV, message, { source: 'api-v1', timeoutMs: 5_000 })
  for (let i = 0; i < 200 && sendMessageToSession.mock.calls.length === before; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'ok' } as never, ['main-ai'], { source: 'test' })
  await turn
  const call = sendMessageToSession.mock.calls.at(-1) as unknown as [string, string, unknown] | undefined
  return call?.[1] ?? ''
}

beforeEach(async () => {
  bus.clear()
  clock = Date.parse('2026-09-01T00:00:00.000Z')
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../src/core/session-db.js'),
    import('../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()
  getOrCreateLaneSession.mockReset()
  sendMessageToSession.mockReset()
  sendMessageToSession.mockResolvedValue({ id: 'qm-test' } as never)
})

afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {})
})

// ══════════════════════════════════════════════════════════════════
//  The seam that opens AFTER the mint
// ══════════════════════════════════════════════════════════════════

describe('a turn another engine answered while this lane was unreachable', () => {
  it('rides the next message as a marked context block, and only once', async () => {
    await writeRecord({ seeded: true })
    await writeConversation(
      [
        { user: 'mine', assistant: 'answered by this lane', engine: LANE },
        { user: 'WHILE-THE-MAC-SLEPT', assistant: 'THE-REPLICA-ANSWERED-THIS', engine: FOREIGN },
      ],
      // Caught up through the lane's own turn (entry #2).
      { [LANE]: new Date(Date.parse('2026-09-01T00:00:00.000Z') + 2000).toISOString() },
    )

    const first = await deliverTurn('so what about that?')
    expect(first).toContain(CATCH_UP_BANNER_OPEN)
    expect(first).toContain(CATCH_UP_BANNER_CLOSE)
    expect(first).toContain('WHILE-THE-MAC-SLEPT')
    expect(first).toContain('THE-REPLICA-ANSWERED-THIS')
    // Its own turn is already in its transcript — never re-fed.
    expect(first).not.toContain('answered by this lane')
    // The user's real message is last, after the block closes.
    expect(first.endsWith('so what about that?')).toBe(true)
    expect(first.indexOf(CATCH_UP_BANNER_CLOSE)).toBeLessThan(first.indexOf('so what about that?'))

    // IDEMPOTENT: the mark advanced on the successful send, so the retry / next
    // turn carries nothing extra.
    const second = await deliverTurn('and now this?')
    expect(second).toBe('and now this?')
  })

  it('re-injects when the SEND failed — the mark advances only after delivery', async () => {
    await writeRecord({ seeded: true })
    await writeConversation(
      [{ user: 'unseen q', assistant: 'UNSEEN-ANSWER', engine: FOREIGN }],
      { [LANE]: '' },
    )

    sendMessageToSession.mockRejectedValueOnce(new Error('queue write failed') as never)
    getOrCreateLaneSession.mockResolvedValue({ sessionId: SID, created: false, engine: 'claude' })
    const failed = await runLaneTurn(AGENT, CONV, 'retry me', { source: 'api-v1', timeoutMs: 2_000 })
    expect(failed.resultText).toBeNull()
    expect((sendMessageToSession.mock.calls.at(-1) as unknown as [string, string])[1])
      .toContain('UNSEEN-ANSWER')

    const retried = await deliverTurn('retry me')
    expect(retried).toContain('UNSEEN-ANSWER')
  })

  it('after a LOST mark, carries only what came after the mint — not the whole history', async () => {
    // The mark lives in a whole-file last-writer-wins synced document, so it can
    // vanish. Trigger A then had no floor and treated every foreign answer ever as
    // unseen: a 40-turn conversation re-injected into a lane that already holds it.
    // This pins the WIRING — that the lane's own record supplies the floor.
    await writeRecord({ seeded: true })
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const mintedAt = Date.parse((await getSessionByClaudeId(SID))!.startedAt)
    const at = (deltaMs: number): string => new Date(mintedAt + deltaMs).toISOString()
    const file = conversationFile(AGENT, CONV)
    await fsp.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    await fsp.writeFile(file, JSON.stringify({
      version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary: null,
      entries: [
        { tag: 'ai', role: 'user', content: 'BEFORE-THE-MINT', timestamp: at(-20_000) },
        { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'answered before' }], engine: FOREIGN, timestamp: at(-19_000) },
        { tag: 'ai', role: 'user', content: 'AFTER-THE-MINT', timestamp: at(10_000) },
        { tag: 'ai', role: 'assistant', content: [{ type: 'text', text: 'answered after' }], engine: FOREIGN, timestamp: at(11_000) },
      ],
    }), 'utf-8')

    const delivered = await deliverTurn('carry on')
    expect(delivered).toContain('AFTER-THE-MINT')
    expect(delivered).not.toContain('BEFORE-THE-MINT')
  })

  it('sends nothing but still advances the mark when the foreign turn renders to nothing', async () => {
    // A foreign turn made only of tool traffic survives selection (it HAS a foreign
    // answer) and then renders empty (the block filter drops tool_use/tool_result).
    // With the mark left behind it, that same turn was re-selected, re-rendered and
    // re-discarded on every single send for the life of the lane.
    await writeRecord({ seeded: true })
    const file = conversationFile(AGENT, CONV)
    await fsp.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    await fsp.writeFile(file, JSON.stringify({
      version: 2, lastUpdated: new Date().toISOString(), compactionCount: 0, compactionSummary: null,
      laneSeen: { [LANE]: '2026-09-01T00:00:00.000Z' },
      entries: [
        { tag: 'ai', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: {} }], engine: FOREIGN, timestamp: '2026-09-02T00:00:00.000Z' },
        { tag: 'ai', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' }], timestamp: '2026-09-02T00:00:01.000Z' },
      ],
    }), 'utf-8')

    // The message is untouched — there is nothing to say…
    expect(await deliverTurn('just my message')).toBe('just my message')
    // …but the mark moved past the turn, so the next send does no work either.
    const store = JSON.parse(await fsp.readFile(file, 'utf-8'))
    expect(store.laneSeen[LANE]).toBe('2026-09-02T00:00:00.000Z')
    expect(await deliverTurn('and another')).toBe('and another')
  })
})

// ══════════════════════════════════════════════════════════════════
//  The ordinary turn — the overwhelming majority
// ══════════════════════════════════════════════════════════════════

describe('the ordinary turn', () => {
  it('delivers the user message BYTE-IDENTICALLY when every answer is this lane\'s', async () => {
    await writeRecord({ seeded: true })
    await writeConversation(
      [
        { user: 'q1', assistant: 'a1', engine: LANE },
        { user: 'q2', assistant: 'a2', engine: LANE },
      ],
      { [LANE]: '' },
    )
    const message = 'plain message, nothing prepended'
    expect(await deliverTurn(message)).toBe(message)
    // And no write: the store still holds the mark it started with.
    const store = JSON.parse(await fsp.readFile(conversationFile(AGENT, CONV), 'utf-8'))
    expect(store.laneSeen).toEqual({ [LANE]: '' })
  })

  it('delivers byte-identically for unstamped legacy entries too', async () => {
    // Nothing can be PROVEN foreign, and a lane that was seeded at mint already
    // holds them — the rule has to degrade to a no-op, not guess.
    await writeRecord({ seeded: true })
    await writeConversation([{ user: 'legacy q', assistant: 'legacy a' }], { [LANE]: '' })
    expect(await deliverTurn('hello')).toBe('hello')
  })

  it('a lane that stamps every answer it gives (the cloud companion) reads an unstamped one as foreign', async () => {
    // Same store as the test above. Default off (primary lanes, pinned above);
    // with the flag, the unstamped answer after the mark is carried.
    await writeConversation([{ user: 'web chat q', assistant: 'web chat a' }], { [LANE]: '' })
    const { buildLaneCatchUp } = await import('../../src/core/chat-history.js')
    const base = { agentId: AGENT, conversationId: CONV, laneLabel: LANE, seededAtMint: () => true }
    expect(await buildLaneCatchUp(base)).toBeNull()
    const caught = await buildLaneCatchUp({ ...base, unstampedIsForeign: true })
    expect(caught?.text).toContain('web chat q')
    expect(caught?.text).toContain('web chat a')
    // Its own stamped answers stay its own, flag or not.
    await writeConversation([{ user: 'own q', assistant: 'own a', engine: LANE }], { [LANE]: '' })
    expect(await buildLaneCatchUp({ ...base, unstampedIsForeign: true })).toBeNull()
  })

  it('never touches a freshly created lane (the spawn profile carried the seed)', async () => {
    await writeRecord({ seeded: true })
    await writeConversation([{ user: 'q', assistant: 'a', engine: FOREIGN }])
    getOrCreateLaneSession.mockResolvedValue({ sessionId: SID, created: true, engine: 'claude' })
    const turn = runLaneTurn(AGENT, CONV, 'first', { source: 'api-v1', timeoutMs: 2_000 })
    await new Promise((r) => setTimeout(r, 30))
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'ok' } as never, ['main-ai'], { source: 'test' })
    await turn
    expect(sendMessageToSession).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════
//  ACP lanes — this is their ONLY channel
// ══════════════════════════════════════════════════════════════════

describe('an ACP lane', () => {
  it('gets the whole prior conversation on its first send, then never again', async () => {
    // handleAcpStart takes no profile, so an ACP lane cannot be seeded at mint.
    // No mark and no seeded prompt is exactly the "never been given this
    // conversation" signal, and MESSAGES are the only channel left.
    await writeRecord({ seeded: false, acp: true })
    await writeConversation([
      { user: 'ACP-EARLIER-Q', assistant: 'ACP-EARLIER-A' },
      { user: 'ACP-LATER-Q', assistant: 'ACP-LATER-A', engine: FOREIGN },
    ])

    const first = await deliverTurn('carry on')
    expect(first).toContain('ACP-EARLIER-A')
    expect(first).toContain('ACP-LATER-A')
    expect(first.endsWith('carry on')).toBe(true)

    expect(await deliverTurn('again')).toBe('again')
  })

  it('a claude lane minted BEFORE the seed existed is healed the same way', async () => {
    // Same signal, same one-shot repair: the population this whole change exists
    // for is lanes whose CLI never saw the conversation it is answering in.
    await writeRecord({ seeded: false })
    await writeConversation([{ user: 'PRE-FEATURE-Q', assistant: 'PRE-FEATURE-A' }])
    const first = await deliverTurn('next')
    expect(first).toContain('PRE-FEATURE-A')
    expect(await deliverTurn('next again')).toBe('next again')
  })
})

// ══════════════════════════════════════════════════════════════════
//  Failure posture
// ══════════════════════════════════════════════════════════════════

describe('failure posture', () => {
  it('a conversation whose store is corrupt still delivers the message', async () => {
    await writeRecord({ seeded: false })
    const file = conversationFile(AGENT, CONV)
    await fsp.mkdir(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    await fsp.writeFile(file, '{ not json at all', 'utf-8')
    expect(await deliverTurn('still send me')).toBe('still send me')
  })

  it('records the mark even when the caller was a background producer', async () => {
    await writeRecord({ seeded: false })
    await writeConversation([{ user: 'q', assistant: 'BACKGROUND-SEES-THIS' }])
    getOrCreateLaneSession.mockResolvedValue({ sessionId: SID, created: false, engine: 'claude' })
    const turn = runLaneTurn(AGENT, CONV, 'cron prompt', { source: 'cron', timeoutMs: 5_000 })
    for (let i = 0; i < 200 && sendMessageToSession.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'ok' } as never, ['main-ai'], { source: 'test' })
    await turn
    const store = JSON.parse(await fsp.readFile(conversationFile(AGENT, CONV), 'utf-8'))
    expect(store.laneSeen[LANE]).toBeTruthy()
    // Re-recording the same mark is a no-op rather than a throw or a rewrite: the
    // relay and the lane can both report the same delivery.
    await recordLaneSeen(AGENT, CONV, LANE, store.laneSeen[LANE])
    const after = JSON.parse(await fsp.readFile(conversationFile(AGENT, CONV), 'utf-8'))
    expect(after.laneSeen[LANE]).toBe(store.laneSeen[LANE])
  })
})
