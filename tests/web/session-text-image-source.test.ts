/**
 * A session timeline's pictures load from the session's own machine.
 *
 * 2026-11-07: every renderer of a session's words (the reply bubble's RichMarkdown, the image
 * strip under it, the streaming text block, a tool's result and input previews, Bash output) built
 * `/api/local-image?path=` with no host, so a remote session's `/home/me/shot.png` drew a
 * same-named file from this machine. The class is "a session row's render slots": each takes its
 * host and whether pictures may load from useSessionTextRender (hooks/useAgentFileOpener.ts,
 * utils/agent-text-source.ts sessionTextSource). An explicit host wins; else the record this page
 * already holds names it; else the path stays a link and nothing loads.
 *
 * Fails when:
 *  - sessionTextSource / localImageSrc stop deciding as below;
 *  - a session row file builds a local-image URL by hand;
 *  - a render slot (RichMarkdown, SuggestSegments, StableMarkdownBody, ReplyImageStrip) in a
 *    session row file is drawn without its host and inlineImages;
 *  - a mounted row loads a picture while its machine is unknown, or keeps the old machine's
 *    picture after the session's host changed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'
import { localImageSrc, renderContextOf, sessionTextSource } from '../../web/src/utils/agent-text-source'

const noRecord = () => null

describe('sessionTextSource', () => {
  it('an explicit host wins, the primary included', () => {
    const peek = () => ({ host: 'stale-box' })
    expect(renderContextOf(sessionTextSource({ sessionId: 's1', sessionHost: 'devbox', sessionCwd: '/w' }, peek), peek))
      .toEqual({ cwd: '/w', host: 'devbox', images: true })
    expect(renderContextOf(sessionTextSource({ sessionId: 's1', sessionHost: '', sessionCwd: '/w' }, peek), peek))
      .toEqual({ cwd: '/w', images: true })
  })

  it('with only the session, the record this page holds names the machine (no request)', () => {
    const remote = () => ({ host: 'devbox' })
    const local = () => ({})
    expect(renderContextOf(sessionTextSource({ sessionId: 's1', sessionCwd: '/w' }, remote), remote))
      .toEqual({ cwd: '/w', host: 'devbox', images: true })
    expect(renderContextOf(sessionTextSource({ sessionId: 's1', sessionCwd: '/w' }, local), local))
      .toEqual({ cwd: '/w', images: true })
  })

  it('a session with no record held yet, or no session at all, loads no picture', () => {
    expect(renderContextOf(sessionTextSource({ sessionId: 's1', sessionCwd: '/w' }, noRecord), noRecord)).toEqual({ images: false })
    expect(renderContextOf(sessionTextSource({ sessionCwd: '/w' }, noRecord), noRecord)).toEqual({ images: false })
    expect(renderContextOf(sessionTextSource({ sessionId: 'external' }, noRecord), noRecord)).toEqual({ images: false })
  })
})

describe('localImageSrc', () => {
  it('names the known machine, the primary without a host, and nothing while unknown', () => {
    expect(localImageSrc('/home/me/a b.png', { images: true, host: 'devbox' })).toBe('/api/local-image?path=%2Fhome%2Fme%2Fa%20b.png&host=devbox')
    expect(localImageSrc('/home/me/a.png', { images: true })).toBe('/api/local-image?path=%2Fhome%2Fme%2Fa.png')
    expect(localImageSrc('/home/me/a.png', { images: false, host: 'devbox' })).toBeNull()
  })
})

// ── Ratchet over the session row files ─────────────────────────────────────

const WEB = path.resolve('web/src')
const ROW_FILES = [
  'components/sessions/SessionMessage.tsx',
  'components/sessions/StreamingBlockView.tsx',
  'components/sessions/BashToolCall.tsx',
  'components/sessions/ThreadCardConversation.tsx',
]
const SLOTS = new Set(['RichMarkdown', 'SuggestSegments', 'StableMarkdownBody', 'ReplyImageStrip'])

function slotUses(file: string): { tag: string; attrs: Set<string>; line: number }[] {
  const text = fs.readFileSync(path.join(WEB, file), 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: { tag: string; attrs: Set<string>; line: number }[] = []
  const visit = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName) && SLOTS.has(n.tagName.text)) {
      const attrs = new Set<string>()
      for (const a of n.attributes.properties) if (ts.isJsxAttribute(a)) attrs.add(a.name.getText(sf))
      out.push({ tag: n.tagName.text, attrs, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

describe('session row render slots', () => {
  it('no session row file builds a local-image URL by hand', () => {
    for (const f of ROW_FILES) {
      const text = fs.readFileSync(path.join(WEB, f), 'utf8')
      expect(text.includes('/api/local-image?path='), f).toBe(false)
    }
  })

  it('every render slot carries the session machine and whether pictures may load', () => {
    let seen = 0
    for (const f of ROW_FILES) {
      for (const u of slotUses(f)) {
        seen++
        expect(u.attrs.has('host') && u.attrs.has('inlineImages'), `${f}:${u.line} <${u.tag}> lacks host/inlineImages`).toBe(true)
      }
    }
    // The bubble (5), the streaming block (3) and the thread card question (1) at least.
    expect(seen).toBeGreaterThanOrEqual(9)
  })
})

describe('plan slots', () => {
  /** Attributes of every <Tag> in a file. */
  const uses = (file: string, tag: string) => {
    const text = fs.readFileSync(path.join(WEB, file), 'utf8')
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const out: Set<string>[] = []
    const visit = (n: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName) && n.tagName.text === tag) {
        out.push(new Set(n.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText(sf))))
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    return out
  }

  it('the plan card and the plan popover take the session that wrote the plan and the panel opener', () => {
    const cards = [...uses('components/sessions/SessionMessage.tsx', 'PlanCard'), ...uses('components/sessions/StreamingBlockView.tsx', 'PlanCard')]
    expect(cards.length).toBe(2)
    for (const a of cards) for (const k of ['sessionId', 'sessionHost', 'sessionCwd', 'onFileOpen']) expect(a.has(k), k).toBe(true)
    const pops = uses('components/sessions/SessionPanel.tsx', 'PlanPopoverContent')
    expect(pops.length).toBe(1)
    for (const k of ['sessionId', 'sessionHost', 'cwd', 'onFileOpen', 'writerSessionId']) expect(pops[0]!.has(k), k).toBe(true)
    // The live plan carries its writer (a from-plan session shows ANOTHER session's plan), and the
    // card and the popover take that writer, never the panel's host, for it.
    const panelSrc = fs.readFileSync(path.join(WEB, 'components/sessions/SessionPanel.tsx'), 'utf8')
    expect(panelSrc).toContain('writerSessionId: plan.sourceSessionId || sessionId')
    expect(panelSrc).toContain('writerSessionId={plan.sourceSessionId || sessionId}')
    const msgSrc = fs.readFileSync(path.join(WEB, 'components/sessions/SessionMessage.tsx'), 'utf8')
    expect(msgSrc).toContain('livePlan.writerSessionId !== sessionId')
    for (const t of [panelSrc, msgSrc]) expect(t).toContain('foreign ? writer.onFileOpen : onFileOpen')
    // A plan read for one session is never shown for the next one.
    const hook = fs.readFileSync(path.join(WEB, 'hooks/useSessionPlan.ts'), 'utf8')
    expect(hook).toContain('held && held.sessionId === sessionId ? held.plan : null')
    // Both render from the session's own machine, a link while it is unknown.
    for (const f of ['components/sessions/SessionMessage.tsx', 'components/sessions/SessionPanel.tsx']) {
      const text = fs.readFileSync(path.join(WEB, f), 'utf8')
      const fn = f.endsWith('SessionPanel.tsx') ? 'function PlanPopoverContent' : 'export function PlanCard'
      const body = text.slice(text.indexOf(fn), text.indexOf('\n}\n', text.indexOf(fn)))
      expect(body, f).toContain('useSessionTextRender(')
      expect(body, f).toMatch(/inlineImages: false/)
      expect(body, f).not.toContain('useRenderedMarkdown(')
    }
  })
})

