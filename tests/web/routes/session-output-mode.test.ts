/**
 * Per-session Output mode ("markdown" vs rich HTML) is EDGE-triggered: the
 * one-line instruction rides the first `session:send` after the mode CHANGED,
 * and never again while it holds. The edge lives on the record
 * (`output_mode` vs `output_mode_injected`), so a reload or a second device
 * can't inject a second copy.
 *
 * What each test pins:
 *   1. a session on the default mode pays NOTHING (the zero-overhead promise)
 *   2. flipping to rich prefixes the ON instruction exactly once
 *   3. flipping back prefixes the OFF instruction exactly once
 *   4. the prefixed text comes back as `dedupText` (without it the optimistic
 *      bubble can never be absorbed and stays pinned at the bottom —
 *      inc-1785091339102, the same trap the image preamble fell into)
 *   5. composition with the image preamble: ORDER is instruction → images → text
 *   6. the client's display strip is the exact inverse of what the server built
 *
 * Would-fail-if-reverted: drop the `resolveOutputModeEdge` call in
 * session-chat.ts and 2/3/5 see an unprefixed queue row; drop the
 * `output_mode_injected` write and test 2's second send is prefixed too.
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
import {
  RICH_OUTPUT_MODE_ON_INSTRUCTION, RICH_OUTPUT_MODE_OFF_INSTRUCTION, resolveOutputModeEdge,
} from '../../../src/core/sessions/output-mode.js'
import { stripSendPrefixes } from '../../../web/src/hooks/useSessionSend'

const TEXT = 'explain how the daemon adopts an orphaned session'

const fakeClient = {} as never

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
  _resetSessionTrackerForTesting()
  bus.clear()
  methods.clear()
  registerSessionChatRpc()
})

afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('resolveOutputModeEdge', () => {
  it('is silent whenever the stored mode equals the injected one', () => {
    expect(resolveOutputModeEdge(null)).toBeNull()
    expect(resolveOutputModeEdge({})).toBeNull()
    expect(resolveOutputModeEdge({ output_mode: 'markdown' })).toBeNull()
    // An older record carries no injected marker — that means 'markdown'.
    expect(resolveOutputModeEdge({ output_mode: 'rich', output_mode_injected: 'rich' })).toBeNull()
  })

  it('tells the model the truth about scripts', () => {
    // The instruction used to say "Inline <script> is stripped", which is false:
    // a script-bearing chunk is routed to a sandboxed island, not stripped. A model
    // told its scripts vanish works around a problem it does not have.
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).not.toMatch(/stripped/i)
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).toContain('```html-app')
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).toContain('sandboxed iframe')
    // One line, so the client's blank-line strip finds the user's own text.
    expect(RICH_OUTPUT_MODE_ON_INSTRUCTION).not.toContain('\n')
    expect(RICH_OUTPUT_MODE_OFF_INSTRUCTION).not.toContain('\n')
  })

  it('fires once per direction, with the matching instruction', () => {
    expect(resolveOutputModeEdge({ output_mode: 'rich' })).toEqual({
      mode: 'rich', instruction: RICH_OUTPUT_MODE_ON_INSTRUCTION,
    })
    expect(resolveOutputModeEdge({ output_mode: 'markdown', output_mode_injected: 'rich' })).toEqual({
      mode: 'markdown', instruction: RICH_OUTPUT_MODE_OFF_INSTRUCTION,
    })
  })
})

describe('session:send output-mode edge', () => {
  it('default markdown: the enqueued text is byte-identical to what the user typed', async () => {
    const sid = await newSession()
    const res = await callSend({ sessionId: sid, message: TEXT })

    expect(await drain(sid)).toBe(TEXT)
    // No rewrite happened, so there is nothing for the bubble to dedup against.
    expect(res.dedupText).toBeUndefined()
    const record = await getSessionByClaudeId(sid)
    expect(record?.output_mode_injected).toBeUndefined()
  })

  it('after switching to rich: the ON instruction is prefixed EXACTLY once', async () => {
    const sid = await newSession()
    await patchSession(sid, { output_mode: 'rich' })

    const first = await callSend({ sessionId: sid, message: TEXT })
    const firstText = await drain(sid)
    expect(firstText).toBe(`${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${TEXT}`)
    expect(first.dedupText).toBe(firstText)

    // The edge advanced server-side — this is what makes a reload safe.
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBe('rich')

    // Second send while the mode HOLDS: no instruction, no dedupText.
    const second = await callSend({ sessionId: sid, message: 'and now the pgid scan?' })
    expect(await drain(sid)).toBe('and now the pgid scan?')
    expect(second.dedupText).toBeUndefined()
  })

  it('switching back to markdown prefixes the OFF instruction once', async () => {
    const sid = await newSession()
    await patchSession(sid, { output_mode: 'rich' })
    await callSend({ sessionId: sid, message: TEXT })
    await drain(sid)

    await patchSession(sid, { output_mode: 'markdown' })
    await callSend({ sessionId: sid, message: 'plain please' })
    expect(await drain(sid)).toBe(`${RICH_OUTPUT_MODE_OFF_INSTRUCTION}\n\nplain please`)
    expect((await getSessionByClaudeId(sid))?.output_mode_injected).toBe('markdown')

    await callSend({ sessionId: sid, message: 'still plain' })
    expect(await drain(sid)).toBe('still plain')
  })

  it('composes with the image preamble: instruction → attachments → user text', async () => {
    const sid = await newSession()
    await patchSession(sid, { output_mode: 'rich' })

    const res = await callSend({
      sessionId: sid,
      message: TEXT,
      images: [{ data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
    })

    const enqueued = await drain(sid)
    expect(enqueued.startsWith(`${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n[Images attached`)).toBe(true)
    expect(enqueued.endsWith(`\n\n${TEXT}`)).toBe(true)
    // Both rewrites ride ONE dedupText — the bubble shows the user's own words.
    expect(res.dedupText).toBe(enqueued)
    expect(stripSendPrefixes(enqueued)).toBe(TEXT)
  })

  it('an unchanged mode never rewrites, even with attachments (image preamble only)', async () => {
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
    const sid = await newSession()
    await expect(patchSession(sid, { output_mode: 'html' })).rejects.toThrow(/output_mode must be one of/)
    expect((await getSessionByClaudeId(sid))?.output_mode).toBeUndefined()

    // ...and the send that follows is unprefixed, i.e. the reject was total.
    await callSend({ sessionId: sid, message: TEXT })
    expect(await drain(sid)).toBe(TEXT)
  })
})

// The client must render what the user typed, not the machine preamble. This is
// the inverse of the emitter above, so keeping the two in one file makes a
// format drift fail loudly instead of silently showing the instruction.
describe('stripSendPrefixes (client display)', () => {
  it('peels the output-mode instruction', () => {
    expect(stripSendPrefixes(`${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n${TEXT}`)).toBe(TEXT)
    expect(stripSendPrefixes(`${RICH_OUTPUT_MODE_OFF_INSTRUCTION}\n\n${TEXT}`)).toBe(TEXT)
  })

  it('peels instruction + image preamble together, outermost first', () => {
    const enqueued = `${RICH_OUTPUT_MODE_ON_INSTRUCTION}\n\n`
      + `[Images attached — use the Read tool to view them]\n- /tmp/a.png\n\n${TEXT}`
    expect(stripSendPrefixes(enqueued)).toBe(TEXT)
  })

  it('leaves an ordinary message alone (including one that merely mentions the mode)', () => {
    expect(stripSendPrefixes(TEXT)).toBe(TEXT)
    expect(stripSendPrefixes(`what does [Rich output mode: ON] do?`)).toBe('what does [Rich output mode: ON] do?')
  })

  it('a malformed prefix with no blank line is left visible rather than eating the text', () => {
    expect(stripSendPrefixes('[Rich output mode: ON] no separator here')).toBe('[Rich output mode: ON] no separator here')
  })
})
