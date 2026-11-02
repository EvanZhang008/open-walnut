/**
 * A question card's live answer is the element its stored reply becomes
 * (2026-11-01, the user: streaming and finished must look exactly the same,
 * "no flash"). The live reply is drawn under its msgId in the same children
 * array as the turn's stored replies, so when the stored twin lands React keeps
 * that element: nothing inside it mounts again (a script block's iframe would
 * reload). SessionMessage is replaced by a stub that counts its mounts.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act, useEffect } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const mounts: string[] = []

vi.mock('../../web/src/components/sessions/SessionMessage', () => ({
  SessionMessage: ({ message }: { message: { msgId?: string; text?: string } }) => {
    useEffect(() => { mounts.push(message.msgId ?? '?') }, [])
    return createElement('div', { 'data-reply': message.msgId }, message.text)
  },
  StableMarkdownBody: ({ text }: { text: string }) => createElement('div', null, text),
}))
vi.mock('../../web/src/components/sessions/StreamingBlockView', () => ({
  StreamingBlockView: () => createElement('div', { 'data-live-answer': '' }),
  StreamingReplyMeta: () => null,
  useStreamReplyRows: () => (block: { content: string }, msgId: string) => ({ role: 'assistant', text: block.content, msgId, timestamp: 't' }),
}))

const { ThreadCardConversation } = await import('../../web/src/components/sessions/ThreadCardConversation')

beforeAll(() => {
  const { window } = parseHTML('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
})

const user = (id: string) => ({ role: 'user', text: `question ${id}`, msgId: id, timestamp: 't' })
const stored = (id: string, text: string) => ({ role: 'assistant', text, msgId: id, timestamp: 't' })
const base = { lastLive: false, rounds: [], streaming: true, empty: false, sessionId: 's' }

describe('the question card hands its live answer over in place', () => {
  it('the stored reply takes over the live reply element: nothing mounts again', async () => {
    mounts.length = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const live = { index: 3, block: { type: 'text', content: 'The answer.', msgId: 'a2' } }
    await act(async () => {
      root.render(createElement(ThreadCardConversation, {
        ...base, lastLive: true, live,
        turns: [{ user: user('q1'), replies: [stored('a1', 'First.')] }, { user: user('q2'), replies: [] }],
      } as never))
    })
    expect(mounts).toEqual(['a1', 'a2'])
    expect(host.querySelector('[data-live-answer]')).toBeNull()
    const liveEl = host.querySelector('[data-reply="a2"]')
    await act(async () => {
      root.render(createElement(ThreadCardConversation, {
        ...base, streaming: false,
        turns: [{ user: user('q1'), replies: [stored('a1', 'First.')] }, { user: user('q2'), replies: [stored('a2', 'The answer.')] }],
      } as never))
    })
    expect(mounts, 'a reply mounted again at the handover').toEqual(['a1', 'a2'])
    expect(host.querySelector('[data-reply="a2"]')).toBe(liveEl)
    await act(async () => { root.unmount() })
  })

  it('an earlier turn with no answer still says so while the newest one streams', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(createElement(ThreadCardConversation, {
        ...base, lastLive: true, live: { index: 1, block: { type: 'text', content: 'Live.', msgId: 'a2' } },
        turns: [{ user: user('q1'), replies: [] }, { user: user('q2'), replies: [] }],
      } as never))
    })
    expect(host.querySelectorAll('.thread-card-noanswer').length).toBe(1)
    expect(host.querySelectorAll('.thread-card-turn')[0].querySelector('.thread-card-noanswer')).not.toBeNull()
    await act(async () => { root.unmount() })
  })
})
