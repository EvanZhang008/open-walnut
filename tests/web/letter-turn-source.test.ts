/**
 * LetterThread's TurnBody routes each turn's paths by whose words they are: the sender's turn
 * keeps its saved source, a person's rich turn uses the primary, and a turn a task's session
 * wrote in the user's place (`entry.by`) opens on that session's host, plain and rich alike.
 * Routing unit only (the renderers and the opener are stubs); the real UI is checked elsewhere.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

type Props = Record<string, any>
const h = vi.hoisted(() => ({
  sources: [] as unknown[],
  peerOpen: vi.fn(),
  agentText: [] as Props[],
  letterBody: [] as Props[],
  linkified: [] as Props[],
  openAgentRef: vi.fn(),
}))
// The opener is stubbed: it records the source a turn asked for and hands back a spied opener.
vi.mock('@/hooks/useAgentFileOpener', () => ({
  useAgentFileOpener: (src: unknown) => {
    h.sources.push(src)
    return src ? { onFileOpen: h.peerOpen, refusesAll: !!(src as Props).unknownSource, render: { images: true } } : { render: { images: true } }
  },
}))
// The shared handler is stubbed to a tagged function, so a test can tell which one a renderer got.
vi.mock('@/hooks/useEntityClickHandler', () => ({
  useEntityClickHandler: (...args: unknown[]) => Object.assign(() => {}, { args }),
}))
vi.mock('@/components/common/AgentText', () => ({ AgentText: (p: Props) => { h.agentText.push(p); return null } }))
vi.mock('@/components/common/LinkifiedText', () => ({ LinkifiedText: (p: Props) => { h.linkified.push(p); return null } }))
vi.mock('../../web/src/components/inbox/LetterBody', () => ({ LetterBody: (p: Props) => { h.letterBody.push(p); return null } }))
vi.mock('../../web/src/components/inbox/EmailItems', () => ({ EmailItems: () => null }))
vi.mock('@/utils/agent-ref-open', () => ({ openAgentRef: h.openAgentRef }))
vi.mock('@/contexts/notifications', () => ({ formatRelative: () => 'just now' }))
vi.mock('@/api/human-inbox', () => ({ answeredByName: () => 'A task' }))

import { LetterThread } from '../../web/src/components/inbox/LetterThread'

const SENDER = { host: 'devbox', sessionId: 'sender-sid' }
const turn = (over: Props) => ({ at: 1, text: 'see /home/me/a.ts', body: '# see /home/me/a.ts', bodyFormat: 'markdown', ...over })

describe('a letter turn opens its paths on the host of whoever wrote it', () => {
  let doc: Document
  let root: { render: (el: unknown) => void; unmount: () => void } | null = null
  const onBodyClick = vi.fn()
  const onRefOpen = vi.fn()
  const onNavigate = vi.fn()

  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    doc = dom.document as unknown as Document
  })
  beforeEach(() => {
    h.sources.length = 0; h.agentText.length = 0; h.letterBody.length = 0; h.linkified.length = 0
    h.peerOpen.mockReset(); h.openAgentRef.mockReset(); onNavigate.mockReset()
  })
  afterEach(async () => { if (root) await act(async () => { root!.unmount() }); root = null })

  async function show(entry: Props, sender: Props | undefined = SENDER) {
    const el = doc.createElement('div')
    doc.body.appendChild(el)
    root = createRoot(el as unknown as Element) as unknown as typeof root
    await act(async () => {
      root!.render(createElement(LetterThread, { entries: [entry], letterId: 'lt-a-b', subject: 'S', sender, onBodyClick, onRefOpen, onNavigate } as never))
    })
  }

  it('an older agent turn stays unknown, including relative links, never borrowing the envelope', async () => {
    await show(turn({ from: 'agent' }))
    expect(h.sources).toContainEqual({ unknownSource: true })
    const text = h.agentText[0]!
    expect(text).toMatchObject({ host: undefined, sessionId: undefined, unknownSource: true })
    expect(text.onClick).not.toBe(onBodyClick)
    expect(text.onClick.args[1]).toBe(h.peerOpen)
    expect(text.onClick.args[4]).toBe(true)
    expect(h.letterBody[0]).toMatchObject({ source: { unknownSource: true } })
    expect(h.letterBody[0]!.onClick).toBe(text.onClick)
    expect(h.letterBody[0]!.onRefOpen).not.toBe(onRefOpen)
  })

  it('an agent turn names its saved writer even when it is the envelope sender', async () => {
    await show(turn({ from: 'agent', sender: SENDER }))
    expect(h.sources).toContainEqual(SENDER)
    const text = h.agentText[0]!
    expect(text).toMatchObject({ host: 'devbox', sessionId: 'sender-sid' })
    expect(text.onClick).not.toBe(onBodyClick)
    expect(h.letterBody[0]).toMatchObject({ source: SENDER })
    expect(h.letterBody[0]!.onClick).toBe(text.onClick)
    expect(h.letterBody[0]!.onRefOpen).not.toBe(onRefOpen)
  })

  it("a task answering as the sender's own session is the sender", async () => {
    await show(turn({ from: 'human', by: { sessionId: 'sender-sid' } }))
    expect(h.agentText[0]!.onClick).toBe(onBodyClick)
    expect(h.letterBody[0]!.onRefOpen).toBe(onRefOpen)
    expect(h.linkified).toEqual([])
  })

  it.each([undefined, { sessionId: '   ' }])("a person's plain turn stays literal and its rich paths use the primary (by: %j)", async (by) => {
    await show(turn({ from: 'human', by }))
    expect(h.linkified[0]).toMatchObject({ text: 'see /home/me/a.ts' })
    expect(h.agentText).toEqual([])
    expect(h.sources).toContainEqual({ host: '__local__' })
    expect(h.letterBody[0]!.source).toEqual({ host: '__local__' })
    expect(h.letterBody[0]!.onClick).not.toBe(onBodyClick)
    h.letterBody[0]!.onRefOpen({ kind: 'file', path: '/repo/own.txt' })
    expect(h.peerOpen).toHaveBeenCalledExactlyOnceWith('/repo/own.txt', undefined, undefined, undefined)
  })

  it("a turn another task's session wrote opens on that session, never the sender's host", async () => {
    await show(turn({ from: 'human', by: { sessionId: ' peer-sid ' } }))
    expect(h.sources).toContainEqual({ sessionId: 'peer-sid' })
    const text = h.agentText[0]!
    expect(text).toMatchObject({ sessionId: 'peer-sid', host: undefined })
    // Plain and rich share one click handler, built on the peer's opener.
    expect(text.onClick).not.toBe(onBodyClick)
    expect(text.onClick.args[1]).toBe(h.peerOpen)
    expect(h.letterBody[0]!.onClick).toBe(text.onClick)
    expect(h.letterBody[0]).toMatchObject({ source: { sessionId: 'peer-sid' } })
    // The shared handler keeps the letter's session navigation; a task pill is the one task open.
    text.onClick.args[0]('s9')
    expect(onNavigate.mock.calls).toEqual([['/sessions?id=s9']])
  })

  it("a peer turn's HTML references: a file goes to the peer's opener, the rest open as before", async () => {
    await show(turn({ from: 'human', by: { sessionId: 'peer-sid' }, bodyFormat: 'html' }))
    const refOpen = h.letterBody[0]!.onRefOpen
    expect(refOpen).not.toBe(onRefOpen)
    refOpen({ kind: 'file', path: '/home/me/a.ts', line: 10, endLine: 20 })
    expect(h.peerOpen).toHaveBeenCalledExactlyOnceWith('/home/me/a.ts', 10, undefined, 20)
    const task = { kind: 'task', id: 't1' }
    const letter = { kind: 'letter', id: 'lt-a-b' }
    refOpen(task)
    refOpen(letter)
    expect(h.openAgentRef.mock.calls).toEqual([[task, onNavigate], [letter, onNavigate]])
    expect(onRefOpen).not.toHaveBeenCalled()
  })
})
