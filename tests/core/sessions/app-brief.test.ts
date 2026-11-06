/**
 * App brief (src/core/sessions/app-brief.ts): a plugin gives the AI on a task
 * background for the AI only. Told whole once per session and compaction
 * boundary, ahead of the next message; never repeated; every view a person
 * reads shows its fold, never its body (src/lib/ai-only-envelope.ts).
 *
 * Against the REAL task store, session registry and queue in an isolated home,
 * through sendMessageToSession, the one function every send passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-app-brief'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { sendMessageToSession, getQueue, editMessage, resetCache } from '../../../src/core/session-message-queue.js'
import { publishAppState, readAppState, disposeAppStateOwner, resetAppStateForTesting } from '../../../src/core/sessions/app-state.js'
import { setAppBrief, clearAppBrief, briefAfterCompactionLine, MAX_BRIEF_BYTES } from '../../../src/core/sessions/app-brief.js'
import { AI_ONLY_PLACEHOLDER, redactAiOnly, keepAiOnly } from '../../../src/lib/ai-only-envelope.js'
import { projectUserText, displayQueueRow } from '../../../src/core/sessions/reference-cards.js'
import { parseSessionMessages } from '../../../src/core/session-history.js'
import { parseSessionEnvelopes } from '../../../src/lib/history-session-envelope.js'

const PLUGIN = 'quiz-coach'
const NAME = 'Quiz Coach'
const RUBRIC = '## Rubric\n- Correctness: handles the empty list.\n- Communication: states the plan first.\n\n## Reference\n```python\ndef answer():\n    return 42\n```'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  resetAppStateForTesting()
})
afterEach(() => {
  resetAppStateForTesting()
})

async function spawned(sid?: string) {
  const { task } = await addTask({ title: 'Practice: Interval Sum', project: 'Practice' })
  const id = sid ?? `sid-${task.id}`
  await createSessionRecord(id, task.id, task.project ?? '', '/tmp/ws/interval-sum', { title: task.title })
  await updateSessionRecord(id, { output_mode: 'markdown' })
  return { task, sid: id }
}
const rows = async (sid: string) => (await getQueue(sid)).map((m) => m.message)
const brief = (taskId: string, text: string, label?: string) => setAppBrief(PLUGIN, NAME, { taskId, text, ...(label ? { label } : {}) })

describe('an App brief rides the next message once', () => {
  it('whole, ahead of the app state and the words, flagged for the AI only; then never again', async () => {
    const { task, sid } = await spawned()
    await brief(task.id, RUBRIC)
    await publishAppState(PLUGIN, NAME, { taskId: task.id, state: { level: 1 } })
    await sendMessageToSession(sid, 'how should I start?', { source: 'ui' })
    await sendMessageToSession(sid, 'and now?', { source: 'ui' })
    await sendMessageToSession(sid, 'one more', { source: 'ui' })
    const [first, second, third] = await rows(sid)
    expect(first).toMatch(/^<walnut-message kind="app-state" from="Quiz Coach" title="brief" about-task="[^"]+" note="automated App brief, for the AI only" ai-only="true">/)
    expect(first).toContain('def answer():\n    return 42')
    expect(first).toContain('It is for you only')
    expect(first.indexOf('ai-only="true"')).toBeLessThan(first.indexOf('title="current state"'))
    expect(first.endsWith('\n\nhow should I start?')).toBe(true)
    // Told: no later message carries it.
    expect(second).toBe('and now?')
    expect(third).toBe('one more')
    // The parser every view uses reads it as one app-state card.
    const segments = parseSessionEnvelopes(first)!
    expect(segments[0]).toMatchObject({ kind: 'envelope', envelope: { kind: 'app-state', title: 'brief', peer: { title: NAME, taskId: task.id } } })
  })

  it('the same text set again is not told again; an extended text tells only the added part; another text replaces it whole', async () => {
    const { task, sid } = await spawned()
    const v1 = await brief(task.id, RUBRIC)
    await sendMessageToSession(sid, 'a', { source: 'ui' })
    expect(await brief(task.id, RUBRIC)).toEqual(v1)
    await sendMessageToSession(sid, 'b', { source: 'ui' })
    await brief(task.id, `${RUBRIC}\n\n## Part 2\n- Handles overlapping ranges.`)
    await sendMessageToSession(sid, 'c', { source: 'ui' })
    await brief(task.id, '## Rubric for another problem\n- Something else.')
    await sendMessageToSession(sid, 'd', { source: 'ui' })
    const [, b, c, d] = await rows(sid)
    expect(b).toBe('b')
    expect(c).toContain('title="brief, added to"')
    expect(c).toContain('## Part 2\n- Handles overlapping ranges.')
    expect(c).not.toContain('def answer()')
    expect(d).toContain('title="brief, replaced"')
    expect(d).toContain('This replaces the one before it, whole.')
    expect(d).toContain('## Rubric for another problem')
  })

  it('a compaction, or another session, gets it whole again', async () => {
    const { task, sid } = await spawned()
    await brief(task.id, RUBRIC)
    await sendMessageToSession(sid, 'first', { source: 'ui' })
    await sendMessageToSession(sid, 'second', { source: 'ui' })
    await updateSessionRecord(sid, { lastCompactUuid: 'boundary-1' })
    await sendMessageToSession(sid, 'after the compaction', { source: 'ui' })
    await sendMessageToSession(sid, 'and after that', { source: 'ui' })
    const all = await rows(sid)
    expect(all[1]).toBe('second')
    expect(all[2]).toContain('title="brief"')
    expect(all[2]).toContain('def answer():')
    expect(all[3]).toBe('and after that')
    // Told per session: another task's session with its own brief starts from the whole text.
    const other = await spawned()
    await brief(other.task.id, RUBRIC)
    await sendMessageToSession(other.sid, 'hello', { source: 'ui' })
    expect((await rows(other.sid))[0]).toContain('title="brief"')
    // The compaction hook says it is coming, never the text.
    const line = briefAfterCompactionLine(task.id)
    expect(line).toContain('Quiz Coach')
    expect(line).not.toContain('def answer')
  })

  it('a slash command goes raw and leaves it for the next message', async () => {
    const { task, sid } = await spawned()
    await brief(task.id, RUBRIC)
    await sendMessageToSession(sid, '/compact', { source: 'ui' })
    await sendMessageToSession(sid, 'then this', { source: 'ui' })
    const [cmd, next] = await rows(sid)
    expect(cmd).toBe('/compact')
    expect(next).toContain('ai-only="true"')
  })

  it('app_state reads it whole and counts as told', async () => {
    const { task, sid } = await spawned()
    await brief(task.id, RUBRIC, 'Interviewer brief')
    const read = await readAppState(sid)
    expect(read.briefs).toEqual([expect.objectContaining({ plugin: PLUGIN, label: 'Interviewer brief', text: RUBRIC })])
    await sendMessageToSession(sid, 'next', { source: 'ui' })
    expect(await rows(sid)).toEqual(['next'])
  })

  it('clear, an empty text and the plugin generation going away stop it; refuses what it cannot tell whole', async () => {
    const { task, sid } = await spawned()
    await brief(task.id, RUBRIC)
    clearAppBrief(PLUGIN, task.id)
    await sendMessageToSession(sid, 'one', { source: 'ui' })
    await brief(task.id, RUBRIC)
    await brief(task.id, '   ')
    await sendMessageToSession(sid, 'two', { source: 'ui' })
    await setAppBrief(PLUGIN, NAME, { taskId: task.id, text: RUBRIC }, { generation: 'gen-1' })
    disposeAppStateOwner(PLUGIN, 'gen-1')
    await sendMessageToSession(sid, 'three', { source: 'ui' })
    expect(await rows(sid)).toEqual(['one', 'two', 'three'])

    await expect(brief(task.id, 'x'.repeat(MAX_BRIEF_BYTES + 1))).rejects.toThrow(/limit is 49152/)
    await expect(setAppBrief(PLUGIN, NAME, { taskId: task.id, text: 42 as unknown as string })).rejects.toThrow(/is text/)
    await expect(brief('no-such-task', RUBRIC)).rejects.toThrow(/No task no-such-task/)
  })
})

describe('no view a person reads shows its body', () => {
  async function queuedWithBrief() {
    const { task, sid } = await spawned()
    await brief(task.id, RUBRIC)
    await sendMessageToSession(sid, 'my question', { source: 'ui' })
    const [row] = await getQueue(sid)
    return { task, sid, row }
  }

  it('the history parse (web, phone, search) and its raw view keep the fold, not the body', async () => {
    const { row } = await queuedWithBrief()
    const jsonl = JSON.stringify({ type: 'user', timestamp: '2026-11-10T00:00:00.000Z', uuid: 'u-1', message: { role: 'user', content: row.message } })
    const [shown] = parseSessionMessages(jsonl).filter((m) => m.role === 'user')
    for (const text of [shown.text, shown.rawText ?? '']) {
      expect(text).not.toContain('def answer')
      expect(text).not.toContain('Correctness: handles')
    }
    expect(shown.text).toContain(AI_ONLY_PLACEHOLDER)
    expect(shown.text).toContain('my question')
    const segments = parseSessionEnvelopes(shown.text)!
    expect(segments[0]).toMatchObject({ kind: 'envelope', envelope: { kind: 'app-state', title: 'brief' } })
  })

  it('the queue list keeps the fold in `message` and `rawMessage`', async () => {
    const { row } = await queuedWithBrief()
    const listed = displayQueueRow(row)
    expect(listed.message).not.toContain('def answer')
    expect(listed.rawMessage ?? '').not.toContain('def answer')
    expect(projectUserText(row.message).text).toContain(AI_ONLY_PLACEHOLDER)
  })

  it('an edit of the queued row (from the fold, or from the words alone) keeps the real brief', async () => {
    const { sid, row } = await queuedWithBrief()
    const fromPhone = displayQueueRow(row).message.replace('my question', 'my better question')
    expect(await editMessage(sid, row.id, fromPhone)).toBe(true)
    let [edited] = await getQueue(sid)
    expect(edited.message).toContain('def answer():\n    return 42')
    expect(edited.message).not.toContain(AI_ONLY_PLACEHOLDER)
    expect(edited.message).toContain('my better question')
    expect(await editMessage(sid, row.id, 'just words')).toBe(true)
    ;[edited] = await getQueue(sid)
    expect(edited.message).toContain('def answer():\n    return 42')
    expect(edited.message.endsWith('just words')).toBe(true)
  })

  it('redaction leaves other text alone and handles several envelopes', () => {
    const plain = '<walnut-message kind="app-state" from="X" title="current state">\nlevel: 1\n</walnut-message>\n\nhi'
    expect(redactAiOnly(plain)).toBe(plain)
    const two = [
      '<walnut-message kind="app-state" from="A" title="brief" ai-only="true">\nsecret one\n</walnut-message>',
      plain,
      '<walnut-message kind="app-state" from="B" title="brief" ai-only="true">\nsecret\ntwo\n</walnut-message>',
    ].join('\n\n')
    const out = redactAiOnly(two)
    expect(out).not.toMatch(/secret/)
    expect(out).toContain('level: 1')
    expect(out.split(AI_ONLY_PLACEHOLDER)).toHaveLength(3)
    expect(keepAiOnly(two, 'new')).toMatch(/secret one[\s\S]*secret\ntwo[\s\S]*\n\nnew$/)
  })
})

describe('guard: every place that hands a person session text redacts it', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const read = (rel: string) => fs.readFile(path.join(ROOT, rel), 'utf8')

  it('each raw-text field built for a view goes through redactAiOnly, and the browser re-emit of a queued row does too', async () => {
    // Every `rawText:` / `rawMessage:` property a view reads, by file. A new one must redact,
    // or be listed here with why it is not a person's view.
    const notAView: Record<string, string> = {
      'src/providers/daemon-core.ts': 'a parameter name, not a view',
      'src/core/transfer/transfer.ts': 'a boolean flag',
      'src/core/session-hooks/builtins.ts': 'a parameter name, not a view',
      'src/core/session-message-queue.ts': 'the bus event to the server; src/web/server.ts redacts it before the browser',
    }
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync('/usr/bin/grep', ['-rnE', '\\b(rawText|rawMessage|queuedText|rowText): ', 'src'], { cwd: ROOT, encoding: 'utf8' })
    const offenders = out.split('\n').filter(Boolean).filter((line) => {
      const file = line.split(':')[0]
      if (notAView[file]) return false
      if (file.endsWith('.d.ts') || /\binterface\b|\?: |: string\b|: boolean\b/.test(line.split(':').slice(2).join(':'))) return false
      return !line.includes('redactAiOnly(')
    })
    expect(offenders).toEqual([])
    const server = await read('src/web/server.ts')
    expect(server).toMatch(/session:message-queued'\) \{\n\s+for \(const key of \['queuedText', 'rowText', 'message'\]/)
    expect(await read('src/core/sessions/reference-cards.ts')).toContain('text: redactAiOnly(stripReferenceCards(')
    expect(await read('src/web/routes/session-chat.ts')).toContain('message: redactAiOnly(m.message)')
  })
})
