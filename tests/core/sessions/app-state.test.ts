/**
 * App state (src/core/sessions/app-state.ts): a plugin App shares what it shows
 * with the AI working on a task. Passive: the next message into the session
 * carries what changed since that session last read it, in the same row.
 * Proactive: the note also starts a turn of its own, debounced and spaced.
 *
 * Against the REAL task store, session registry and queue in an isolated home,
 * through sendMessageToSession, the one function every send passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-app-state'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask, updateTask } from '../../../src/core/task-manager.js'
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js'
import { sendMessageToSession, getQueue, resetCache } from '../../../src/core/session-message-queue.js'
import {
  publishAppState, clearAppState, disposeAppStateOwner, readAppState, deliverProactive, pendingAppState,
  resetAppStateForTesting, MAX_STATE_BYTES, PROACTIVE_DEBOUNCE_MS, PROACTIVE_MIN_GAP_MS,
} from '../../../src/core/sessions/app-state.js'
import { parseSessionEnvelopes } from '../../../src/lib/history-session-envelope.js'

const PLUGIN = 'interview-practice'
const NAME = 'Interview Practice'
const code = (n: number, edit?: { line: number; text: string }) =>
  Array.from({ length: n }, (_, i) => (edit && edit.line === i ? edit.text : `    step(${i})`)).join('\n')

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  resetCache()
  resetAppStateForTesting()
})
afterEach(() => {
  vi.useRealTimers()
  resetAppStateForTesting()
})

async function spawned(sid?: string) {
  const { task } = await addTask({ title: 'Mock interview: Merge Intervals', project: 'Interview Practice' })
  const id = sid ?? `sid-${task.id}`
  await createSessionRecord(id, task.id, task.project ?? '', '/tmp/ws/merge-intervals', { title: task.title })
  // Markdown: the reply-style directive is not the subject here.
  await updateSessionRecord(id, { output_mode: 'markdown' })
  return { task, sid: id }
}
const rows = async (sid: string) => (await getQueue(sid)).map((m) => m.message)
const publish = (taskId: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  publishAppState(PLUGIN, NAME, { taskId, state, ...extra })

describe('passive app state rides the next message', () => {
  it('nothing published: the message goes as typed', async () => {
    const { sid } = await spawned()
    await sendMessageToSession(sid, 'hello', { source: 'ui' })
    expect(await rows(sid)).toEqual(['hello'])
  })

  it('first the whole state, then nothing while nothing changed, then only what changed', async () => {
    const { task, sid } = await spawned()
    const before = code(120)
    expect(await publish(task.id, { level: 1, lastRun: { passed: 3, total: 7 }, files: { 'solution.py': before } }, {
      note: 'The pattern is left out on purpose.',
    })).toMatchObject({ kept: true })

    await sendMessageToSession(sid, 'what do you think so far?', { source: 'ui' })
    const [first] = await rows(sid)
    expect(first).toMatch(/^<walnut-message kind="app-state" from="Interview Practice" title="current state" about-task="[^"]+"/)
    expect(first).toContain('The pattern is left out on purpose.')
    expect(first).toContain('note="automated app state, background only"')
    expect(first).toContain('Background, not a request.')
    expect(first).toContain('lastRun:\n  passed: 3\n  total: 7')
    expect(first).toContain('    step(119)')
    expect(first.endsWith('\n\nwhat do you think so far?')).toBe(true)

    // The parser the web and history use reads it as one app-state card, then the text.
    const segments = parseSessionEnvelopes(first)!
    expect(segments[0]).toMatchObject({ kind: 'envelope', envelope: { kind: 'app-state', title: 'current state', peer: { title: NAME, taskId: task.id } } })
    expect(segments[segments.length - 1]).toMatchObject({ kind: 'text' })

    await sendMessageToSession(sid, 'and now?', { source: 'ui' })
    expect((await rows(sid))[1]).toBe('and now?')

    // Typing in the editor publishes many times; only the latest goes, as a diff.
    await publish(task.id, { level: 1, lastRun: { passed: 3, total: 7 }, files: { 'solution.py': code(120, { line: 60, text: '    step(60) # half' }) } })
    await publish(task.id, { level: 2, lastRun: { passed: 7, total: 7 }, files: { 'solution.py': code(120, { line: 60, text: '    fixed(60)' }) } })
    await sendMessageToSession(sid, 'better?', { source: 'ui' })
    const third = (await rows(sid))[2]
    expect(third).toContain('title="3 changes"')
    expect(third).toContain('level: 1 → 2')
    expect(third).toContain('lastRun.passed: 3 → 7')
    expect(third).toContain('files["solution.py"]: changed')
    expect(third).toContain('-    step(60)')
    expect(third).toContain('+    fixed(60)')
    expect(third).not.toContain('step(10)')
    expect(third).not.toContain('half')
    expect(third.length).toBeLessThan(1_000)
  })

  it('any message carries it, a peer or a trigger too; a slash command goes raw and leaves it for the next', async () => {
    const { task, sid } = await spawned()
    await publish(task.id, { level: 1 })
    await sendMessageToSession(sid, '/compact', { source: 'ui' })
    expect((await rows(sid))[0]).toBe('/compact')
    await sendMessageToSession(sid, 'peer says hi', { source: 'peer' })
    expect((await rows(sid))[1]).toMatch(/^<walnut-message kind="app-state"[\s\S]*\n\npeer says hi$/)
  })

  it('what a session was told is its own: another session, or a compaction, starts from the whole state', async () => {
    const { task, sid } = await spawned()
    const other = await spawned()
    await publish(task.id, { level: 1 })
    await publish(other.task.id, { level: 1 })
    await sendMessageToSession(sid, 'one', { source: 'ui' })
    await publish(task.id, { level: 2 })
    // Told about its own task only: the other session still starts from the whole state.
    await sendMessageToSession(other.sid, 'hello', { source: 'ui' })
    expect((await rows(other.sid))[0]).toContain('title="current state"')

    await updateSessionRecord(sid, { lastCompactUuid: 'boundary-1' })
    await sendMessageToSession(sid, 'after compaction', { source: 'ui' })
    expect((await rows(sid))[1]).toContain('title="current state"')
    expect((await rows(sid))[1]).toContain('level: 2')
  })

  it('two racing sends carry the note once', async () => {
    const { task, sid } = await spawned()
    await publish(task.id, { level: 1 })
    await Promise.all([
      sendMessageToSession(sid, 'a', { source: 'ui' }),
      sendMessageToSession(sid, 'b', { source: 'mobile' }),
    ])
    const all = await rows(sid)
    expect(all.filter((m) => m.includes('kind="app-state"'))).toHaveLength(1)
  })

  it('a send that fails before it queues gives the note back for the next one', async () => {
    const { task, sid } = await spawned()
    await publish(task.id, { level: 1 })
    const pending = await pendingAppState(sid, 'x')
    expect(pending).not.toBeNull()
    // Claimed: a second send meanwhile carries nothing.
    expect(await pendingAppState(sid, 'y')).toBeNull()
    pending!.release()
    await sendMessageToSession(sid, 'retry', { source: 'ui' })
    expect((await rows(sid))[0]).toContain('kind="app-state"')
  })

  it('app_state reads the whole state and counts as told', async () => {
    const { task, sid } = await spawned()
    await publish(task.id, { level: 1, files: { 'a.py': 'x = 1' } })
    const read = await readAppState(sid)
    expect(read).toMatchObject({ taskId: task.id, states: [{ plugin: PLUGIN, label: NAME, state: { level: 1, files: { 'a.py': 'x = 1' } } }] })
    await sendMessageToSession(sid, 'ok', { source: 'ui' })
    expect((await rows(sid))[0]).toBe('ok')
    await publish(task.id, { level: 2, files: { 'a.py': 'x = 1' } })
    await sendMessageToSession(sid, 'and?', { source: 'ui' })
    expect((await rows(sid))[1]).toContain('level: 1 → 2')
    expect(await readAppState(undefined)).toEqual({ taskId: null, states: [] })
  })

  it('clear, and a plugin generation going away, stop it; a newer generation keeps its own', async () => {
    const { task, sid } = await spawned()
    const other = await spawned(`sid-other`)
    await publishAppState(PLUGIN, NAME, { taskId: task.id, state: { a: 1 } }, { generation: `${PLUGIN}#1` })
    await publishAppState(PLUGIN, NAME, { taskId: other.task.id, state: { b: 1 } }, { generation: `${PLUGIN}#2` })
    disposeAppStateOwner(PLUGIN, `${PLUGIN}#1`)
    await sendMessageToSession(sid, 'gone', { source: 'ui' })
    expect((await rows(sid))[0]).toBe('gone')
    await sendMessageToSession(other.sid, 'kept', { source: 'ui' })
    expect((await rows(other.sid))[0]).toContain('kind="app-state"')

    // The App in the browser publishes with no generation: any generation's teardown takes it.
    await publish(task.id, { c: 1 })
    disposeAppStateOwner(PLUGIN, `${PLUGIN}#9`)
    await sendMessageToSession(sid, 'browser state gone', { source: 'ui' })
    expect((await rows(sid))[1]).toBe('browser state gone')

    await publish(other.task.id, { b: 2 })
    clearAppState(PLUGIN, other.task.id)
    await sendMessageToSession(other.sid, 'cleared', { source: 'ui' })
    expect((await rows(other.sid))[1]).toBe('cleared')
  })

  it('refuses what it cannot keep: an unknown task, a non-object, a bad mode, more than 64 KB', async () => {
    const { task } = await spawned()
    await expect(publish('mt-nope', { a: 1 })).rejects.toThrow('No task mt-nope')
    await expect(publish(task.id, [] as unknown as Record<string, unknown>)).rejects.toThrow('plain object')
    await expect(publish(task.id, { a: 1 }, { mode: 'loud' })).rejects.toThrow('passive or proactive')
    await expect(publish(task.id, { big: 'x'.repeat(MAX_STATE_BYTES) })).rejects.toThrow(RangeError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(publish(task.id, cyclic)).rejects.toThrow('must be JSON')
  })

  it('a state too long for one note names the keys and points at app_state', async () => {
    const { task, sid } = await spawned()
    await publish(task.id, { files: { 'big.py': code(1_500) } })
    await sendMessageToSession(sid, 'look', { source: 'ui' })
    const [row] = await rows(sid)
    expect(row).toContain('too long to show here (keys: files)')
    expect(row).toContain('walnut tools call app_state')
    expect(row.length).toBeLessThan(2_000)
  })
})

describe('proactive app state starts a turn', () => {
  it('delivers the note alone, as source app-state, into the task conversation', async () => {
    const { task, sid } = await spawned()
    await publish(task.id, { finished: true })
    expect(await deliverProactive(task.id, PLUGIN)).toBe('sent')
    const [row] = await rows(sid)
    expect(row).toMatch(/^<walnut-message kind="app-state"[\s\S]*<\/walnut-message>$/)
    // It starts a turn, so it does not call itself background.
    expect(row).toContain('note="automated app state, sent by the App"')
    expect(row).toContain('The App sent this on its own')
    expect(row).not.toContain('Background, not a request')
    // Told: nothing more to send, and the next human message goes as typed.
    expect(await deliverProactive(task.id, PLUGIN)).toBe('skipped')
    await sendMessageToSession(sid, 'thanks', { source: 'ui' })
    expect((await rows(sid))[1]).toBe('thanks')
  })

  it('a finished task gets no turn', async () => {
    const { task, sid } = await spawned()
    await publish(task.id, { finished: true })
    await updateTask(task.id, { phase: 'COMPLETE' })
    expect(await deliverProactive(task.id, PLUGIN)).toBe('skipped')
    expect(await rows(sid)).toEqual([])
  })

  it('debounced, and spaced a minute apart; a burst sends its latest state once', async () => {
    const { task, sid } = await spawned()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const settle = async (want: number) => {
      for (let i = 0; i < 400 && (await rows(sid)).length < want; i++) await new Promise((r) => setImmediate(r))
    }
    await publish(task.id, { run: 1 }, { mode: 'proactive' })
    await publish(task.id, { run: 2 }, { mode: 'proactive' })
    await vi.advanceTimersByTimeAsync(PROACTIVE_DEBOUNCE_MS - 10)
    expect(await rows(sid)).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    await settle(1)
    const first = await rows(sid)
    expect(first).toHaveLength(1)
    expect(first[0]).toContain('run: 2')

    await publish(task.id, { run: 3 }, { mode: 'proactive' })
    await vi.advanceTimersByTimeAsync(PROACTIVE_DEBOUNCE_MS + 100)
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r))
    expect(await rows(sid)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PROACTIVE_MIN_GAP_MS)
    await settle(2)
    const second = await rows(sid)
    expect(second).toHaveLength(2)
    expect(second[1]).toContain('run: 2 → 3')
    expect(second[1]).toContain('The App sent this on its own')
  })
})
