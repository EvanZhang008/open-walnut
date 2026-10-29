/**
 * A message drawn through the envelope segments (a batched delivery: a Walnut
 * notice plus the user's own words) keeps its DOM across re-renders.
 *
 * 2026-10-29, the Mac app's Org page: a status notice rode in front of the
 * user's message with a screenshot, and the plain segment passed an inline
 * `{{ __html }}` literal. React 19 writes innerHTML whenever that prop object is
 * new, so every status push re-rendered the row, replaced the <img>, and the
 * reloading image shrank and regrew the timeline by ~400px: the chat "flashed".
 * The page logged it as one `IMG-FIX gap=398` per status change.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
// The markdown renderer needs a real DOM for DOMPurify; the bug is the prop's
// identity, not the markdown, so the "rendered" html is the text itself. Each
// re-render hands the plain segment an equal string and a new props object.
vi.mock('@/hooks/useEntityLabels', () => ({
  useRenderedMarkdown: (text: string) => `${text}`,
  useTaskLabel: () => undefined,
  useEntityLabelsVersion: () => 0,
}))

const { SessionEnvelopeSegments } = await import('../../web/src/components/sessions/SessionProvenanceCard')
const { stableHtml } = await import('../../web/src/hooks/useStableHtml')

let doc: Document
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let el: HTMLElement
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  el = doc.createElement('div')
  doc.body.appendChild(el)
  root = createRoot(el)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})

const TEXT = '<p>[Images attached]</p><p><img src="/api/local-image?path=%2Ftmp%2Fshot.jpg"></p><p>Why is this bug still here?</p>'
const render = async (tick: number) => {
  // A fresh segments array each time, as a re-parse of the row gives.
  const segments = [{ kind: 'text' as const, text: TEXT }]
  await act(async () => { root!.render(createElement('div', { 'data-tick': tick }, createElement(SessionEnvelopeSegments, { segments }))) })
}

describe('envelope segments keep their DOM across re-renders', () => {
  it('the screenshot in a plain segment is the same element after ten re-renders', async () => {
    await render(0)
    const img = el.querySelector('img')
    expect(img, 'the markdown image renders').not.toBeNull()
    const body = img!.closest('.markdown-body')
    for (let i = 1; i <= 10; i++) await render(i)
    expect(el.querySelector('img'), 'the image element was replaced (innerHTML rewritten)').toBe(img)
    expect(el.querySelector('.markdown-body')).toBe(body)
  })
})

describe('stableHtml', () => {
  it('returns one object per html string', () => {
    const a = stableHtml('<p>a</p>')
    expect(stableHtml('<p>' + 'a' + '</p>')).toBe(a)
    expect(stableHtml('<p>b</p>')).not.toBe(a)
    expect(stableHtml('<p>b</p>').__html).toBe('<p>b</p>')
  })

  it('stays bounded, and an evicted string just gets a new object with the same html', () => {
    const first = stableHtml('<p>first</p>')
    for (let i = 0; i < 1200; i++) stableHtml(`<p>${i}</p>`)
    const again = stableHtml('<p>first</p>')
    expect(again.__html).toBe('<p>first</p>')
    expect(again).not.toBe(first)
    // A recently used string survives the churn.
    const hot = stableHtml('<p>hot</p>')
    for (let i = 0; i < 500; i++) { stableHtml(`<p>x${i}</p>`); stableHtml('<p>hot</p>') }
    expect(stableHtml('<p>hot</p>')).toBe(hot)
  })

  it('a string larger than the whole budget is still returned, and kept until the next one', () => {
    const big = 'x'.repeat(5_000_000)
    const p = stableHtml(big)
    expect(p.__html.length).toBe(5_000_000)
    expect(stableHtml(big)).toBe(p)
  })
})
