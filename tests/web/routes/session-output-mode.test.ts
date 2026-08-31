/**
 * Output mode ("markdown" vs rich HTML) as the CLI actually learns it. Two
 * injections, the same shape plan mode uses (src/web/routes/chat.ts):
 *
 *   · EDGE — the full instruction rides the first `session:send` after the
 *     effective mode changed (including "nothing was ever said"), once.
 *   · STANDING — while rich holds, a one-line reminder rides every later send.
 *     Without it the model wrote HTML for the turn that carried the
 *     instruction and drifted back to markdown a turn or two later (the bug this
 *     file grew for). Markdown mode appends nothing at all.
 *
 * Both land AFTER the user's text (user-requested 2026-08-31 — the instruction
 * used to be a prefix, which is also what broke slash commands).
 *
 * The effective mode is `record.output_mode ?? config.session.output_mode ??
 * DEFAULT_SESSION_OUTPUT_MODE`, so a session that never touched the pill follows
 * the config LIVE and flipping the config produces a real edge for it. The edge
 * itself lives on the record (`output_mode_injected`), so a reload or a second
 * device can't inject a second copy — and `output_mode_injected: undefined` must
 * read as "nothing said yet", NOT as markdown, or a default-rich session would
 * silently never hear the instruction.
 *
 * Would-fail-if-reverted: drop the `applyOutputModeDirective` call in
 * session-chat.ts and every instruction/reminder assertion breaks; drop the
 * `output_mode_injected` write and the instruction repeats forever; compare the
 * edge against DEFAULT_SESSION_OUTPUT_MODE instead of the model's native style
 * and the default-rich session gets nothing.
 *
 * The RPC handler is captured by stubbing `registerMethod` (same harness as
 * session-send-retry.test.ts) — no WS server, port, or `claude` process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-output-mode') }
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
import { markProcessing, resetCache } from '../../../src/core/session-message-queue.js'
import {
  createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting,
} from '../../../src/core/session-tracker.js'
import { patchSession } from '../../../src/core/sessions/session-lifecycle.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { DEFAULT_SESSION_OUTPUT_MODE } from '../../../src/core/types.js'
import type { SessionOutputMode } from '../../../src/core/types.js'
import {
  RICH_OUTPUT_MODE_ON_INSTRUCTION, RICH_OUTPUT_MODE_OFF_INSTRUCTION,
  RICH_OUTPUT_MODE_REMINDER, resolveOutputModeDirective, resolveEffectiveOutputMode,
  stripOutputModeWrappers,
} from '../../../src/core/sessions/output-mode.js'
import { parseSessionMessages } from '../../../src/core/session-history.js'
import {
  registerEchoClaims, bindEchoClaims, _resetEchoClaimsForTest,
} from '../../../src/core/echo-claims.js'
import { dedupeOptimisticMessages } from '../../../web/src/components/sessions/optimistic-dedup'
import { stripSendPrefixes, stripOutputModeWrappers as stripOutputModeWrappersClient } from '../../../web/src/hooks/useSessionSend'

const TEXT = 'explain how the daemon adopts an orphaned session'

const fakeClient = {} as never

/** Config stubs for the pure resolver tests. */
const cfgRich = { session: { output_mode: 'rich' as SessionOutputMode } }
const cfgMarkdown = { session: { output_mode: 'markdown' as SessionOutputMode } }

/** Fresh record per test: the session-db handle is a module singleton that
 *  survives the WALNUT_HOME wipe, so a shared id would carry the previous
 *  test's output_mode and make these assertions order-dependent. */
