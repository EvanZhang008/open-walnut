/**
 * The Personal AI chat (ChatMessage) records no writer for its words, so they are unknown agent text.
 *
 * The chat's reply body (MemoizedTextBlock's RichMarkdown and SuggestSegments, the
 * legacy no-blocks path), its tool results (renderToolResultWithRefs, the global default renderer)
 * and its compaction summary all rendered with no host: a bare image path drew a same-named picture
 * from this machine, and a click opened a local FileViewer of its own on this machine's file. The
 * class is "every slot of a chat row that draws agent text": each takes the row's writer
 * (`textSource`, unknown when absent, never the route's target session) through
 * useAgentFileOpener, so an unknown writer reads no file and loads no picture until a machine is
 * chosen, and a writer the surface names opens and draws there.
 *
 * Fails when:
 *  - a mounted chat row loads a picture or reads a session record for an unknown writer, or a
 *    click on one of its paths opens anything but the shared "choose a machine" viewer;
 *  - a named writer's pictures or clicks go to another machine than its own;
 *  - tool results lose their task, session or letter links;
 *  - ChatMessage.tsx draws a renderer slot without the writer's render context, clicks through
 *    useEntityClickHandler without the writer's opener, builds its opener from anything but its
 *    `textSource` (or unknown), or brings back the global tool-result renderer or a private
 *    FileViewer. Names are resolved through the file's real imports, so an alias does not hide one.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'
import { ModuleGraph, isReference, readSources } from './agent-guard-ast'

const h = vi.hoisted(() => ({
  fetch: vi.fn(async (_sid: string) => null as { host?: string } | null),
  peek: vi.fn((_sid: string) => null as { host?: string } | null),
}))
vi.mock('@/api/sessions', async (orig) => ({ ...(await orig<Record<string, unknown>>()), fetchSession: h.fetch, peekSessionRecord: h.peek }))
// The config boundary answers here, so no settings read reaches the network stub below.
vi.mock('@/api/config', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchConfig: async () => ({}),
  fetchFreshConfig: async () => ({}),
  fetchNotesDir: async () => null,
  fetchCanRevealLocalFiles: async () => false,
  fetchMacAccess: async () => null,
  fetchServerRole: async () => ({ replica: false, capabilities: [] }),
  fetchBuildInfo: async () => null,
}))

let doc: Document
let ChatMessage: typeof import('../../web/src/components/chat/ChatMessage').ChatMessage
let linkJsonIdValues: typeof import('../../web/src/components/chat/ChatMessage').linkJsonIdValues
let OPEN_FILE_EVENT: string
let MemoryRouter: typeof import('../../web/node_modules/react-router-dom').MemoryRouter
let root: Root | null = null
let box: Element | null = null
const opened: Array<Record<string, unknown>> = []
// Every request is recorded; a file, image or session read is the one this suite forbids.
const network = vi.fn(async (_input: unknown) => new Response('{}', { status: 404 }))
const reads = () => network.mock.calls.map((c) => String(c[0])).filter((u) => /\/api\/(file|files|local-image|sessions)/.test(u))
const parentClick = vi.fn()

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  // The app's own events must be linkedom's: its dispatch sets `target`, which a native event refuses.
  g.CustomEvent = dom.window.CustomEvent
  // No selection in this document; AgentText reads one on every click.
  const noSelection = () => ({ isCollapsed: true, anchorNode: null, focusNode: null, rangeCount: 0 })
  ;(dom.window as unknown as Record<string, unknown>).getSelection = noSelection
  ;(dom.document as unknown as Record<string, unknown>).getSelection = noSelection
  doc = dom.document as unknown as Document
  // After the document exists: the markdown sanitizer binds to it at import.
  ;({ ChatMessage, linkJsonIdValues } = await import('../../web/src/components/chat/ChatMessage'))
  ;({ OPEN_FILE_EVENT } = await import('../../web/src/utils/open-anywhere'))
  ;({ MemoryRouter } = await import('../../web/node_modules/react-router-dom'))
  dom.window.addEventListener(OPEN_FILE_EVENT, ((e: CustomEvent) => { opened.push(e.detail) }) as EventListener)
})

beforeEach(() => {
  opened.length = 0
  h.fetch.mockClear()
  h.peek.mockReset()
  h.peek.mockImplementation(() => null)
  network.mockClear()
  parentClick.mockClear()
  ;(globalThis as unknown as { fetch: unknown }).fetch = network
})

afterEach(async () => { await unmount() })

async function mount(props: Record<string, unknown>): Promise<Element> {
  box = doc.createElement('div')
  doc.body.appendChild(box)
  root = createRoot(box)
  await act(async () => { root!.render(createElement(MemoryRouter, null, createElement('div', { onClick: parentClick }, createElement(ChatMessage, props as never)))) })
  return box
}
async function unmount() {
  if (root) await act(async () => { root!.unmount() })
  root = null
  box?.remove()
  box = null
}
async function click(el: Element | null | undefined) {
  expect(el, 'the element is drawn').toBeTruthy()
  await act(async () => { el!.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })) })
}

const localImages = (el: Element) => [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '').filter((s) => s.includes('/api/local-image'))
const fileLink = (el: Element, p: string) => [...el.querySelectorAll('a.file-link')].find((a) => a.getAttribute('data-file-path') === p)

const T = '2026-11-07T09:30:00.000Z'
const REPLY = 'Saved the screenshot: /home/me/shots/run.png and edited /home/me/src/app.ts (see lt-mvx2abcd-9f3k)'
// A relative link the model wrote itself, with a cwd of its own: still unknown, so no lookup.
const RELATIVE = '<a class="file-link" data-rel-path="src/app.ts" data-cwd="/home/me" href="#">src/app.ts</a>'
const RESULT = '{"session_id": "sess-1234567890abc", "task_id": "abcd123-ef01"}\n\nLetter lt-mvx2abcd-9f3k\n\nPreview: /home/me/shots/out.png'
const blocksReply = {
  role: 'assistant' as const,
  content: '',
  timestamp: T,
  blocks: [
    { type: 'text', content: `${REPLY}\n\n${RELATIVE}` },
    { type: 'tool_call', name: 'task_get', status: 'done', input: { task_id: 'abcd123-ef01' }, result: RESULT },
  ],
}
const openTool = (el: Element) => click(el.querySelector('.chat-tool-block-header'))
const toolResult = (el: Element) => [...el.querySelectorAll('.chat-tool-block-section')]
  .find((sec) => sec.querySelector('.chat-tool-block-section-label')?.textContent === 'Result')!
  .querySelector('.chat-tool-block-result')!

describe('a chat row with no recorded writer', () => {
  it('draws pictures as links, reads no record, and a click opens only the choose-a-machine viewer', async () => {
    const el = await mount(blocksReply)
    expect(localImages(el)).toEqual([])
    expect(el.querySelector('a.letter-link[data-letter-id="lt-mvx2abcd-9f3k"]')).not.toBeNull()
    await click(fileLink(el, '/home/me/src/app.ts'))
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({ path: '/home/me/src/app.ts' })
    expect(String(opened[0]!.sourceFailure)).toContain('No file was read')
    expect(opened[0]!.host).toBeUndefined()
    // The picture that did not load is a link, and refuses the same way.
    await click(fileLink(el, '/home/me/shots/run.png'))
    expect(opened).toHaveLength(2)
    expect(String(opened[1]!.sourceFailure)).toContain('No file was read')

    await openTool(el)
    const result = toolResult(el)
    expect(localImages(result)).toEqual([])
    // The tool result keeps its JSON id pills and its letter link through the shared renderer.
    expect(result.querySelector('a.session-link[data-session-id="sess-1234567890abc"]'), result.innerHTML).not.toBeNull()
    expect(result.querySelector('a.task-link[data-task-id="abcd123-ef01"]')).not.toBeNull()
    expect(result.querySelector('a.letter-link[data-letter-id="lt-mvx2abcd-9f3k"]')).not.toBeNull()
    parentClick.mockClear()
    await click(fileLink(result, '/home/me/shots/out.png'))
    expect(opened).toHaveLength(3)
    expect(String(opened[2]!.sourceFailure)).toContain('No file was read')
    // The result's handler took the click: the row around it does not open it a second time.
    expect(parentClick).not.toHaveBeenCalled()

    // A relative path from an unknown writer is refused as written: no lookup on any host.
    await click(el.querySelector('a.file-link[data-rel-path="src/app.ts"]'))
    expect(opened).toHaveLength(4)
    expect(opened[3]).toMatchObject({ path: 'src/app.ts' })
    expect(String(opened[3]!.sourceFailure)).toContain('No file was read')

    expect(h.peek).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(reads()).toEqual([])
  })

  it('the route target session is not the writer', async () => {
    const el = await mount({ ...blocksReply, routeInfo: { direction: 'sent', event: 'session:send', sessionId: 'sid-target' } })
    expect(localImages(el)).toEqual([])
    await click(fileLink(el, '/home/me/src/app.ts'))
    expect(String(opened[0]!.sourceFailure)).toContain('No file was read')
    expect(h.peek).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('the legacy reply, a triage entry and the compaction summary load nothing either', async () => {
    let el = await mount({ role: 'assistant', content: REPLY, timestamp: T })
    expect(localImages(el)).toEqual([])
    expect(fileLink(el, '/home/me/shots/run.png')).toBeTruthy()
    await unmount()

    el = await mount({ role: 'user', source: 'triage', content: REPLY, timestamp: T })
    await click(el.querySelector('.chat-notification-header'))
    expect(localImages(el)).toEqual([])
    await unmount()

    // The compaction header is the model's first line too, and may name an image.
    el = await mount({ role: 'assistant', source: 'compaction', content: `Context compacted, see /home/me/shots/head.png\n${REPLY}`, timestamp: T })
    expect(localImages(el)).toEqual([])
    await click(el.querySelector('.chat-compaction-details-toggle'))
    expect(localImages(el)).toEqual([])
    const before = opened.length
    await click(fileLink(el, '/home/me/src/app.ts'))
    expect(opened).toHaveLength(before + 1)
    expect(String(opened.at(-1)!.sourceFailure)).toContain('No file was read')
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('a typed message keeps its uploaded picture and its words verbatim', async () => {
    const el = await mount({ role: 'user', content: 'look at /home/me/shots/run.png', timestamp: T, images: [{ url: '/api/images/up-1.png', name: 'up.png', mediaType: 'image/png' }] })
    expect([...el.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['/api/images/up-1.png'])
    expect(localImages(el)).toEqual([])
    expect(el.textContent).toContain('look at /home/me/shots/run.png')
  })
})

describe('the task context attached to a message', () => {
  // Each body is longer than the old cut, with its path only at the end, so a cut would lose it.
  const pad = (n: number) => 'Earlier notes without any path in them. '.repeat(n)
  const ctx = {
    id: 'abcd123-ef01', title: 'Context task', project: '', status: 'todo',
    description: `${pad(12)}See /home/me/ctx/desc-final.ts and /home/me/ctx/desc.png`,
    summary: 'Short summary.',
    note: `${pad(20)}Kept in /home/me/ctx/note-final.md and /home/me/ctx/note.png`,
    conversation_log: `### Session 1\n${pad(15)}\n### Session 2\nWrote /home/me/ctx/log-final.ts and /home/me/ctx/log.png`,
  }

  it('shows each body whole, as links from no known machine: no picture, no read, and a click offers the choice', async () => {
    const el = await mount({ role: 'user', content: 'Please look', timestamp: T, taskContext: ctx })
    await click(el.querySelector('.chat-task-context-toggle'))
    expect(el.textContent).not.toContain('[truncated]')
    expect(el.textContent).not.toContain('[older entries omitted]')
    expect(localImages(el)).toEqual([])
    const paths = ['/home/me/ctx/desc-final.ts', '/home/me/ctx/note-final.md', '/home/me/ctx/log-final.ts', '/home/me/ctx/desc.png', '/home/me/ctx/note.png', '/home/me/ctx/log.png']
    for (const p of paths) {
      const before = opened.length
      await click(fileLink(el, p))
      expect(opened, p).toHaveLength(before + 1)
      expect(opened.at(-1), p).toMatchObject({ path: p })
      expect(String(opened.at(-1)!.sourceFailure), p).toContain('No file was read')
      expect(opened.at(-1)!.host, p).toBeUndefined()
    }
    expect(h.peek).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(reads()).toEqual([])
  })
})

describe('a chat row whose writer the surface names', () => {
  it('a named host draws and opens there', async () => {
    const el = await mount({ ...blocksReply, textSource: { host: 'devbox', cwd: '/home/me' } })
    const imgs = localImages(el)
    expect(imgs.length).toBeGreaterThan(0)
    for (const s of imgs) expect(s).toContain('host=devbox')
    await openTool(el)
    const resultImgs = localImages(toolResult(el))
    expect(resultImgs.length).toBeGreaterThan(0)
    for (const s of resultImgs) expect(s).toContain('host=devbox')
    expect(toolResult(el).querySelector('a.session-link[data-session-id="sess-1234567890abc"]'), toolResult(el).innerHTML).not.toBeNull()
    expect(toolResult(el).querySelector('a.letter-link[data-letter-id="lt-mvx2abcd-9f3k"]')).not.toBeNull()
    await click(fileLink(el, '/home/me/src/app.ts'))
    expect(opened).toHaveLength(1)
    expect(opened.at(-1)).toMatchObject({ path: '/home/me/src/app.ts', host: 'devbox' })
    // The writer's machine first, the other machines when it lacks the file: never looked up alone.
    expect(opened.at(-1)!.sourceOnly).toBeUndefined()
    expect(opened.at(-1)!.sourceFailure).toBeUndefined()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('a named session draws from the record this page holds, with no request', async () => {
    h.peek.mockImplementation((sid: string) => (sid === 'sid-writer' ? { host: 'gpu' } : null))
    const el = await mount({ role: 'assistant', content: REPLY, timestamp: T, textSource: { sessionId: 'sid-writer' } })
    const imgs = localImages(el)
    expect(imgs.length).toBeGreaterThan(0)
    for (const s of imgs) expect(s).toContain('host=gpu')
    expect(h.fetch).not.toHaveBeenCalled()
  })
})

describe('linkJsonIdValues', () => {
  const ids = (html: string) => {
    const t = doc.createElement('template')
    t.innerHTML = linkJsonIdValues(html)
    return [...t.content.querySelectorAll('a.session-link, a.task-link')].map((a) => a.getAttribute('data-session-id') ?? a.getAttribute('data-task-id'))
  }

  it('links task and session ids in code JSON, in either quote form', () => {
    expect(ids('<pre><code>{"session_id": "sess-1", "task_id": "abcd123-ef01"}</code></pre>')).toEqual(['sess-1', 'abcd123-ef01'])
    expect(ids('<p>&quot;session_id&quot;: &quot;sess-2&quot;</p>')).toEqual(['sess-2'])
    const out = linkJsonIdValues('<p>&quot;id&quot;: &quot;abcd123-ef01&quot; tail</p>')
    expect(out).toContain('data-task-id="abcd123-ef01"')
    expect(out).toContain('tail')
  })

  it('never touches an attribute, a comment, a textarea, a title, or a link already there', () => {
    const cases = [
      '<span title="a > &quot;session_id&quot;: &quot;s-1&quot;">x</span>',
      '<!-- "session_id": "s-1" --><p>x</p>',
      '<textarea>"session_id": "s-1"</textarea>',
      '<title>"session_id": "s-1"</title>',
      '<a href="#">"session_id": "s-1"</a>',
      '<p>"session_id": "a b"</p>',
    ]
    for (const html of cases) expect(linkJsonIdValues(html), html).toBe(html)
  })

  it('a quoted ">" in an attribute does not shift what counts as text', () => {
    expect(ids('<span title="x > y">"session_id": "s-3"</span>')).toEqual(['s-3'])
    // An empty link before the text closes; the text after it is prose.
    expect(ids('<p><a href="#"></a>"session_id": "s-4"</p>')).toEqual(['s-4'])
  })
})

// ── Guard over ChatMessage.tsx, resolved through its real imports ───────────

const WEB = path.resolve('web/src')
const FILE = path.join(WEB, 'components/chat/ChatMessage.tsx')
const GRAPH = new ModuleGraph(readSources(WEB), WEB)
const KEY = GRAPH.keyOf(FILE)
const def = (rel: string, name: string) => `${path.resolve(WEB, rel)}#${name}`
const SF = GRAPH.sources.get(FILE)!

type Jsx = { key: string; attrs: Map<string, string>; line: number }
type Call = { key: string; args: string[]; inFn: string; line: number }
function scan(): { jsx: Jsx[]; calls: Call[]; refs: Set<string>; consts: Map<string, string> } {
  const jsx: Jsx[] = []
  const calls: Call[] = []
  const refs = new Set<string>()
  const consts = new Map<string, string>()
  const fnStack: string[] = []
  const line = (n: ts.Node) => SF.getLineAndCharacterOfPosition(n.getStart(SF)).line + 1
  const visit = (n: ts.Node) => {
    const named = ts.isFunctionDeclaration(n) && n.name ? n.name.text : undefined
    if (named) fnStack.push(named)
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName)) {
      const attrs = new Map<string, string>()
      for (const a of n.attributes.properties) if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(SF), a.initializer ? a.initializer.getText(SF) : 'true')
      jsx.push({ key: GRAPH.resolveBinding(KEY, n.tagName.text), attrs, line: line(n) })
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      calls.push({ key: GRAPH.resolveBinding(KEY, n.expression.text), args: n.arguments.map((a) => a.getText(SF)), inFn: fnStack.at(-1) ?? '', line: line(n) })
    }
    if (ts.isIdentifier(n) && isReference(n)) refs.add(GRAPH.resolveBinding(KEY, n.text))
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) consts.set(n.name.text, n.initializer.getText(SF))
    ts.forEachChild(n, visit)
    if (named) fnStack.pop()
  }
  visit(SF)
  return { jsx, calls, refs, consts }
}
const S = scan()

describe('ChatMessage.tsx draws agent text only with its writer', () => {
  it('builds its opener from the row\'s own textSource, else unknown; never the route', () => {
    const opener = S.calls.filter((c) => c.key === def('hooks/useAgentFileOpener', 'useAgentFileOpener'))
    expect(opener.map((c) => c.args[0]).sort()).toEqual(['UNKNOWN_WRITER', 'textSource ?? UNKNOWN_WRITER'])
    expect(S.consts.get('UNKNOWN_WRITER')).toBe('{ unknownSource: true }')
    for (const c of opener) expect(c.args.join(','), `line ${c.line}`).not.toMatch(/routeInfo|sessionId/)
  })

  it('every click through useEntityClickHandler carries the writer\'s opener, host, session and refusal', () => {
    const clicks = S.calls.filter((c) => c.key === def('hooks/useEntityClickHandler', 'useEntityClickHandler'))
    expect(clicks.length).toBeGreaterThanOrEqual(2)
    for (const c of clicks) {
      // After onSessionClick: the writer's opener, host, session and refusal (task pills open themselves).
      expect(c.args.slice(1), `line ${c.line}`).toEqual(['file.onFileOpen', 'file.fileHost', 'file.fileSessionId', 'file.refusesAll'])
    }
  })

  it('every render slot takes the writer\'s machine and whether pictures may load', () => {
    const slots = S.jsx.filter((j) => j.key === def('components/chat/RichBlocks', 'RichMarkdown') || j.key === def('components/chat/SuggestSegments', 'SuggestSegments'))
    expect(slots.length).toBeGreaterThanOrEqual(4)
    for (const j of slots) for (const a of ['cwd', 'host', 'inlineImages']) expect(j.attrs.has(a), `line ${j.line}: ${a}`).toBe(true)
    for (const j of S.jsx.filter((x) => x.key === `${KEY}#MemoizedTextBlock`)) expect(j.attrs.has('render'), `line ${j.line}`).toBe(true)
    for (const j of S.jsx.filter((x) => x.key === `${KEY}#ToolCallSection`)) expect(j.attrs.get('file'), `line ${j.line}`).toBe('{file}')
    for (const j of S.jsx.filter((x) => x.key === `${KEY}#SystemMessageGroup`)) expect(j.attrs.get('file'), `line ${j.line}`).toBe('{file}')
    // A summary of many writers' turns (task context, compaction) is unknown.
    const agentText = S.jsx.filter((j) => j.key === def('components/common/AgentText', 'AgentText'))
    expect(agentText.length).toBeGreaterThanOrEqual(2)
    for (const j of agentText) expect(j.attrs.get('unknownSource'), `line ${j.line}`).toBe('true')
  })

  it('agent markdown is rendered with the writer\'s host, or with no pictures at all', () => {
    const md = S.calls.filter((c) => c.key === def('utils/markdown', 'renderMarkdownWithRefs'))
    for (const c of md) {
      if (c.inFn === 'renderInlineMarkdown') continue
      expect(c.args.length, `line ${c.line}`).toBe(4)
      expect(/[Hh]ost/.test(c.args[2]!) || /inlineImages: false/.test(c.args[3]!), `line ${c.line}`).toBe(true)
    }
    // The compaction header is model text with no writer: no pictures.
    expect(md.filter((c) => c.inFn === 'specialChatRow').map((c) => c.args[3])).toEqual(['{ inlineImages: false }'])
    // The only helper left is the inline one, for the folded summary (no pictures).
    expect(SF.statements.some((st) => ts.isFunctionDeclaration(st) && st.name?.text === 'renderMarkdown')).toBe(false)
    expect(S.calls.filter((c) => c.key === `${KEY}#renderInlineMarkdown`).map((c) => c.args[0])).toEqual(['collapsedSummary'])
  })

  it('the JSON id pills come from the parsed DOM, not a string html parser', () => {
    const fns = ['linkJsonIdValues', 'jsonIdFragment', 'inNonProse']
    const bodies = SF.statements.filter((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && !!st.name && fns.includes(st.name.text))
    expect(bodies.map((b) => b.name!.text).sort()).toEqual([...fns].sort())
    const tagRegex: string[] = []
    const visit = (n: ts.Node) => {
      if (ts.isRegularExpressionLiteral(n) && n.text.includes('<')) tagRegex.push(n.text)
      ts.forEachChild(n, visit)
    }
    for (const b of bodies) visit(b)
    expect(tagRegex).toEqual([])
    const linker = bodies.find((b) => b.name!.text === 'linkJsonIdValues')!.getText(SF)
    expect(linker).toContain("document.createElement('template')")
    expect(linker).toContain('document.createTreeWalker(tpl.content')
    expect(S.consts.get('JSON_ID_SRC') ?? '').not.toContain('<')
  })

  it('a tool result or field click the shared handler took stops at the tool block', () => {
    const tool = SF.statements.find((st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === 'ToolCallSection')!.getText(SF)
    expect(tool).toMatch(/handleEntityClick\(e\);\s*if \(e\.defaultPrevented\) e\.stopPropagation\(\);/)
    const results = S.jsx.filter((j) => j.attrs.get('className') === '"chat-tool-block-result markdown-body"')
    expect(results.length).toBe(2)
    for (const j of results) expect(j.attrs.get('onClick'), `line ${j.line}`).toBe('{handleResultClick}')
  })

  it('uses neither the global tool-result renderer nor a private file viewer', () => {
    expect(S.refs.has(def('utils/markdown', 'renderToolResultWithRefs'))).toBe(false)
    expect(S.refs.has(def('components/common/FileViewer', 'FileViewer'))).toBe(false)
    expect(fs.readFileSync(FILE, 'utf8')).not.toContain('/api/local-image?path=')
  })
})