// ── Mounted rows ───────────────────────────────────────────────────────────

let doc: Document
let SessionMessage: typeof import('../../web/src/components/sessions/SessionMessage').SessionMessage
let ReplyImageStrip: typeof import('../../web/src/components/sessions/SessionMessage').ReplyImageStrip
let MemoryRouter: typeof import('../../web/node_modules/react-router-dom').MemoryRouter
let root: Root | null = null
let box: Element | null = null
const requested: string[] = []

afterAll(() => { vi.unstubAllGlobals() })

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
  // Boundaries linkedom lacks: an empty selection, and the server's config read (an empty config;
  // any other request answers 404 and is recorded, never sent).
  const noSelection = () => ({ rangeCount: 0, isCollapsed: true, type: 'None', toString: () => '', removeAllRanges() {}, addRange() {}, getRangeAt() { throw new Error('no range') } })
  ;(dom.window as unknown as Record<string, unknown>).getSelection = noSelection
  ;(dom.document as unknown as Record<string, unknown>).getSelection = noSelection
  g.getSelection = noSelection
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    requested.push(url)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    return url.startsWith('/api/config') ? json({}) : json({ error: 'not in this test' }, 404)
  }))
  // After the document exists: the markdown sanitizer binds to it at import.
  ;({ SessionMessage, ReplyImageStrip } = await import('../../web/src/components/sessions/SessionMessage'))
  ;({ MemoryRouter } = await import('../../web/node_modules/react-router-dom'))
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  box?.remove()
  box = null
})

