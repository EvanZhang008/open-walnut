/**
 * The quoted, injected and earlier words inside a session timeline render and open with their OWN
 * writer, never the receiving session's machine or folder.
 *
 * 2026-11-07: an envelope from another session, a session's own outbound send, a skill or summary
 * Walnut injected, and the rows of an earlier session all rendered with the RECEIVING session's
 * cwd (and no host), so a path in them drew and opened a same-named file of the wrong machine.
 * Each is now AgentText with the writer Walnut recorded:
 *  - an envelope: the host the envelope saved for its author first (the live index only says where
 *    that session shows now), else the one session it resolved to, else unknown; a notice's quote
 *    is the session it is about, a notice's own text, a trigger delivery and a plain run beside an
 *    envelope have no writer;
 *  - an outbound send: the sender (this session), never its target;
 *  - an injected skill, summary or banner: no writer;
 *  - a task's earlier session: that session's own id, host and cwd; a chat-earlier row: no writer.
 *
 * Fails when one of these entries goes back to the receiver's source, or loads a picture while
 * its writer is unknown.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot, type Root } from '../../web/node_modules/react-dom/client.js'
import { renderContextOf, sessionTextSource, sourceHostOf } from '../../web/src/utils/agent-text-source'

// ── AST view of every AgentText in the entry files ─────────────────────────

const WEB = path.resolve('web/src')
type Use = { attrs: Map<string, string>; spreads: string[]; line: number; fn: string }

function agentTextUses(rel: string): Use[] {
  const text = fs.readFileSync(path.join(WEB, rel), 'utf8')
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: Use[] = []
  const enclosing = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) && p.name) return p.name.text
    }
    return ''
  }
  const visit = (n: ts.Node) => {
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && ts.isIdentifier(n.tagName) && n.tagName.text === 'AgentText') {
      const attrs = new Map<string, string>()
      const spreads: string[] = []
      for (const a of n.attributes.properties) {
        if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(sf), a.initializer ? a.initializer.getText(sf) : 'true')
        else spreads.push(a.expression.getText(sf))
      }
      out.push({ attrs, spreads, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, fn: enclosing(n) })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

const inFn = (rel: string, fn: string) => {
  const uses = agentTextUses(rel).filter((u) => u.fn === fn)
  expect(uses.length, `${rel} ${fn} renders through AgentText`).toBeGreaterThan(0)
  return uses
}
const src = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')

describe('entry files render with their own writer', () => {
  it('an envelope never takes the receiving session\'s cwd, and renders through AgentText', () => {
    const f = 'components/sessions/SessionProvenanceCard.tsx'
    expect(src(f)).not.toMatch(/sessionCwd|useRenderedMarkdown|dangerouslySetInnerHTML/)
    for (const u of inFn(f, 'EnvelopeBody')) expect(u.spreads, `${f}:${u.line}`).toEqual(['source'])
    for (const u of inFn(f, 'PlainSegment')) expect(u.spreads, `${f}:${u.line}`).toEqual(['source'])
    // Only the plain runs take the row's writer, and only when it names one; a card never does.
    expect(src(f)).toContain('source={plainSource ?? NO_WRITER}')
    expect(src(f)).toContain('<ProvenanceCard key={`e-${i}`} envelope={segment.envelope} />')
    // The bubble names the primary for a user row's plain runs; Walnut's riders name nobody.
    const bubble = src('components/sessions/SessionMessage.tsx')
    expect(bubble).toContain('<SessionEnvelopeSegments segments={envelopeSegments} plainSource={PERSON_TEXT} />')
    expect(bubble).toContain('<SessionEnvelopeSegments segments={riderSegments} />')
    // The trigger's delivery and a notice's own text have no writer; a notice's quote is its peer's.
    expect(src(f)).toMatch(/kind === 'trigger'[\s\S]*?<EnvelopeBody body=\{envelope\.body\} source=\{NO_WRITER\} \/>/)
    expect(src(f)).toContain("source={kind === 'notification' ? NO_WRITER : writer}")
    expect(src(f)).toContain('<NoticeQuote key={i} section={section} source={writer} />')
  })

  it('an outbound send is the sender\'s words, never its target\'s', () => {
    const f = 'components/sessions/SessionOutboundCard.tsx'
    const [u, ...rest] = inFn(f, 'OutboundBody')
    expect(rest).toEqual([])
    expect(u!.spreads).toEqual(['sessionTextSource({ sessionId, sessionHost, sessionCwd }, peekSessionRecord)'])
    const body = src(f).slice(src(f).indexOf('function OutboundBody'), src(f).indexOf('function OutboundDetails'))
    expect(body).not.toMatch(/resolved|target/i)
  })

  it('injected skill, summary and banner text has no writer', () => {
    for (const [f, fn] of [['components/sessions/SessionMessage.tsx', 'InjectedContextRow'], ['components/sessions/InjectedBannerRow.tsx', 'InjectedBannerRow']] as const) {
      for (const u of inFn(f, fn)) {
        expect(u.attrs.get('unknownSource'), `${f}:${u.line}`).toBe('true')
        for (const k of ['sessionId', 'host', 'cwd', 'task']) expect(u.attrs.has(k), `${f}:${u.line} ${k}`).toBe(false)
      }
    }
    expect(src('components/sessions/InjectedBannerRow.tsx')).not.toMatch(/sessionCwd|useRenderedMarkdown/)
  })

  it("an earlier session's rows: the task's sessions keep their own source, chat-earlier rows have none", () => {
    const [t] = inFn('components/sessions/TaskEarlierSessions.tsx', 'EarlierSessionBlock')
    expect(t!.attrs.get('sessionId')).toBe('{row.session_id}')
    expect(t!.attrs.get('host')).toBe('{row.host ?? undefined}')
    expect(t!.attrs.get('cwd')).toBe('{row.cwd ?? undefined}')
    const [c] = inFn('components/sessions/ChatEarlierBlock.tsx', 'ChatEarlierBlock')
    expect(c!.attrs.get('unknownSource')).toBe('true')
    for (const f of ['components/sessions/TaskEarlierSessions.tsx', 'components/sessions/ChatEarlierBlock.tsx']) {
      expect(src(f), f).not.toMatch(/sessionCwd|StableMarkdownBody/)
    }
  })
})

// ── Decisions ───────────────────────────────────────────────────────────────

let peerTextSource: typeof import('../../web/src/components/sessions/SessionProvenanceCard').peerTextSource
let SessionEnvelopeSegments: typeof import('../../web/src/components/sessions/SessionProvenanceCard').SessionEnvelopeSegments
let ChatEarlierBlock: typeof import('../../web/src/components/sessions/ChatEarlierBlock').ChatEarlierBlock
let MemoryRouter: typeof import('../../web/node_modules/react-router-dom').MemoryRouter
let doc: Document
let root: Root | null = null
let box: Element | null = null

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
  // After the document exists: the markdown sanitizer binds to it at import.
  ;({ peerTextSource, SessionEnvelopeSegments } = await import('../../web/src/components/sessions/SessionProvenanceCard'))
  ;({ ChatEarlierBlock } = await import('../../web/src/components/sessions/ChatEarlierBlock'))
  ;({ MemoryRouter } = await import('../../web/node_modules/react-router-dom'))
})

afterEach(async () => {
  if (root) await act(async () => { root!.unmount() })
  root = null
  box?.remove()
  box = null
})

describe('peerTextSource', () => {
  it('the host saved in the envelope wins over the session it resolved to', () => {
    expect(sourceHostOf(peerTextSource({ host: 'devbox', sessionId: 'sid-1' }, 'sid-1'))).toEqual({ kind: 'host', host: 'devbox' })
    expect(sourceHostOf(peerTextSource({ host: 'local' }, undefined))).toEqual({ kind: 'host' })
    // An unidentified process still names the machine it ran on.
    expect(sourceHostOf(peerTextSource({ host: 'devbox', anonymous: true }, undefined))).toEqual({ kind: 'host', host: 'devbox' })
  })

  it('with no saved host, only the one resolved session names the writer; else unknown', () => {
    expect(sourceHostOf(peerTextSource({ shortId: 'abcd1234' }, 'abcd1234-full'))).toEqual({ kind: 'session', sessionId: 'abcd1234-full' })
    expect(sourceHostOf(peerTextSource({ shortId: 'abcd1234' }, undefined))).toEqual({ kind: 'unknown' })
    expect(renderContextOf(peerTextSource({ title: 'x' }, undefined), () => ({ host: 'receiver' }))).toEqual({ images: false })
  })
})

describe('outbound sender source', () => {
  it('is the sending session, whatever the target', () => {
    const peek = () => null
    expect(sourceHostOf(sessionTextSource({ sessionId: 'sender', sessionHost: 'devbox', sessionCwd: '/w' }, peek))).toEqual({ kind: 'host', host: 'devbox' })
    expect(sourceHostOf(sessionTextSource({}, peek))).toEqual({ kind: 'unknown' })
  })
})

async function mount(el: ReturnType<typeof createElement>): Promise<Element> {
  box = doc.createElement('div')
  doc.body.appendChild(box)
  root = createRoot(box)
  await act(async () => { root!.render(createElement(MemoryRouter, null, el)) })
  return box
}
const localImages = (el: Element) => [...el.querySelectorAll('img')].filter((i) => (i.getAttribute('src') ?? '').includes('local-image'))

describe('mounted entries with no writer read no picture', () => {
  it('a plain run beside an envelope keeps its path as a link', async () => {
    const el = await mount(createElement(SessionEnvelopeSegments, { segments: [{ kind: 'text' as const, text: 'Look at /home/me/shots/a.png now' }] }))
    expect(localImages(el)).toEqual([])
    expect([...el.querySelectorAll('a.file-link')].map((a) => a.getAttribute('data-file-path'))).toContain('/home/me/shots/a.png')
  })

  it("a person's plain run (the row names the primary) keeps its picture, from the primary", async () => {
    const el = await mount(createElement(SessionEnvelopeSegments, {
      segments: [{ kind: 'text' as const, text: 'Look at /home/me/shots/a.png now' }],
      plainSource: { host: '__local__' },
    }))
    const srcs = localImages(el).map((i) => i.getAttribute('src') ?? '')
    expect(srcs.length).toBeGreaterThan(0)
    for (const s of srcs) expect(s).not.toContain('host=')
  })

  it('a chat-earlier row keeps its path as a link', async () => {
    const el = await mount(createElement(ChatEarlierBlock, { rows: [{ id: 'r1', role: 'assistant' as const, text: 'Saved /home/me/shots/b.png' }] }))
    expect(localImages(el)).toEqual([])
    expect([...el.querySelectorAll('a.file-link')].map((a) => a.getAttribute('data-file-path'))).toContain('/home/me/shots/b.png')
  })
})