let seq = 0
async function newSession(): Promise<string> {
  seq += 1
  const sid = `aaaaaaaa-bbbb-cccc-dddd-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, `task-output-mode-${seq}`, '', '/tmp/output-mode-repo')
  return sid
}

/** The CONFIG default the send path reads. Written to the mocked WALNUT_HOME, so
 *  the route resolves it exactly the way production does (no config = default). */
async function setConfigOutputMode(mode: SessionOutputMode): Promise<void> {
  await updateConfig({ session: { output_mode: mode } })
}

async function callSend(payload: Record<string, unknown>): Promise<{ messageId?: string; dedupText?: string }> {
  const handler = methods.get('session:send')
  if (!handler) throw new Error('session:send was never registered')
  return (await handler(payload, fakeClient)) as { messageId?: string; dedupText?: string }
}

/** Drain the queue exactly the way processNext does, so assertions look at the
 *  text the CLI would actually receive. */
async function drain(sid: string): Promise<string> {
  const batch = await markProcessing(sid)
  return batch.map((m) => m.message).join('\n\n')
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  _resetEchoClaimsForTest()
  _resetSessionTrackerForTesting()
  bus.clear()
  methods.clear()
  registerSessionChatRpc()
})

afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('resolveEffectiveOutputMode', () => {
  it('is record → config → built-in default, in that order', () => {
    expect(resolveEffectiveOutputMode({ output_mode: 'rich' }, cfgMarkdown)).toBe('rich')
    expect(resolveEffectiveOutputMode({ output_mode: 'markdown' }, cfgRich)).toBe('markdown')
    // No override ⇒ the config wins, which is what makes a config flip move
    // every session that never touched its pill.
    expect(resolveEffectiveOutputMode({}, cfgRich)).toBe('rich')
    expect(resolveEffectiveOutputMode({}, cfgMarkdown)).toBe('markdown')
    // Neither stated ⇒ the shipped default (rich).
    expect(resolveEffectiveOutputMode(null, null)).toBe(DEFAULT_SESSION_OUTPUT_MODE)
    expect(resolveEffectiveOutputMode(undefined)).toBe('rich')
  })
})

describe('resolveOutputModeDirective', () => {
  it('markdown with nothing owed costs exactly nothing', () => {
    for (const record of [null, {}, { output_mode: 'markdown' as SessionOutputMode }]) {
      expect(resolveOutputModeDirective(record, cfgMarkdown)).toEqual({
        mode: 'markdown', instruction: null, reminder: null,
      })
    }
    // An explicit markdown record ignores a rich CONFIG — the human's per-session
    // choice is the point of the pill.
    expect(resolveOutputModeDirective({ output_mode: 'markdown' }, cfgRich)).toEqual({
      mode: 'markdown', instruction: null, reminder: null,
    })
  })

  it('fires the FULL instruction once per direction', () => {
    expect(resolveOutputModeDirective({ output_mode: 'rich' }, cfgMarkdown)).toEqual({
      mode: 'rich', instruction: RICH_OUTPUT_MODE_ON_INSTRUCTION, reminder: null,
    })
    expect(resolveOutputModeDirective({ output_mode: 'markdown', output_mode_injected: 'rich' }, cfgRich)).toEqual({
      mode: 'markdown', instruction: RICH_OUTPUT_MODE_OFF_INSTRUCTION, reminder: null,
    })
  })

  it('a default-rich session with nothing told yet still gets the instruction', () => {
    // THE trap of adding a config default: if `output_mode_injected: undefined`
    // read as the DEFAULT rather than as "nothing said yet", a brand-new session
    // would compare rich against rich and never be told anything — the default
    // would silently do nothing.
    expect(resolveOutputModeDirective({}, cfgRich)).toEqual({
      mode: 'rich', instruction: RICH_OUTPUT_MODE_ON_INSTRUCTION, reminder: null,
    })
    expect(resolveOutputModeDirective(null, cfgRich).instruction).toBe(RICH_OUTPUT_MODE_ON_INSTRUCTION)
  })

  it('once told, rich carries the standing reminder instead (never both)', () => {
    expect(resolveOutputModeDirective({ output_mode_injected: 'rich' }, cfgRich)).toEqual({
      mode: 'rich', instruction: null, reminder: RICH_OUTPUT_MODE_REMINDER,
    })
    expect(resolveOutputModeDirective({ output_mode: 'rich', output_mode_injected: 'rich' }, cfgMarkdown)).toEqual({
      mode: 'rich', instruction: null, reminder: RICH_OUTPUT_MODE_REMINDER,
    })
    // The edge send says everything the reminder says — no double.
    expect(resolveOutputModeDirective({ output_mode: 'rich' }, cfgRich).reminder).toBeNull()
    // Markdown never gets a reminder, told or not.
    expect(resolveOutputModeDirective({ output_mode_injected: 'markdown' }, cfgMarkdown).reminder).toBeNull()
  })

  it('tells the model the truth about scripts, and points at the recipes', () => {
    // The instruction used to say "Inline <script> is stripped", which is false:
    // a script-bearing chunk is routed to a sandboxed island, not stripped. A model
    // told its scripts vanish works around a problem it does not have.
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).not.toMatch(/stripped/i)
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).toContain('```html-app')
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).toContain('sandboxed iframe')
    // The component recipes are a whole document, so the instruction points at
    // the skill instead of inlining it.
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).toContain('skill_read')
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).toContain('rich-output')
    // One line each, so the client's blank-line strip finds the user's own text.
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).not.toContain('\n')
    expect(RICH_OUTPUT_MODE_OFF_INSTRUCTION).not.toContain('\n')
    // The reminder rides EVERY message, so it stays one short line.
    expect(RICH_OUTPUT_MODE_REMINDER).not.toContain('\n')
    expect(RICH_OUTPUT_MODE_REMINDER.length).toBeLessThan(120)
  })
})