async function mountInTurn(elements: ReturnType<typeof createElement>[]): Promise<Element[]> {
  box = doc.createElement('div')
  doc.body.appendChild(box)
  root = createRoot(box)
  const out: Element[] = []
  for (const el of elements) {
    await act(async () => { root!.render(createElement(MemoryRouter, null, el)) })
    out.push(box.cloneNode(true) as Element)
  }
  return out
}

const imgSrcs = (el: Element) => [...el.querySelectorAll('img')].map((i) => i.getAttribute('src') ?? '')
const fileLinks = (el: Element) => [...el.querySelectorAll('a.file-link')].map((a) => a.getAttribute('data-file-path'))

const reply = { role: 'assistant' as const, text: 'Saved the screenshot: /home/me/shots/run.png', msgId: 'm-1', timestamp: '2026-11-07T00:00:00Z' }

describe('a mounted session reply', () => {
  it('loads its picture from the session host, and only the new host after the host changes', async () => {
    const [first, second] = await mountInTurn([
      createElement(SessionMessage, { message: reply, sessionId: 'sid-remote', sessionHost: 'devbox', sessionCwd: '/home/me' }),
      createElement(SessionMessage, { message: reply, sessionId: 'sid-remote', sessionHost: 'otherbox', sessionCwd: '/home/me' }),
    ])
    const a = imgSrcs(first!).filter((s) => s.includes('local-image'))
    expect(a.length).toBeGreaterThan(0)
    for (const s of a) expect(s).toContain('host=devbox')
    const b = imgSrcs(second!).filter((s) => s.includes('local-image'))
    expect(b.length).toBeGreaterThan(0)
    for (const s of b) { expect(s).toContain('host=otherbox'); expect(s).not.toContain('devbox') }
  })

  it('with an unknown machine draws the path as a link and loads nothing', async () => {
    for (const props of [{ sessionId: 'sid-never-fetched' }, {}]) {
      const [html] = await mountInTurn([createElement(SessionMessage, { message: reply, ...props })])
      expect(imgSrcs(html!).filter((s) => s.includes('local-image'))).toEqual([])
      expect(fileLinks(html!)).toContain('/home/me/shots/run.png')
      await act(async () => { root!.unmount() })
      root = null
    }
  })
})

describe('ReplyImageStrip', () => {
  it('is a link per path while the machine is unknown, and a picture from the named host once known', async () => {
    const [unknown, known] = await mountInTurn([
      createElement(ReplyImageStrip, { paths: ['/home/me/a.png'], inlineImages: false, host: 'devbox' }),
      createElement(ReplyImageStrip, { paths: ['/home/me/a.png'], inlineImages: true, host: 'devbox' }),
    ])
    expect(imgSrcs(unknown!)).toEqual([])
    expect(fileLinks(unknown!)).toEqual(['/home/me/a.png'])
    expect(imgSrcs(known!)).toEqual(['/api/local-image?path=%2Fhome%2Fme%2Fa.png&host=devbox'])
  })
})

