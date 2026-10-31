/**
 * Reply language (`config.session.reply_language`): the `reply-language` message
 * hint (src/core/hints/hint-registry.ts), one `<system-reminder>` block after the
 * user's words and after the rich-output block, in either output mode. It goes out
 * at session start, after a compaction, when the setting changes, and after a
 * reply drifted into another script (`on_drift`, hints/hint-drift.ts); NOT on
 * every message (2026-10-27, the user: the hints showed constantly). Unset or
 * empty adds nothing, so the message stays byte-identical.
 *
 * Why it exists: long sessions and compactions drifted into the wrong language,
 * and the rule lived only in a private CLAUDE.md that a compacted or non-Claude
 * session loses.
 *
 * Would-fail-if-reverted: drop the reply-language hint from the registry and every
 * "on" assertion breaks; drop `on_drift` from its triggers and the drift
 * assertions break; drop the block parse from either display path and the
 * history and client assertions break.
 *
 * Same harness as session-output-mode.test.ts: the RPC handler is captured by
 * stubbing `registerMethod`; no WS server, port, or `claude` process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-reply-language') }
})

const { methods, registerMethod, broadcastEvent } = vi.hoisted(() => {
  const methods = new Map<string, (payload: unknown, client: unknown) => Promise<unknown>>()
  return {
    methods,
    registerMethod: vi.fn((name: string, handler: (p: unknown, c: unknown) => Promise<unknown>) => {
      methods.set(name, handler)
    }),
    broadcastEvent: vi.fn(),
  }
})
vi.mock('../../../src/web/ws/handler.js', () => ({
  registerMethod, broadcastEvent, sendToClient: vi.fn(), sendStreamEvent: vi.fn(),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus } from '../../../src/core/event-bus.js'
import { registerSessionChatRpc } from '../../../src/web/routes/session-chat.js'
import { markProcessing, resetCache, sendMessageToSession } from '../../../src/core/session-message-queue.js'
import {
  createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import type { SessionOutputMode } from '../../../src/core/types.js'
import {
  RICH_OUTPUT_MODE_ON_INSTRUCTION, RICH_OUTPUT_MODE_REMINDER, REPLY_LANGUAGE_MARKER, REPLY_LANGUAGE_MAX_CHARS,
  replyLanguageText,
} from '../../../src/core/sessions/output-mode.js'
import { composeHinted, parseHinted, renderHintBlock } from '../../../src/core/hints/hint-format.js'
import { REPLY_LANGUAGE_SCOPE, replyLanguageCorrection } from '../../../src/core/hints/hint-registry.js'
import { parseSessionMessages } from '../../../src/core/session-history.js'
import { notePlaceCompaction } from '../../../src/core/sessions/place-notice.js'
import { getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { stripOutputModeWrappers as stripOutputModeWrappersClient } from '../../../web/src/hooks/useSessionSend'

const TEXT = 'why did the deploy guard refuse?'
const RULE = 'Talk to the user in Chinese; code, commits, UI strings and repo docs stay English.'
// The hint is the user's sentence, then Walnut's own clause on what it covers.
const LANG = renderHintBlock('reply-language', `${RULE} ${REPLY_LANGUAGE_SCOPE}`)
const ON = renderHintBlock('rich-output', RICH_OUTPUT_MODE_ON_INSTRUCTION)
const REMIND = renderHintBlock('rich-output', RICH_OUTPUT_MODE_REMINDER)
/** The pre-registry line old transcripts still hold. */
const LEGACY_LINE = `${REPLY_LANGUAGE_MARKER}${RULE}]`
const after = (text: string, ...blocks: string[]) => composeHinted(text, { before: [], after: blocks })
const shown = (text: string) => parseHinted(text).text
const fakeClient = {} as never

