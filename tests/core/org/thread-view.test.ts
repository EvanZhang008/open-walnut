/**
 * How a thread reads (src/core/org/thread-view.ts): its conversation, numbered, what the user
 * already knows folded to one line of context. The shape of the user's own case (2026-11-01, a
 * lead's thread of five messages, two pairs of them answered at once): it reads as the last
 * exchange with one line of context, not five blocks.
 */
import { describe, it, expect } from 'vitest'
import { exchangesOf, threadView, unreactedAnswers, type ViewMessage, type ViewThread } from '../../../src/core/org/thread-view.js'

const at = (min: number, sec = 0) => new Date(Date.UTC(2026, 10, 1, 4, min, sec)).toISOString()
const msg = (id: string, min: number, text: string, answer?: { min: number; text: string }): ViewMessage => ({
  id, at: at(min), text, ...(answer ? { answer: { at: at(answer.min), text: answer.text } } : {}),
})

/** Five asks: 1 answered alone; 2 and 3 answered by one reply; 4 and 5 by one more. */
function fiveAsks(): ViewThread {
  return {
    messages: [
      msg('tm-1', 24, 'what is the small model?', { min: 25, text: 'It is the fast model in the local config.' }),
      msg('tm-2', 25.5, 'who asked you to do this?', { min: 28, text: 'Nobody. I stopped it all.' }),
      msg('tm-3', 26, 'do not do this, why?', { min: 28, text: 'Nobody. I stopped it all.' }),
      msg('tm-4', 28.5, 'which part of Walnut, the titles?', { min: 30, text: 'Every small background job.' }),
      msg('tm-5', 29, 'this is the same thread, why split it?', { min: 30, text: 'Every small background job.' }),
    ],
  }
}

describe('a thread as its conversation', () => {
  it('groups the messages one reply answered, numbered by message', () => {
    const xs = exchangesOf(fiveAsks())
    expect(xs.map((x) => [x.n, x.messages.map((m) => m.id)])).toEqual([[1, ['tm-1']], [2, ['tm-2', 'tm-3']], [4, ['tm-4', 'tm-5']]])
    expect(xs.map((x) => x.answer?.text)).toEqual(['It is the fast model in the local config.', 'Nobody. I stopped it all.', 'Every small background job.'])
  })

  it('he wrote after the first two answers, not after the last: two fold to context, the last reads in full', () => {
    const v = threadView(fiveAsks())
    expect(v.exchanges.map((x) => x.known)).toEqual([true, true, false])
    expect(v.folded).toBe(2)
    expect(unreactedAnswers(fiveAsks())).toBe(1)
  })

  it('an answer that came after his next message was news when he wrote it: it does not fold', () => {
    const t: ViewThread = { messages: [msg('tm-1', 1, 'a', { min: 5, text: 'A' }), msg('tm-2', 2, 'b', { min: 6, text: 'B' })] }
    const v = threadView(t)
    expect(v.exchanges.map((x) => x.known)).toEqual([false, false])
    expect(v.folded).toBe(0)
  })

  it('messages still waiting read together at the end, never as known', () => {
    const t: ViewThread = { messages: [msg('tm-1', 1, 'a', { min: 2, text: 'A' }), msg('tm-2', 3, 'b'), msg('tm-3', 4, 'c')] }
    const xs = exchangesOf(t)
    expect(xs.map((x) => [x.n, x.messages.length, !!x.answer, x.known])).toEqual([[1, 1, true, true], [2, 2, false, false]])
    expect(threadView(t).folded).toBe(1)
  })

  it('the node\'s known mark, or his Acknowledge, folds the rest; the last exchange still reads in full', () => {
    const marked = threadView({ ...fiveAsks(), known: { through: 'tm-5' } })
    expect(marked.exchanges.every((x) => x.known)).toBe(true)
    expect(marked.folded).toBe(2)
    const acked = threadView({ ...fiveAsks(), closed: { by: 'human' } })
    expect(acked.exchanges.every((x) => x.known)).toBe(true)
    // A close by the node is not his Acknowledge.
    expect(threadView({ ...fiveAsks(), closed: { by: 'task:lead-1' } }).exchanges[2].known).toBe(false)
  })

  it('one message, or none answered: nothing folds', () => {
    expect(threadView({ messages: [msg('tm-1', 1, 'a')] }).folded).toBe(0)
    expect(threadView({ messages: [msg('tm-1', 1, 'a', { min: 2, text: 'A' })] }).folded).toBe(0)
    expect(threadView({ messages: [] }).exchanges).toEqual([])
  })

  it('a thread the node opened starts with its post (number 0), known once he wrote after it', () => {
    const opener = { text: 'A mail he must answer', at: at(0), from: 'mail' }
    const fresh = threadView({ messages: [], opener })
    expect(fresh.exchanges).toEqual([{ n: 0, messages: [], opener, known: false }])
    const replied = threadView({ messages: [msg('tm-1', 3, 'confirm it', { min: 4, text: 'Done' })], opener })
    expect(replied.exchanges.map((x) => [x.n, x.known])).toEqual([[0, true], [1, false]])
    expect(replied.folded).toBe(1)
  })
})