describe('session:send — markdown', () => {
  it('the enqueued text is byte-identical to what the user typed', async () => {
    await setConfigOutputMode('markdown')
    const sid = await newSession()
    const res = await callSend({ sessionId: sid, message: TEXT })

    expect(await drain(sid)).toBe(TEXT)
    // No rewrite happened, so there is nothing for the bubble to dedup against.
    expect(res.dedupText).toBeUndefined()
    const record = await getSessionByClaudeId(sid)
    expect(record?.output_mode_injected).toBeUndefined()

    // …and it stays that way: no reminder ever appears in markdown mode.
    await callSend({ sessionId: sid, message: 'again' })
    expect(await drain(sid)).toBe('again')
  })

  it('an explicit markdown record beats a rich CONFIG', async () => {
    await setConfigOutputMode('rich')
    const sid = await newSession()
    await patchSession(sid, { output_mode: 'markdown' })

    const res = await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(TEXT)
    expect(res.dedupText).toBeUndefined()
  })

  it('an unchanged mode never rewrites, even with attachments (image preamble only)', async () => {
    await setConfigOutputMode('markdown')
    const sid = await newSession()
    const res = await callSend({
      sessionId: sid,
      message: TEXT,
      images: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
    })
    const enqueued = await drain(sid)
    expect(enqueued.startsWith('[Images attached')).toBe(true)
    expect(enqueued).not.toContain('Rich output mode')
    expect(res.dedupText).toBe(enqueued)
  })

  it('a rejected output_mode never reaches the record', async () => {
    await setConfigOutputMode('markdown')
    const sid = await newSession()
    await expect(patchSession(sid, { output_mode: 'html' })).rejects.toThrow(/output_mode must be one of/)
    expect((await getSessionByClaudeId(sid))?.output_mode).toBeUndefined()

    // ...and the send that follows is unprefixed, i.e. the reject was total.
    await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(TEXT)
  })
})