let seq = 0
async function newSession(): Promise<string> {
  seq += 1
  const sid = `bbbbbbbb-cccc-dddd-eeee-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, `task-reply-language-${seq}`, '', '/tmp/reply-language-repo')
  return sid
}

async function setSession(session: { output_mode?: SessionOutputMode; reply_language?: string }): Promise<void> {
  await updateConfig({ session })
}

async function callSend(payload: Record<string, unknown>): Promise<{ dedupText?: string }> {
  const handler = methods.get('session:send')
  if (!handler) throw new Error('session:send was never registered')
  return (await handler(payload, fakeClient)) as { dedupText?: string }
}

/** The text the CLI would receive, drained the way processNext does. */
async function drain(sid: string): Promise<string> {
  const batch = await markProcessing(sid)
  return batch.map((m) => m.message).join('\n\n')
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetSessionTrackerForTesting()
  bus.clear()
  methods.clear()
  registerSessionChatRpc()
})

afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('replyLanguageText', () => {
  it('unset, empty or blank says nothing', () => {
    for (const cfg of [undefined, null, {}, { session: {} }, { session: { reply_language: '' } }, { session: { reply_language: '  \n ' } }]) {
      expect(replyLanguageText(cfg)).toBeNull()
    }
  })

  it('one line, whitespace collapsed', () => {
    expect(replyLanguageText({ session: { reply_language: RULE } })).toBe(RULE)
    expect(replyLanguageText({ session: { reply_language: '  Answer in French.\n\nCode stays English. ' } }))
      .toBe('Answer in French. Code stays English.')
  })

  it('a pasted essay is cut to the one-sentence budget', () => {
    const text = replyLanguageText({ session: { reply_language: 'x'.repeat(REPLY_LANGUAGE_MAX_CHARS * 3) } })!
    expect(text.length).toBeLessThanOrEqual(REPLY_LANGUAGE_MAX_CHARS + 1)
    expect(text.endsWith('…')).toBe(true)
  })
})

describe('session:send', () => {
  it('on: the first send carries it, later sends do not; off: the text is byte-identical', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(after(TEXT, LANG))
    for (let n = 0; n < 6; n++) {
      await callSend({ sessionId: sid, message: `again ${n}` })
      expect(await drain(sid)).toBe(`again ${n}`)
    }

    // The config is read live: clearing it says nothing on the very next send.
    await setSession({ output_mode: 'markdown' })
    const res = await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(TEXT)
    expect(res.dedupText).toBeUndefined()
  })

  it('a changed setting is said again, once', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: 'one' })
    await drain(sid)
    await setSession({ output_mode: 'markdown', reply_language: 'Answer in French.' })
    await callSend({ sessionId: sid, message: 'two' })
    expect(await drain(sid)).toBe(after('two', renderHintBlock('reply-language', `Answer in French. ${REPLY_LANGUAGE_SCOPE}`)))
    await callSend({ sessionId: sid, message: 'three' })
    expect(await drain(sid)).toBe('three')
  })

  it('after a compaction it is said again, once', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: 'one' })
    await drain(sid)
    await notePlaceCompaction(sid, 'boundary-1')
    await callSend({ sessionId: sid, message: 'two' })
    expect(await drain(sid)).toBe(after('two', LANG))
    await callSend({ sessionId: sid, message: 'three' })
    expect(await drain(sid)).toBe('three')
  })

  it('a reply that drifted owes it on the next send', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: 'one' })
    await drain(sid)
    // What the drift hook records (hints/hint-drift.ts) when a reply broke the rule.
    const rec = await getSessionByClaudeId(sid)
    const driftAt = new Date(Date.now() + 1000).toISOString()
    await updateSessionRecord(sid, {
      hintState: { ...rec!.hintState!, drift: { 'reply-language': driftAt } },
    })
    await callSend({ sessionId: sid, message: 'two' })
    // The next message names the drifted turn before the rule (reply-language-correction.test.ts).
    expect(await drain(sid)).toBe(after('two', renderHintBlock('reply-language', `${replyLanguageCorrection(driftAt)} ${RULE} ${REPLY_LANGUAGE_SCOPE}`)))
    expect((await getSessionByClaudeId(sid))?.hintState?.drift).toBeUndefined()
    await callSend({ sessionId: sid, message: 'three' })
    expect(await drain(sid)).toBe('three')
  })

  it('rich: it rides after the instruction; the reminder later comes alone', async () => {
    await setSession({ output_mode: 'rich', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: 'one' })
    expect(await drain(sid)).toBe(after('one', ON, LANG))
    for (const n of [2, 3, 4, 5]) {
      await callSend({ sessionId: sid, message: `msg ${n}` })
      expect(await drain(sid)).toBe(`msg ${n}`)
    }
    await callSend({ sessionId: sid, message: 'msg 6' })
    expect(await drain(sid)).toBe(after('msg 6', REMIND))
  })

  it('a slash command stays byte-exact', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: '/compact' })
    expect(await drain(sid)).toBe('/compact')
  })

  it('dedupText is what history shows: the hint is gone', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    const res = await callSend({ sessionId: sid, message: TEXT })
    expect(res.dedupText ?? TEXT).toBe(TEXT)
  })
})

describe('turns nobody typed', () => {
  it('a trigger carries it in markdown mode too, the first time', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await sendMessageToSession(sid, 'from routine-trigger', { source: 'routine-trigger' })
    expect(await drain(sid)).toBe(after('from routine-trigger', LANG))
    for (const source of ['peer', 'walnut-notify', 'wait-until']) {
      await sendMessageToSession(sid, `from ${source}`, { source })
      expect(await drain(sid)).toBe(`from ${source}`)
    }
  })

  it('a rich session never told gets both; a source the queue does not compose for gets nothing', async () => {
    await setSession({ output_mode: 'rich', reply_language: RULE })
    const sid = await newSession()
    await sendMessageToSession(sid, 'peer says hi', { source: 'peer' })
    expect(await drain(sid)).toBe(after('peer says hi', ON, LANG))
    // Human paths compose before they enqueue; the queue leaves their text alone.
    const fresh = await newSession()
    await sendMessageToSession(fresh, 'plan step', { source: 'web-api' })
    expect(await drain(fresh)).toBe('plan step')
  })

  it('off: automated turns are untouched', async () => {
    await setSession({ output_mode: 'markdown' })
    const sid = await newSession()
    await sendMessageToSession(sid, 'trigger fired', { source: 'routine-trigger' })
    expect(await drain(sid)).toBe('trigger fired')
  })
})

describe('display strips the hint', () => {
  const userLine = (content: string, i: number) => JSON.stringify({
    type: 'user', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), uuid: `u-${i}`,
    message: { role: 'user', content },
  })

  it('history never shows it, alone, after the rich block, or in a merged batch', () => {
    const jsonl = [
      userLine(after(TEXT, LANG), 1),
      userLine(after(TEXT, REMIND, LANG), 2),
      userLine(`${after('first', LANG)}\n${after('second', LANG)}`, 3),
    ].join('\n')
    const texts = parseSessionMessages(jsonl).filter((m) => m.role === 'user').map((m) => m.text)
    expect(texts).toEqual([TEXT, TEXT, 'first\n\nsecond'])
  })

  it('an old row still loses its bracket line (dated before the hint registry)', () => {
    const jsonl = [
      userLine(`${TEXT}\n\n${LEGACY_LINE}`, 1),
      userLine(`first\n\n${LEGACY_LINE}\nsecond\n\n${LEGACY_LINE}`, 2),
    ].join('\n')
    const texts = parseSessionMessages(jsonl).filter((m) => m.role === 'user').map((m) => m.text)
    expect(texts).toEqual([TEXT, 'first\nsecond'])
  })

  it('a sentence that mentions it, or a message that is only the block, is kept', () => {
    const mention = `what does ${LEGACY_LINE} do?`
    expect(shown(mention)).toBe(mention)
    expect(shown(LANG)).toBe(LANG)
  })

  it('client and server strip identically', () => {
    const cases = [
      TEXT,
      after(TEXT, LANG),
      after(TEXT, ON, LANG),
      after(TEXT, REMIND, LANG),
      `${after('first', LANG)}\n${after('second', LANG)}`,
      `is ${LEGACY_LINE} still true?`,
      `${TEXT}\n\n<system-reminder>\nWalnut (reply-language): unterminated`,
    ]
    for (const c of cases) {
      expect(stripOutputModeWrappersClient(c), c.slice(0, 40)).toBe(shown(c))
    }
  })
})
