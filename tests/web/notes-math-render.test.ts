/**
 * Math in the notes editor: a ```math block and $`latex`$ inline code are found and
 * decorated (source hidden + rendered widget) while the selection is elsewhere, and show
 * their source once the selection touches them. A bare `$5 and $10` and ordinary inline
 * code are not math. Bad latex renders as flagged source and never throws.
 */
import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from '@tiptap/pm/model'
import { buildMathDecorations, findMath } from '../../web/src/components/notes/extensions/math-render'
import { loadMath, mathStatus, renderMath, shouldLoadMath } from '../../web/src/components/notes/extensions/math-katex'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*' },
    codeBlock: { group: 'block', content: 'text*', marks: '', code: true, attrs: { language: { default: null } } },
    text: {},
  },
  marks: { code: {}, bold: {} },
})

type Piece = string | { code: string } | { codeBold: string }

function para(...pieces: Piece[]) {
  return schema.node(
    'paragraph',
    null,
    pieces.map((p) =>
      typeof p === 'string'
        ? schema.text(p)
        : 'code' in p
          ? schema.text(p.code, [schema.marks.code.create()])
          : schema.text(p.codeBold, [schema.marks.code.create(), schema.marks.bold.create()]),
    ),
  )
}

function code(language: string | null, text: string) {
  return schema.node('codeBlock', { language }, text ? [schema.text(text)] : [])
}

function docOf(...blocks: PMNode[]) {
  return schema.node('doc', null, blocks)
}

interface Deco { from: number; to: number; spec: { key?: string }; type: { attrs?: Record<string, string> } }

function decos(doc: PMNode, sel?: { from: number; to: number }) {
  return (buildMathDecorations(doc, sel, 'ready').find() as unknown as Deco[]).map((d) => ({
    from: d.from,
    to: d.to,
    widget: d.from === d.to && !!d.spec.key,
    key: d.spec.key,
    cls: d.type.attrs?.class,
  })).sort((a, b) => a.from - b.from || a.to - b.to)
}

const end = (doc: PMNode) => ({ from: doc.content.size - 1, to: doc.content.size - 1 })