describe('session:send — rich', () => {
  it('appends the ON instruction once, then reminds on every later send', async () => {
    await setConfigOutputMode('markdown')
    const sid = await newSession()
    await patchSession(sid, { output_mode: 'rich' })

    const first = await callSend({ sessionId: sid, message: TEXT })
    const firstText = await drain(sid)
    expect(firstText).toBe(`${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`)
    // No dedupText: history hides the wrapper, so what it shows IS what the user
    // typed and there is nothing extra to match on (see the absorption suite).
    expect(first.dedupText).toBeUndefined()
    // The edge advanced server-side — this is what makes a reload safe.
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBe('rich')

    // Second send: the STANDING reminder, and NOT the full instruction again.
    const second = await callSend({ sessionId: sid, message: 'and now the pgid scan?' })
    const secondText = await drain(sid)
    expect(secondText).toBe(`and now the pgid scan?\n\n${RICH_OUTPUT_MODE_REMINDER}`)
    expect(secondText).not.toContain(RICH_OUTPUT_MODE_ON_INSTRUCTION)
    expect(second.dedupText).toBeUndefined()

    // Third send: same — this is the drift fix, so it must not decay either.
    await callSend({ sessionId: sid, message: 'and the third?' })
    expect(await drain(sid)).toBe(`and the third?\n\n${RICH_OUTPUT_MODE_REMINDER}`)
  })

  it('the CONFIG default alone makes a brand-new session hear the instruction', async () => {
    await setConfigOutputMode('rich')
    const sid = await newSession()   // never touched its pill

    const first = await callSend({ sessionId: sid, message: TEXT })
    const firstText = await drain(sid)
    expect(firstText).toBe(`${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`)
    expect(first.dedupText).toBeUndefined()
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBe('rich')
    // The record itself stays unset: it is FOLLOWING the config, not overriding it.
    expect((await getSessionByClaudeId(sid))?.output_mode).toBeUndefined()

    await callSend({ sessionId: sid, message: 'next' })
    expect(await drain(sid)).toBe(`next\n\n${RICH_OUTPUT_MODE_REMINDER}`)
  })

  it('flipping the CONFIG is an edge for a session that never overrode the mode', async () => {
    await setConfigOutputMode('markdown')
    const sid = await newSession()
    await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(TEXT)

    // Settings → Output mode: Rich HTML. No per-session PATCH anywhere.
    await setConfigOutputMode('rich')
    await callSend({ sessionId: sid, message: 'now with pictures' })
    expect(await drain(sid)).toBe(`now with pictures\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`)
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBe('rich')
  })

  it('switching back to markdown appends the OFF instruction once, and drops the reminder', async () => {
    await setConfigOutputMode('markdown')
    const sid = await newSession()
    await patchSession(sid, { output_mode: 'rich' })
    await callSend({ sessionId: sid, message: TEXT })
    await drain(sid)

    await patchSession(sid, { output_mode: 'markdown' })
    await callSend({ sessionId: sid, message: 'plain please' })
    expect(await drain(sid)).toBe(`plain please\n\n${RICH_OUTPUT_MODE_OFF_INSTRUCTION}`)
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBe('markdown')

    await callSend({ sessionId: sid, message: 'still plain' })
    expect(await drain(sid)).toBe('still plain')
  })

  it('composes with the image preamble: attachments → text → instruction/reminder', async () => {
    await setConfigOutputMode('markdown')
    const sid = await newSession()
    await patchSession(sid, { output_mode: 'rich' })

    // Edge send: the instruction lands after everything, no reminder yet.
    const first = await callSend({
      sessionId: sid,
      message: TEXT,
      images: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
    })
    const enqueued = await drain(sid)
    expect(enqueued.startsWith('[Images attached')).toBe(true)
    expect(enqueued.endsWith(`\n\n${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`)).toBe(true)
    // dedupText = what history will SHOW: the image preamble survives the
    // projection, the instruction does not.
    expect(first.dedupText).toBe(stripOutputModeWrappers(enqueued))
    expect(first.dedupText).toContain('[Images attached')
    expect(first.dedupText).not.toContain('Rich output mode')
    expect(stripSendPrefixes(enqueued)).toBe(TEXT)

    // Standing send: the reminder is the LAST thing, after the user's text.
    const second = await callSend({
      sessionId: sid,
      message: TEXT,
      images: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
    })
    const later = await drain(sid)
    expect(later.startsWith('[Images attached')).toBe(true)
    expect(later.endsWith(`\n\n${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}`)).toBe(true)
    expect(second.dedupText).toBe(stripOutputModeWrappers(later))
    expect(stripSendPrefixes(later)).toBe(TEXT)
  })

  it('dedupText is what HISTORY shows, not what the CLI received', async () => {
    // The matching basis has to be the same on both sides or the optimistic bubble
    // is structurally unequal to its persisted twin and stays pinned at the bottom
    // of the timeline (inc-1785091339102, the trap the image preamble fell into).
    // Since the projection hides the wrapper, the basis is the typed text — the
    // field is omitted entirely — and only the image preamble makes it necessary.
    await setConfigOutputMode('rich')
    const sid = await newSession()

    const first = await callSend({ sessionId: sid, message: TEXT })
    expect(first.dedupText).toBeUndefined()
    await drain(sid)

    const second = await callSend({ sessionId: sid, message: TEXT })
    expect(second.dedupText).toBeUndefined()

    const withImage = await callSend({
      sessionId: sid, message: TEXT,
      images: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
    })
    expect(withImage.dedupText).toContain('[Images attached')
    expect(withImage.dedupText).toContain(TEXT)
    expect(withImage.dedupText).not.toContain('Rich output mode')
  })
})

