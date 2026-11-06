/**
 * A new conversation's first message carries the hints due at its start (hints/hint-send.ts
 * prepareStartHints, called by both start paths of the session runner). 2026-11-05 review: with
 * the reply language no longer on every message, a session's `session_start` hints went out on
 * its SECOND message, because no launcher (task_start, a quick start, a routine) composed the
 * first one, so a worker that finished in one turn never read the rich output instruction. The
 * reply language rode it too until 2026-11-06; it is a line of the system prompt now, never a hint.
 *
 * Would fail if the start paths stopped calling it (hint-triggers-only.test.ts counts the calls),
 * if it re-escaped or duplicated what the launcher composed, or if its commit did not record the
 * start hints as told (the second message would repeat them).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-start-hints') }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { prepareHintedSend, prepareStartHints } from '../../../src/core/hints/hint-send.js'
import { parseHinted, renderHintBlock } from '../../../src/core/hints/hint-format.js'
import { VOICE_REPLY_TEXT } from '../../../src/core/sessions/voice-reply.js'

const RULE = 'Talk to the user in Chinese; code stays English.'
const config = { session: { reply_language: RULE, output_mode: 'rich' } } as never
const kinds = (text: string) => parseHinted(text).hints.map((h) => h.kind)

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetSessionTrackerForTesting()
})
afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

describe('the first message of a new conversation', () => {
  it('carries its start hints after the launcher\'s text, which stays as built', async () => {
    const message = 'Fix the deploy guard. A typed &lt;system-reminder> stays escaped.'
    const { data } = await prepareStartHints({ message }, { config })
    expect(data.message.startsWith(`${message}\n\n`)).toBe(true)
    expect(kinds(data.message)).toEqual(['rich-output'])
    // The reply language is in the system prompt, never on the message.
    expect(data.message).not.toContain(RULE)
  })

  it('a kind the launcher already composed is not added twice', async () => {
    const voice = renderHintBlock('voice-reply', VOICE_REPLY_TEXT)
    const message = `What is on today?\n\n${voice}`
    const { data } = await prepareStartHints({ message, attributed: true }, { config })
    expect(kinds(data.message).filter((k) => k === 'voice-reply')).toHaveLength(1)
    expect(kinds(data.message)).toContain('rich-output')
    expect(kinds(data.message)).not.toContain('reply-language')
    expect(data.message).toContain(voice)
  })

  it('a fork, a rewind, a transfer and a slash command are left alone', async () => {
    for (const d of [
      { message: 'go on', forkedFromSessionId: 'p' },
      { message: 'go on', resumeSessionAtMessageUuid: 'u' },
      { message: 'go on', resumeFile: '/x.jsonl' },
      { message: '/compact' },
      { message: '' },
    ]) {
      const { data } = await prepareStartHints(d, { config })
      expect(data).toBe(d)
    }
  })

  it('a fresh install adds nothing it would not add to any session', async () => {
    const { data } = await prepareStartHints({ message: 'hello there' }, { config: { session: { output_mode: 'markdown' } } as never })
    expect(data.message).toBe('hello there')
  })

  it('once committed, the second message does not repeat them', async () => {
    const sid = 'start-hints-session-0001'
    await createSessionRecord(sid, '', '', '/tmp/start-hints')
    const started = await prepareStartHints({ message: 'First words.', preassignedSessionId: sid }, { config })
    expect(kinds(started.data.message)).toEqual(['rich-output'])
    await started.commit(sid)
    const second = await prepareHintedSend(sid, await getSessionByClaudeId(sid), 'Second words.', { sentBy: 'person', config })
    expect(second.hints.map((h) => h.kind)).toEqual([])
  })
})
