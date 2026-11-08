/**
 * A question card's live answer is the element its stored reply becomes
 * (2026-11-01, the user: streaming and finished must look exactly the same,
 * "no flash"). The live reply is drawn under its msgId in the same children
 * array as the turn's stored replies, so when the stored twin lands React keeps
 * that element: nothing inside it mounts again (a script block's iframe would
 * reload). SessionMessage is replaced by a stub that counts its mounts.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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
  StreamingBlockView: ({ block }: { block: { content?: string } }) => createElement('div', { 'data-live-answer': '' }, block.content),
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
  it('keeps the failed question and its recovery action, then answers the same round after retry', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const retry = vi.fn()
    const bubble = { ...user('q2'), queueId: 'temp-q2', status: 'failed' }
    const failedSend = (queueId: string) => createElement('button', { onClick: () => retry(queueId) }, 'Retry')
    await act(async () => {
      root.render(createElement(ThreadCardConversation, {
        ...base, streaming: false, turns: [{ user: user('q1'), replies: [stored('a1', 'Earlier answer.')] }],
        rounds: [{ bubble, live: { index: 1, block: { type: 'text', content: 'Unrelated answer.' } } }], failedSend,
      } as never))
    })
    const round = host.querySelector('[data-status="failed"]')!
    expect(round.querySelector('.thread-card-q')?.textContent).toContain('question q2')
    expect(round.textContent).not.toContain('Unrelated answer.')
    await act(async () => { (round.querySelector('button') as HTMLButtonElement).click() })
    expect(retry).toHaveBeenCalledExactlyOnceWith('temp-q2')
    await act(async () => {
      root.render(createElement(ThreadCardConversation, {
        ...base, turns: [], rounds: [{ bubble: { ...bubble, status: 'pending' }, live: { index: 2, block: { type: 'text', content: 'Retried answer.', msgId: 'retry-a2' } } }], failedSend,
      } as never))
    })
    expect(host.querySelector('button')).toBeNull()
    expect(host.querySelector('.thread-card-q')?.textContent).toContain('question q2')
    expect(host.querySelector('[data-status="pending"]')?.textContent).toContain('Retried answer.')
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('every question conversation uses the shared recovery action and keeps failed rounds', () => {
    const dir = join(__dirname, '../../web/src/components/sessions')
    const callers = readdirSync(dir).filter((name) => name.endsWith('.tsx'))
      .map((name) => ({ name, src: readFileSync(join(dir, name), 'utf8') }))
      .filter(({ src }) => /<ThreadCardConversation\b/.test(src))
    expect(callers.map(({ name }) => name)).toEqual(['SessionChatHistory.tsx'])
    for (const { src } of callers) {
      expect(src).toContain('failedSend={(queueId) =>')
      expect(src).toContain('return m ? failedSend(m) : null')
      expect(src).toContain('{failedSend(m)}')
      const builder = src.slice(src.indexOf('const seqByKey ='), src.indexOf('reviewBodyRef.current = conversationFor'))
      expect(builder).not.toMatch(/(?:msg|m)\.status\s*!==\s*'failed'\s*&&/)
      expect(src).toContain('latestUnsentRows(threadTree, optimisticMessages ?? [], localSendOrder)')
      expect(src).toContain('const unsent: string[] = JSON.parse(unsentSig)')
      expect(src).toContain('queued, unsent, streamingKey')
      expect(src).toMatch(/const isResuming[\s\S]{0,200}deduped\.some\(\(m\) => m\.status !== 'failed'\)/)
      expect(src).toContain("const last = rounds.filter((r) => r.bubble.status !== 'failed').at(-1)")
      expect(src).toContain('const text = last ? last.live : lead')
      expect(src).toContain('item.msg.failedError, item.msg.parked')
    }
  })

  it('every file question rail reads the shared live status map', () => {
    const dir = join(__dirname, '../../web/src/components')
    const walk = (at: string): Array<{ name: string; src: string }> => readdirSync(at, { withFileTypes: true }).flatMap((entry) => {
      const file = join(at, entry.name)
      return entry.isDirectory() ? walk(file) : entry.name.endsWith('.tsx') ? [{ name: entry.name, src: readFileSync(file, 'utf8') }] : []
    })
    const callers = walk(dir).filter(({ src }) => /fileQuestionRows\(/.test(src))
    expect(callers.map(({ name }) => name)).toEqual(['FileThreadLayer.tsx'])
    for (const { src } of callers) {
      expect(src).toMatch(/fileQuestionRows\([^;]*threads\.derived\.live\)/)
      expect(src).toMatch(/\[threads\.tree[^\]]*threads\.derived\.live\]/)
    }
  })

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