// ── Slash commands must reach the CLI byte-exact (inc-1788194545341) ─────────
// The CLI treats input as a command ONLY when the raw string startsWith('/')
// (processUserInput). The rich-output wrapper (a prefix at the time) turned
// "/compact" into "[Rich output mode: …]\n\n/compact" — a plain chat message the
// model role-played ("已压缩上下文…") while zero compact_boundary events appeared.
// Appended text is nearly as bad: it rides into the command's argument string.
describe('session:send — slash commands bypass the wrapper', () => {
  it('an owed ON edge does not wrap a slash command, and stays owed', async () => {
    await setConfigOutputMode('rich')
    const sid = await newSession()   // edge owed: never told anything

    await callSend({ sessionId: sid, message: '/compact' })
    expect(await drain(sid)).toBe('/compact')
    // The edge was NOT consumed — the record still owes the instruction…
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBeUndefined()

    // …and the next real message carries it.
    await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(`${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`)
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBe('rich')
  })

  it('the standing reminder never rides a slash command (it would land in the args)', async () => {
    await setConfigOutputMode('rich')
    const sid = await newSession()
    await callSend({ sessionId: sid, message: TEXT })   // consume the edge
    await drain(sid)

    await callSend({ sessionId: sid, message: '/compact keep the file list' })
    expect(await drain(sid)).toBe('/compact keep the file list')

    // Ordinary sends still get the reminder — the skip is per-message.
    await callSend({ sessionId: sid, message: 'back to normal' })
    expect(await drain(sid)).toBe(`back to normal\n\n${RICH_OUTPUT_MODE_REMINDER}`)
  })

  it('an owed OFF edge does not wrap a slash command either', async () => {
    await setConfigOutputMode('markdown')
    const sid = await newSession()
    await patchSession(sid, { output_mode: 'rich' })
    await callSend({ sessionId: sid, message: TEXT })
    await drain(sid)

    await patchSession(sid, { output_mode: 'markdown' })   // OFF edge now owed
    await callSend({ sessionId: sid, message: '/compact' })
    expect(await drain(sid)).toBe('/compact')
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBe('rich')

    await callSend({ sessionId: sid, message: 'plain please' })
    expect(await drain(sid)).toBe(`plain please\n\n${RICH_OUTPUT_MODE_OFF_INSTRUCTION}`)
  })
})

