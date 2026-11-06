/**
 * Reply language (`config.session.reply_language`): since 2026-11-06 a line of every
 * session's SYSTEM PROMPT (src/core/sessions/reply-language-context.ts, placed by
 * composePrompt in session-context.ts), never a message hint (2026-11-06, the user:
 * "just remove reply language"; it rode messages as the `reply-language` hint, on
 * every message for a while, with a correction line of Walnut's own). A change reaches
 * a running session as a changed default instruction (instruction-notice.ts). Unset or
 * empty says nothing about language, so a fresh install's prompt has no such line.
 *
 * What this file pins: the prompt line (and its absence), and that no message a person,
 * another task or Walnut sends carries a reply-language block, in either output mode,
 * after a change, a compaction or a drift mark an older Walnut left. Old history rows
 * still hold the block, so both display paths still strip it.
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
import { buildSessionContext, defaultInstructions } from '../../../src/core/sessions/session-context.js'
import { _resetReplyLanguageForTesting, replyLanguageLine } from '../../../src/core/sessions/reply-language-context.js'
import { parseSessionMessages } from '../../../src/core/session-history.js'
import { notePlaceCompaction } from '../../../src/core/sessions/place-notice.js'
import { getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { frameForSource } from '../../../src/core/sessions/send-frame.js'
import { stripOutputModeWrappers as stripOutputModeWrappersClient } from '../../../web/src/hooks/useSessionSend'

const TEXT = 'why did the deploy guard refuse?'
const RULE = 'Talk to the user in Chinese; code, commits, UI strings and repo docs stay English.'
// The block old history rows hold (the hint as it was sent before 2026-11-06).
const LANG = renderHintBlock('reply-language', `${RULE} This covers every line the user reads, the short progress lines between your tool calls included.`)
// The system prompt line that replaced it.
// A versioned block (instruction-diff.ts), so a running session hears a change, a restore and a clear.
const PROMPT_HEAD = "Reply language, the user's setting ("
const PROMPT_LINE = replyLanguageLine(RULE).trim()
const ON = renderHintBlock('rich-output', RICH_OUTPUT_MODE_ON_INSTRUCTION)
const REMIND = renderHintBlock('rich-output', RICH_OUTPUT_MODE_REMINDER)
/** The pre-registry line old transcripts still hold. */
const LEGACY_LINE = `${REPLY_LANGUAGE_MARKER}${RULE}]`
const after = (text: string, ...blocks: string[]) => composeHinted(text, { before: [], after: blocks })
// What a send of `source` puts into the session before any hint: a line no person typed is framed
// as Walnut's (sessions/send-frame.ts), and the hints ride after that frame, never inside it.
const sent = (text: string, source: string) => frameForSource(text, source)
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
  _resetReplyLanguageForTesting()
  bus.clear()
  methods.clear()
  registerSessionChatRpc()
})

afterEach(async () => {
  bus.clear()
  _resetReplyLanguageForTesting()
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

describe('the system prompt carries it', () => {
  it('the block is the setting in its words, with what it covers, tagged with its version', () => {
    const v = /\((v[0-9a-f]{8})\)/.exec(PROMPT_LINE)![1]
    expect(PROMPT_LINE).toBe(`${PROMPT_HEAD}${v}): it covers every line the user reads, the short progress lines between tool calls included. Each line of this version starts with [${v}]:\n[${v}] ${RULE}`)
    expect(replyLanguageLine('Answer in French.')).not.toContain(v)
    expect(replyLanguageLine(null)).toBe('')
    expect(replyLanguageLine('')).toBe('')
  })

  it('every session\'s prompt holds the line just before the team charter; empty setting, no line', async () => {
    await setSession({ reply_language: RULE })
    const { systemPrompt } = await buildSessionContext('')
    expect(systemPrompt).toContain(PROMPT_LINE)
    // The sync builder reads the same copy, for a worker, a lead and Main alike.
    for (const task of [{ project: 'Walnut' }, { org_role: 'lead' as const, project: 'Walnut' }, { org_role: 'main' as const, project: 'Main' }]) {
      expect(defaultInstructions(task)).toContain(PROMPT_LINE)
    }
    await setSession({ reply_language: '' })
    const cleared = (await buildSessionContext('')).systemPrompt
    expect(cleared).not.toContain(PROMPT_HEAD)
    expect(defaultInstructions({ project: 'Walnut' })).not.toContain(PROMPT_HEAD)
  })

  it('the setting is said in its new words after a change, whitespace collapsed', async () => {
    await setSession({ reply_language: '  Answer in French.\n\nCode stays English. ' })
    expect((await buildSessionContext('')).systemPrompt).toContain('] Answer in French. Code stays English.\n')
  })
})

describe('no message carries a reply-language block', () => {
  const noBlock = (text: string) => expect(text).not.toContain('Walnut (reply-language)')

  it('a person\'s messages, in markdown: the text is byte-identical, the first one included', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    const res = await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(TEXT)
    expect(res.dedupText ?? TEXT).toBe(TEXT)
    for (let n = 0; n < 3; n++) {
      await callSend({ sessionId: sid, message: `again ${n}` })
      expect(await drain(sid)).toBe(`again ${n}`)
    }
  })

  it('a change of the setting, a compaction and a drift mark an older Walnut left add nothing', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: 'one' })
    await drain(sid)
    await setSession({ output_mode: 'markdown', reply_language: 'Answer in French.' })
    await callSend({ sessionId: sid, message: 'two' })
    expect(await drain(sid)).toBe('two')
    await notePlaceCompaction(sid, 'boundary-1')
    await callSend({ sessionId: sid, message: 'three' })
    expect(await drain(sid)).toBe('three')
    const rec = await getSessionByClaudeId(sid)
    await updateSessionRecord(sid, { hintState: { ...rec!.hintState!, drift: { 'reply-language': new Date(Date.now() + 1000).toISOString() } } })
    await callSend({ sessionId: sid, message: 'four' })
    expect(await drain(sid)).toBe('four')
  })

  it('rich: only the rich instruction rides the first message', async () => {
    await setSession({ output_mode: 'rich', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: 'one' })
    expect(await drain(sid)).toBe(after('one', ON))
    await callSend({ sessionId: sid, message: 'two' })
    expect(await drain(sid)).toBe('two')
  })

  it('a trigger, another task, a notice and the clock: nothing of the language', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    for (const source of ['routine-trigger', 'peer', 'walnut-notify', 'wait-until', 'peer']) {
      await sendMessageToSession(sid, `from ${source}`, { source })
      const text = await drain(sid)
      noBlock(text)
      expect(text, source).toBe(sent(`from ${source}`, source))
    }
  })

  it('a slash command stays byte-exact', async () => {
    await setSession({ output_mode: 'markdown', reply_language: RULE })
    const sid = await newSession()
    await callSend({ sessionId: sid, message: '/compact' })
    expect(await drain(sid)).toBe('/compact')
  })
})

describe('display strips the block old rows hold', () => {
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