describe('math in the notes editor', () => {
  it('finds a ```math block and decorates it: source hidden, rendered widget after the block', () => {
    const doc = docOf(para('before'), code('math', '\\sum_{i=1}^n i'), para('after'))
    const [m] = findMath(doc)
    expect(m).toMatchObject({ display: true, latex: '\\sum_{i=1}^n i' })
    expect(doc.nodeAt(m.from)?.type.name).toBe('codeBlock')
    expect(m.to).toBe(m.from + doc.nodeAt(m.from)!.nodeSize)

    const away = decos(doc, end(doc))
    expect(away).toContainEqual(expect.objectContaining({ from: m.from, to: m.to, cls: 'notes-math-source-hidden' }))
    const w = away.find((d) => d.widget)
    expect(w).toMatchObject({ from: m.to, key: 'math:b:ready:0:\\sum_{i=1}^n i' })
  })

  it('shows a math block\'s source once the selection is inside, with the preview kept under it', () => {
    const doc = docOf(para('before'), code('math', 'e = mc^2'), para('after'))
    const [m] = findMath(doc)
    const inside = decos(doc, { from: m.from + 3, to: m.from + 3 })
    expect(inside.some((d) => d.cls === 'notes-math-source-hidden')).toBe(false)
    expect(inside.find((d) => d.widget)?.key).toBe('math:b:ready:1:e = mc^2')
    // The paragraph right after the block does not count as inside it.
    const next = decos(doc, { from: m.to + 1, to: m.to + 1 })
    expect(next.some((d) => d.cls === 'notes-math-source-hidden')).toBe(true)
    // Nor does a selection that only ends at its edge (the paragraph before selected whole).
    const edge = decos(doc, { from: 0, to: m.from })
    expect(edge.some((d) => d.cls === 'notes-math-source-hidden')).toBe(true)
    // A selection of the block node itself does.
    expect(decos(doc, { from: m.from, to: m.to }).some((d) => d.cls === 'notes-math-source-hidden')).toBe(false)
  })

  it('renders every formula when there is no active selection (editor blurred or read-only)', () => {
    const doc = docOf(code('math', 'a'), para('$', { code: 'b' }, '$'))
    const all = decos(doc, undefined)
    expect(all.filter((d) => d.cls === 'notes-math-source-hidden')).toHaveLength(2)
    expect(all.filter((d) => d.widget).map((d) => d.key).sort()).toEqual(['math:b:ready:0:a', 'math:i:ready:0:b'])
  })

  it('leaves other code blocks alone and accepts the language in any case', () => {
    const doc = docOf(code('ts', 'const x = 1'), code(null, 'plain'), code('Math', 'x'))
    expect(findMath(doc).map((m) => m.latex)).toEqual(['x'])
  })

  it('finds $`latex`$ inline and hides the whole `$...$` run behind one widget', () => {
    const doc = docOf(para('Energy ', '$', { code: 'e = mc^2' }, '$ and ', '$', { code: '\\frac{a}{b}' }, '$.'), para('x'))
    const found = findMath(doc)
    expect(found.map((m) => [m.latex, doc.textBetween(m.from, m.to)])).toEqual([
      ['e = mc^2', '$e = mc^2$'],
      ['\\frac{a}{b}', '$\\frac{a}{b}$'],
    ])
    const away = decos(doc, end(doc))
    expect(away.filter((d) => d.cls === 'notes-math-source-hidden').map((d) => doc.textBetween(d.from, d.to))).toEqual([
      '$e = mc^2$',
      '$\\frac{a}{b}$',
    ])
    expect(away.filter((d) => d.widget).map((d) => [d.from, d.key])).toEqual([
      [found[0].from, 'math:i:ready:0:e = mc^2'],
      [found[1].from, 'math:i:ready:0:\\frac{a}{b}'],
    ])
  })

  it('shows inline source when the selection touches it, at either edge or inside, and only for that formula', () => {
    const doc = docOf(para('A ', '$', { code: 'x^2' }, '$ B ', '$', { code: 'y' }, '$'))
    const [first, second] = findMath(doc)
    for (const at of [first.from, first.from + 2, first.to]) {
      const d = decos(doc, { from: at, to: at })
      const hidden = d.filter((x) => x.cls === 'notes-math-source-hidden').map((x) => doc.textBetween(x.from, x.to))
      expect(hidden, `cursor at ${at}`).toEqual(['$y$'])
      expect(d.filter((x) => x.widget).map((x) => x.from), `cursor at ${at}`).toEqual([second.from])
    }
    // A range selection across both shows both sources.
    expect(decos(doc, { from: first.from, to: second.to })).toEqual([])
  })

  // The editor's code mark excludes other marks, so this is defensive: a schema that lets
  // a mark change inside inline code still yields one formula.
  it('joins one inline code run split by another mark', () => {
    const doc = docOf(para('$', { code: 'a + ' }, { codeBold: 'b' }, '$'))
    expect(findMath(doc).map((m) => m.latex)).toEqual(['a + b'])
  })

  it('does not take bare dollars, plain inline code or a half-wrapped code for math', () => {
    const cases: PMNode[] = [
      docOf(para('It costs $5 and $10 today.')),
      docOf(para('Run ', { code: 'npm test' }, ' then ', { code: 'ls' }, '.')),
      docOf(para('Price $', { code: '5' }, ' only')),
      docOf(para('only ', { code: '5' }, '$ after')),
      docOf(para('$ ', { code: 'x' }, ' $')),
      docOf(para('$', { code: '  ' }, '$')),
      docOf(para('$x$ and $$y$$')),
    ]
    for (const doc of cases) {
      expect(findMath(doc), doc.textContent).toEqual([])
      expect(decos(doc, end(doc)), doc.textContent).toEqual([])
    }
  })

  it('lets one `$` close a formula or open the next, never both', () => {
    const doc = docOf(para('$', { code: 'a' }, '$', { code: 'b' }, '$'))
    expect(findMath(doc).map((m) => m.latex)).toEqual(['a'])
  })

  it('keys widgets by load status, so a finished load repaints them', () => {
    const doc = docOf(para('$', { code: 'x' }, '$ '), code('math', 'y'), para('after'))
    const keys = (status: 'loading' | 'ready' | 'failed') =>
      (buildMathDecorations(doc, end(doc), status).find() as unknown as Deco[]).map((d) => d.spec.key).filter(Boolean).sort()
    expect(keys('loading')).toEqual(['math:b:loading:0:y', 'math:i:loading:0:x'])
    expect(keys('failed')).toEqual(['math:b:failed:0:y', 'math:i:failed:0:x'])
  })
})

describe('KaTeX rendering of a formula', () => {

  it('returns flagged source instead of throwing before KaTeX is loaded', () => {
    expect(mathStatus()).toBe('idle')
    expect(shouldLoadMath()).toBe(true)
    const r = renderMath('<b>x</b>', false)
    expect(r.error).toBeTruthy()
    expect(r.html).toBe('&lt;b&gt;x&lt;/b&gt;')
  })

  it('renders valid latex and flags invalid latex without throwing', async () => {
    expect(await loadMath()).toBe(true)
    expect(mathStatus()).toBe('ready')
    expect(shouldLoadMath()).toBe(false)

    const ok = renderMath('\\frac{a}{b}', true)
    expect(ok.error).toBeNull()
    expect(ok.html).toContain('katex-display')
    expect(ok.html).toContain('mfrac')

    for (const bad of ['\\frac{a', '}', 'x^^2', '\\begin{matrix} a']) {
      let r: ReturnType<typeof renderMath> | undefined
      expect(() => { r = renderMath(bad, false) }, bad).not.toThrow()
      expect(r!.error, bad).toMatch(/ParseError/)
      expect(r!.html, bad).toContain('katex-error')
    }
    // An unknown command is not a parse error with throwOnError off: KaTeX paints it red in place.
    const unknown = renderMath('\\undefinedmacro{x}', false)
    expect(unknown.html).toContain('color:#cc0000')
  })

  it('keeps trust off: \\href and \\htmlClass do not produce links or classes', async () => {
    await loadMath()
    const r = renderMath('\\href{javascript:alert(1)}{x} \\htmlClass{evil}{y}', false)
    // The source survives only as text (the MathML annotation and the red fallback).
    expect(r.html).not.toMatch(/href=/)
    expect(r.html).not.toContain('<a ')
    expect(r.html).not.toMatch(/class="[^"]*evil/)
    expect(r.html).toContain('color:#cc0000')
  })
})