// The client must render what the user typed, not the machine wrapper. This is
// the inverse of the emitter above, so keeping the two in one file makes a
// format drift fail loudly instead of silently showing the instruction.
describe('stripSendPrefixes (client display)', () => {
  it('peels the output-mode instruction (current trailing form)', () => {
    expect(stripSendPrefixes(`${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`)).toBe(TEXT)
    expect(stripSendPrefixes(`${TEXT}\n\n${RICH_OUTPUT_MODE_OFF_INSTRUCTION}`)).toBe(TEXT)
  })

  it('still peels the LEGACY prefix form (old transcripts echo it forever)', () => {
    expect(stripSendPrefixes(`${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${TEXT}`)).toBe(TEXT)
    expect(stripSendPrefixes(`${RICH_OUTPUT_MODE_OFF_INSTRUCTION}\n\n${TEXT}`)).toBe(TEXT)
  })

  it('peels the trailing standing reminder', () => {
    expect(stripSendPrefixes(`${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}`)).toBe(TEXT)
    // A multi-paragraph message keeps all of its own paragraphs.
    expect(stripSendPrefixes(`first para\n\nsecond para\n\n${RICH_OUTPUT_MODE_REMINDER}`))
      .toBe('first para\n\nsecond para')
  })

  it('peels instruction + image preamble + reminder together', () => {
    const enqueued = `${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n`
      + `[Images attached — use the Read tool to view them]\n- /tmp/a.png\n\n${TEXT}`
      + `\n\n${RICH_OUTPUT_MODE_REMINDER}`
    expect(stripSendPrefixes(enqueued)).toBe(TEXT)
  })

  it('leaves an ordinary message alone (including one that merely mentions the mode)', () => {
    expect(stripSendPrefixes(TEXT)).toBe(TEXT)
    expect(stripSendPrefixes(`what does [Rich output mode: ON] do?`)).toBe('what does [Rich output mode: ON] do?')
    // Mentioned mid-text rather than as the trailing line: not ours to remove.
    expect(stripSendPrefixes(`is ${RICH_OUTPUT_MODE_REMINDER} still true?`))
      .toBe(`is ${RICH_OUTPUT_MODE_REMINDER} still true?`)
  })

  it('a malformed wrapper is left visible rather than eating the text', () => {
    // Unterminated reminder line (no closing bracket) — leave it alone.
    expect(stripSendPrefixes(`${TEXT}\n\n[Rich output mode is still on`)).toBe(`${TEXT}\n\n[Rich output mode is still on`)
    // A message that is NOTHING BUT the literal wrapper is someone quoting it at
    // us — never strip a message down to empty.
    expect(stripSendPrefixes('[Rich output mode: ON] no separator here')).toBe('[Rich output mode: ON] no separator here')
    expect(stripSendPrefixes(RICH_OUTPUT_MODE_REMINDER)).toBe(RICH_OUTPUT_MODE_REMINDER)
  })

  it('client and server strip identically (one contract, two runtimes)', () => {
    const cases = [
      TEXT,
      `${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`,
      `${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${TEXT}`,   // legacy prefix form
      `${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}`,
      `${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n[Images attached — use the Read tool to view them]\n- /tmp/a.png\n\n${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}`,
      `first\n${RICH_OUTPUT_MODE_REMINDER}\nsecond\n${RICH_OUTPUT_MODE_REMINDER}`,
      `is ${RICH_OUTPUT_MODE_REMINDER} still true?`,
    ]
    for (const c of cases) {
      expect(stripOutputModeWrappersClient(c), c.slice(0, 40)).toBe(stripOutputModeWrappers(c))
    }
  })
})

// ── The P0 the standing reminder created ────────────────────────────────────
// The CLI echoes what it RECEIVED into its JSONL, and history parses that back as
// the user's message — so before this strip the wrapper rendered inside the
// user's own bubble. Once per mode change was an accepted wart; once per MESSAGE
// is a bug (user-reported, screenshot-confirmed on :3456). Fixed at the history
// projection choke point, so web, phone, notification previews and auto-titles
// are all covered by these assertions.
describe('history projection strips the wrapper (display only)', () => {
  let ts = 0
  const nextTs = () => new Date(Date.UTC(2026, 0, 1) + (ts += 1000)).toISOString()
  const userLine = (content: string) => JSON.stringify({
    type: 'user', timestamp: nextTs(), uuid: `u-${ts}`, message: { role: 'user', content },
  })
  const assistantLine = (text: string) => JSON.stringify({
    type: 'assistant', timestamp: nextTs(), message: { id: `a-${ts}`, role: 'assistant', content: [{ type: 'text', text }] },
  })
  const userTexts = (jsonl: string) =>
    parseSessionMessages(jsonl).filter((m) => m.role === 'user').map((m) => m.text)

  it('the edge instruction never reaches the bubble — current trailing AND legacy prefix forms', () => {
    const jsonl = [
      userLine(`${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`),
      assistantLine('<div>ok</div>'),
      // Old transcripts echo the pre-2026-08-31 prefix placement forever.
      userLine(`${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${TEXT}`),
      assistantLine('<div>still ok</div>'),
    ].join('\n')
    expect(userTexts(jsonl)).toEqual([TEXT, TEXT])
  })

  it('the standing reminder never reaches the bubble — including a merged batch', () => {
    const jsonl = [
      userLine(`${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}`),
      assistantLine('one'),
      // A merged batch echoes as ONE line, joined by the CLI with a single '\n',
      // so BOTH reminders sit mid-text. An end-anchored strip would leave the first.
      userLine(`first message\n${RICH_OUTPUT_MODE_REMINDER}\nsecond message\n${RICH_OUTPUT_MODE_REMINDER}`),
      assistantLine('two'),
    ].join('\n')
    expect(userTexts(jsonl)).toEqual([TEXT, 'first message\nsecond message'])
  })

  it('keeps the image preamble (real information) and the user\'s own mention of the mode', () => {
    const withImages = `${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n`
      + `[Images attached — use the Read tool to view them]\n- /tmp/a.png\n\n${TEXT}\n\n${RICH_OUTPUT_MODE_REMINDER}`
    const jsonl = [
      userLine(withImages),
      userLine('why does [Rich output mode: ON] appear in my bubble?'),
    ].join('\n')
    expect(userTexts(jsonl)).toEqual([
      `[Images attached — use the Read tool to view them]\n- /tmp/a.png\n\n${TEXT}`,
      'why does [Rich output mode: ON] appear in my bubble?',
    ])
  })

  it('an ordinary message is returned untouched (identity, not a rebuild)', () => {
    const plain = 'nothing to strip here\n\nsecond paragraph'
    expect(stripOutputModeWrappers(plain)).toBe(plain)
    expect(userTexts(userLine(plain))).toEqual([plain])
  })
})

