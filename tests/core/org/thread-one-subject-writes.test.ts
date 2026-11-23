/**
 * The writes behind "one subject is one thread, and its card reads alone" (2026-11-23):
 * - his bare reaction ("Done") goes to the thread of the node's newest answer, never a new thread
 *   (on his data his "Done" became a third thread of one issue);
 * - a node's summary that only says the answer was given elsewhere is refused (thread_update) or
 *   left out (a status line), so his card never reads "the summary was given to you".
 * Chinese test data is written with \u escapes.
 */
import { describe, expect, it } from 'vitest'
import { emptyThreads, fileMessage, isPlainReaction, SAME_CONVERSATION_MS, ThreadError, updateThread } from '../../../src/core/org/threads-model.js'
import { patchForLine } from '../../../src/core/sessions/status-threads.js'

const T0 = Date.UTC(2026, 10, 23, 6, 0)
const at = (ms: number) => new Date(T0 + ms).toISOString()
const MIN = 60_000
const NODE = 'task:node-1' as const
// "the stand-up summary for yesterday and today was given to you."
const POINTER = '\u6628\u5929\u548c\u4eca\u5929\u7684\u7ad9\u4f1a\u603b\u7ed3\u5df2\u7ed9\u4f60\u3002'

function answered() {
  const asked = fileMessage(emptyThreads('n'), { text: 'where is the cluster update task?', via: 'chat', at: at(0) })
  const file = updateThread(asked.file, asked.thread.id, { state: 'answered', reply: 'The cluster update work is task "Cluster version upgrade": 3 of 5 regions done.' }, NODE, at(5 * MIN)).file
  return { file, id: asked.thread.id }
}

describe('his bare reaction', () => {
  it('goes under the thread of the newest answer, an hour later too', () => {
    const { file, id } = answered()
    const r = fileMessage(file, { text: 'Done', via: 'chat', at: at(60 * MIN), joinRecent: SAME_CONVERSATION_MS })
    expect(r.created).toBe(false)
    expect(r.thread.id).toBe(id)
    expect(r.file.threads).toHaveLength(1)
  })

  it('goes to the thread of the newest word of the node whatever its state, and moves no state', () => {
    const { file, id: older } = answered()
    // A later ask, answered "on it" (working): his "ok" is about that one, not the older answered thread.
    const asked = fileMessage(file, { text: 'also rotate the logs on the build box', via: 'chat', at: at(60 * MIN) })
    const onIt = updateThread(asked.file, asked.thread.id, { state: 'working', reply: 'Rotating the logs on the build box now: about 10 minutes.' }, NODE, at(61 * MIN)).file
    const r = fileMessage(onIt, { text: 'ok', via: 'chat', at: at(70 * MIN), joinRecent: SAME_CONVERSATION_MS })
    expect(r.thread.id).toBe(asked.thread.id)
    expect(r.thread.state).toBe('working')
    expect(r.file.threads.find((t) => t.id === older)!.state).toBe('answered')
    // On an answered thread his "ok" keeps it answered (and in his sight until he acknowledges it).
    const done = fileMessage(file, { text: 'thanks', via: 'chat', at: at(70 * MIN), joinRecent: SAME_CONVERSATION_MS })
    expect(done.thread.id).toBe(older)
    expect(done.thread.state).toBe('answered')
  })

  it('a message with a subject of its own is still a new thread', () => {
    const { file } = answered()
    const r = fileMessage(file, { text: 'also check the dashboard colors', via: 'chat', at: at(60 * MIN), joinRecent: SAME_CONVERSATION_MS })
    expect(r.created).toBe(true)
  })

  it('with no answer for him to react to, it is its own thread', () => {
    const asked = fileMessage(emptyThreads('n'), { text: 'where is the cluster update task?', via: 'chat', at: at(0) })
    const r = fileMessage(asked.file, { text: 'thanks', via: 'chat', at: at(60 * MIN), joinRecent: SAME_CONVERSATION_MS })
    expect(r.created).toBe(true)
  })

  it.each(['Done', 'ok, thanks', 'Thanks!', '\u597d\u7684', '\u6536\u5230\uff0c\u8c22\u8c22', '\ud83d\udc4d'])('reads %s as a bare reaction', (text) => {
    expect(isPlainReaction(text)).toBe(true)
  })
  it.each(['Done? not yet', 'ok but why is it slow', 'thanks, now do the iOS side'])('reads %s as more than a reaction', (text) => {
    expect(isPlainReaction(text)).toBe(false)
  })
})

describe('a summary that only says it was given elsewhere', () => {
  it('is refused from a node, with what to write instead', () => {
    const { file, id } = answered()
    let err: unknown
    try { updateThread(file, id, { reply: POINTER }, NODE, at(70 * MIN)) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ThreadError)
    expect((err as ThreadError).message).toMatch(/write the answer itself/)
  })

  it('his own words and a status line are not refused there', () => {
    const { file, id } = answered()
    expect(() => updateThread(file, id, { reply: POINTER }, 'human', at(70 * MIN))).not.toThrow()
    expect(() => updateThread(file, id, { reply: POINTER }, NODE, at(70 * MIN), undefined, { line: true })).not.toThrow()
  })

  it('a path or link of his given back as proof is no repeat', () => {
    const { file, id } = answered()
    const asked = fileMessage(file, { text: 'fix the bug in the login page where the button overlaps the header text, look at /tmp/shots/login-overlap-header-button-2026-11-23.png please', via: 'follow-up', threadId: id, at: at(80 * MIN) })
    expect(() => updateThread(asked.file, id, { reply: 'Fixed the overlap: /tmp/shots/login-overlap-header-button-2026-11-23.png now shows the button below the header.' }, NODE, at(90 * MIN))).not.toThrow()
    expect(() => updateThread(asked.file, id, { reply: 'Fixed the login page where the button overlaps the header text: a CSS z-index, live now.' }, NODE, at(90 * MIN))).not.toThrow()
  })

  it('a summary that says his own message back is refused, a short phrase of his is not', () => {
    const { file, id } = answered()
    const asked = fileMessage(file, { text: 'What is going on with the deploy, is it blocked or what, they deploy it themselves I think, can you look into it', via: 'follow-up', threadId: id, at: at(80 * MIN) })
    const quoting = 'You said: "What is going on with the deploy, is it blocked or what, they deploy it themselves I think". Since then I checked.'
    expect(() => updateThread(asked.file, id, { reply: quoting }, NODE, at(90 * MIN))).toThrow(/repeats the user's own message/)
    expect(() => updateThread(asked.file, id, { reply: 'The deploy is blocked on a failed health check since 11-19; the owning team retries it Monday.' }, NODE, at(90 * MIN))).not.toThrow()
  })

  it('a status line with such words keeps the card as it was, its state too', () => {
    const { file, id } = answered()
    const t = file.threads.find((x) => x.id === id)!
    // Review 2026-11-23: moving it into his sight with its older summary was worse than waiting for the next line.
    expect(patchForLine({ ...t, state: 'working' }, { id, title: t.title, state: 'answered', progress: POINTER })).toBeNull()
  })
})
