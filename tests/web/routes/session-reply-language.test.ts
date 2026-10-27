/**
 * Reply language (`config.session.reply_language`): one `[Reply language: …]`
 * line rides every message Walnut delivers into a session, after the user's
 * words and after the rich output text, in either output mode. Unset or empty
 * adds nothing, so the message stays byte-identical.
 *
 * Why it exists: long sessions and compactions drifted into the wrong language,
 * and the rule lived only in a private CLAUDE.md that a compacted or non-Claude
 * session loses. The per-message tail is what a session rereads every turn.
 *
 * Would-fail-if-reverted: drop `language` from resolveOutputModeDirective or from
 * applyOutputModeDirective and every "on" assertion breaks; drop the marker from
 * either stripper and the history and client assertions break.
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
  replyLanguageLine, resolveOutputModeDirective, applyOutputModeDirective, stripOutputModeWrappers,
} from '../../../src/core/sessions/output-mode.js'
import { parseSessionMessages } from '../../../src/core/session-history.js'
import { stripOutputModeWrappers as stripOutputModeWrappersClient } from '../../../web/src/hooks/useSessionSend'

const TEXT = 'why did the deploy guard refuse?'
const RULE = 'Talk to the user in Chinese; code, commits, UI strings and repo docs stay English.'
const LINE = `${REPLY_LANGUAGE_MARKER}${RULE}]`
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

describe('replyLanguageLine', () => {
  it('unset, empty or blank adds no line', () => {
    for (const cfg of [undefined, null, {}, { session: {} }, { session: { reply_language: '' } }, { session: { reply_language: '  \n ' } }]) {
      expect(replyLanguageLine(cfg)).toBeNull()
    }
  })

  it('one line, whitespace collapsed, ending in the bracket the strippers key on', () => {
    expect(replyLanguageLine({ session: { reply_language: RULE } })).toBe(LINE)
    expect(replyLanguageLine({ session: { reply_language: '  Answer in French.\n\nCode stays English. ' } }))
      .toBe('[Reply language: Answer in French. Code stays English.]')
  })

  it('a pasted essay is cut to the one-sentence budget', () => {
    const line = replyLanguageLine({ session: { reply_language: 'x'.repeat(REPLY_LANGUAGE_MAX_CHARS * 3) } })!
    expect(line.length).toBeLessThanOrEqual(REPLY_LANGUAGE_MARKER.length + REPLY_LANGUAGE_MAX_CHARS + 2)
    expect(line.endsWith('…]')).toBe(true)
  })
})

describe('the directive carries it in both modes', () => {
  const md = { session: { output_mode: 'markdown' as SessionOutputMode, reply_language: RULE } }
  const rich = { session: { output_mode: 'rich' as SessionOutputMode, reply_language: RULE } }

  it('markdown: the language line alone', () => {
    const d = resolveOutputModeDirective({}, md)
    expect(d).toEqual({ mode: 'markdown', instruction: null, reminder: null, language: LINE })
    expect(applyOutputModeDirective(d, TEXT)).toBe(`${TEXT}\n\n${LINE}`)
  })

  it('rich: after the edge instruction, and after the standing reminder', () => {
    expect(applyOutputModeDirective(resolveOutputModeDirective({}, rich), TEXT))
      .toBe(`${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${LINE}`)
    expect(applyOutputModeDirective(resolveOutputModeDirective({ output_mode_injected: 'rich' }, rich), TEXT))
      .toBe(`${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}\n\n${LINE}`)
  })
})

describe('session:send', () => {
  it('on: every send carries the line; off: the text is byte-identical', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(`${TEXT}\n\n${LINE}`)
    await callSend({ sessionId: sid, message: 'again' })
    expect(await drain(sid)).toBe(`again\n\n${LINE}`)

    // The config is read live: clearing it stops the line on the very next send.
    await setSession({ output_mode: 'markdown' })
    const res = await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(TEXT)
    expect(res.dedupText).toBeUndefined()
  })

  it('rich: the line rides after the instruction, then after each reminder', async () => {
    await setSession({ output_mode: 'rich', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: 'one' })
    expect(await drain(sid)).toBe(`one\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${LINE}`)
    await callSend({ sessionId: sid, message: 'two' })
    expect(await drain(sid)).toBe(`two\n\n${RICH_OUTPUT_MODE_REMINDER}\n\n${LINE}`)
  })

  it('a slash command stays byte-exact', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: '/compact' })
    expect(await drain(sid)).toBe('/compact')
  })

  it('dedupText is what history shows: the line is gone', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    const res = await callSend({ sessionId: sid, message: TEXT })
    expect(res.dedupText ?? TEXT).toBe(TEXT)
  })
})

describe('turns nobody typed', () => {
  it('a trigger, a peer and a Walnut notice carry it in markdown mode too', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    for (const source of ['routine-trigger', 'peer', 'walnut-notify', 'wait-until']) {
      await sendMessageToSession(sid, `from ${source}`, { source })
      expect(await drain(sid)).toBe(`from ${source}\n\n${LINE}`)
    }
  })

  it('a rich session gets reminder then line; a source the queue does not wrap gets nothing', async () => {
    await setSession({ output_mode: 'rich', reply_language: RULE })
    const sid = await newSession()
    await updateSessionRecord(sid, { output_mode_injected: 'rich' })
    await sendMessageToSession(sid, 'peer says hi', { source: 'peer' })
    expect(await drain(sid)).toBe(`peer says hi\n\n${RICH_OUTPUT_MODE_REMINDER}\n\n${LINE}`)
    // Human paths wrap before they enqueue; the queue leaves their text alone.
    await sendMessageToSession(sid, 'plan step', { source: 'web-api' })
    expect(await drain(sid)).toBe('plan step')
  })

  it('off: automated turns are untouched', async () => {
    await setSession({ output_mode: 'markdown' })
    const sid = await newSession()
    await sendMessageToSession(sid, 'trigger fired', { source: 'routine-trigger' })
    expect(await drain(sid)).toBe('trigger fired')
  })
})

describe('display strips the line', () => {
  const userLine = (content: string, i: number) => JSON.stringify({
    type: 'user', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), uuid: `u-${i}`,
    message: { role: 'user', content },
  })

  it('history never shows it, alone, after the reminder, or in a merged batch', () => {
    const jsonl = [
      userLine(`${TEXT}\n\n${LINE}`, 1),
      userLine(`${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}\n\n${LINE}`, 2),
      userLine(`first\n\n${LINE}\nsecond\n\n${LINE}`, 3),
    ].join('\n')
    const texts = parseSessionMessages(jsonl).filter((m) => m.role === 'user').map((m) => m.text)
    expect(texts).toEqual([TEXT, TEXT, 'first\nsecond'])
  })

  it('a sentence that mentions the marker, or a message that is only the line, is kept', () => {
    const mention = `what does ${LINE} do?`
    expect(stripOutputModeWrappers(mention)).toBe(mention)
    expect(stripOutputModeWrappers(LINE)).toBe(LINE)
  })

  it('client and server strip identically', () => {
    const cases = [
      TEXT,
      `${TEXT}\n\n${LINE}`,
      `${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${LINE}`,
      `${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}\n\n${LINE}`,
      `first\n${LINE}\nsecond\n${LINE}`,
      `is ${LINE} still true?`,
      `${TEXT}\n\n[Reply language: unterminated`,
    ]
    for (const c of cases) {
      expect(stripOutputModeWrappersClient(c), c.slice(0, 40)).toBe(stripOutputModeWrappers(c))
    }
  })
})