describe('optimistic bubble is absorbed exactly once (inc-1785091339102)', () => {
  /** The matcher's evidence: dedupText (the emitter's promise about what history
   *  will show) compared against a persisted user line. */
  const bubble = (queueId: string, text: string, dedupText?: string) =>
    ({ queueId, text, status: 'delivered', ...(dedupText ? { dedupText } : {}) })
  const persisted = (text: string, walnutMessageId?: string) =>
    ({ role: 'user', text, ...(walnutMessageId ? { walnutMessageId } : {}) })

  it('rich + images: the RPC dedupText matches the projected history line', async () => {
    await setConfigOutputMode('rich')
    const sid = await newSession()

    // First send takes the edge, so the second is the interesting one: image
    // preamble AND standing reminder in the same message.
    await callSend({ sessionId: sid, message: TEXT })
    await drain(sid)
    const res = await callSend({
      sessionId: sid, message: TEXT,
      images: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
    })
    const enqueued = await drain(sid)

    // What the CLI got vs what the human will read: the wrapper is in the first
    // and in neither of the others.
    expect(enqueued).toContain(RICH_OUTPUT_MODE_REMINDER)
    const projected = stripOutputModeWrappers(enqueued)
    expect(res.dedupText).toBe(projected)
    expect(projected).toContain('[Images attached')
    expect(projected).not.toContain('Rich output mode')

    // Absorbed by TEXT evidence (no id) …
    const b = bubble(res.messageId!, TEXT, res.dedupText)
    expect(dedupeOptimisticMessages([b], [persisted(projected)], 0)).toEqual([])
    // … and by ID evidence, the stronger pass.
    expect(dedupeOptimisticMessages([b], [persisted(projected, res.messageId!)], 0)).toEqual([])
    // Nothing else is swept up: a second, unrelated bubble survives.
    const other = bubble('qm-other', 'unrelated')
    expect(dedupeOptimisticMessages([b, other], [persisted(projected)], 0)).toEqual([other])
  })

  it('rich, no attachments: no dedupText at all, plain text evidence is enough', async () => {
    await setConfigOutputMode('rich')
    const sid = await newSession()
    await callSend({ sessionId: sid, message: TEXT })
    await drain(sid)

    const res = await callSend({ sessionId: sid, message: TEXT })
    // The wrapper is the ONLY difference from what the user typed, and history
    // hides it — so there is nothing to dedup against and the field is omitted.
    expect(res.dedupText).toBeUndefined()
    expect(dedupeOptimisticMessages([bubble(res.messageId!, TEXT)], [persisted(TEXT)], 0)).toEqual([])
  })

  it('echo-claim binding survives the strip (id evidence keeps working)', () => {
    // The claim holds what the CLI RECEIVED; history projects the stripped form.
    // Without the candidate widening in echo-claims.ts, every rich-mode send
    // would silently lose its walnutMessageId and fall back to text matching.
    const sid = 'echo-claim-session'
    const sent = `${TEXT}\n\n${RICH_OUTPUT_MODE_ON_INSTRUCTION}`
    registerEchoClaims(sid, ['qm-echo-1'], sent)
    const messages = [{
      role: 'user', text: stripOutputModeWrappers(sent), timestamp: new Date().toISOString(), msgId: 'u-1',
    }]
    bindEchoClaims(sid, messages)
    expect(messages[0].walnutMessageId).toBe('qm-echo-1')
  })
})
