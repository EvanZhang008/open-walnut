import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs helper without type declarations
import { scoreReply, splitFences, isAsciiDiagramFence } from '../../scripts/lib/rich-output-score.mjs'

type Check = { name: string; ok: boolean; level: string }
const failed = (text: string, expectShape = {}) =>
  (scoreReply(text, expectShape).checks as Check[]).filter((c) => !c.ok && c.level === 'fail').map((c) => c.name)

const PROSE = 'The addon translates in both directions: JS values in, C values out, then a JS object back.'
const SVG_OK = '<svg viewBox="0 0 400 100" width="100%"><text fill="var(--fg)">a</text></svg>'

// Box-drawing glyphs as escapes: U+2500 horizontal, U+25B6 arrow head, U+250C/2510/2514/2518 corners,
// U+251C tee, U+2502 vertical.
const H = '\u2500'
const ARROW = '\u25b6'

describe('rich output scorer', () => {
  it('flags the reported shape: a call path drawn in an unlabelled fence', () => {
    const reply = `${PROSE}\n\n\`\`\`\nJS ${H}${H}call${H}${H}${ARROW} C++ ${H}${H}call${H}${H}${ARROW} SQLite\n\`\`\`\n`
    expect(failed(reply)).toContain('no ASCII diagram in a fence')
    expect(failed(reply, { svg: 'required' })).toContain('draws an svg')
  })

  it('flags boxes and plain-ASCII arrows in a text fence', () => {
    expect(failed('```\n\u250c\u2500\u2500\u2510\n\u2514\u2500\u2500\u2518\n```')).toContain('no ASCII diagram in a fence')
    expect(failed('```text\nbrowser --> server --> db\n```')).toContain('no ASCII diagram in a fence')
  })

  it('leaves real code alone even when it has arrows', () => {
    const cpp = '```cpp\nwhile (n --> 0) { node->next = p; }\n```'
    expect(failed(cpp, { code_lang: ['cpp'] })).toEqual([])
  })

  it('a file tree stays fenced and is not a drawing', () => {
    const tree = `\`\`\`\npkg/\n\u251c${H}${H} src/\n\u2502   \u2514${H}${H} main.py\n\u2514${H}${H} tests/\n\`\`\``
    const { fences } = splitFences(tree)
    expect(isAsciiDiagramFence(fences[0])).toBe(false)
    expect(failed(tree, { svg: 'forbidden', file_tree: true })).toEqual([])
    expect(failed('no tree here', { file_tree: true })).toContain('file tree stays fenced')
  })

  it('mermaid and a fenced svg are both wrong; html-app islands are allowed', () => {
    expect(failed('```mermaid\ngraph TD; A-->B\n```')).toContain('no mermaid')
    expect(failed(`\`\`\`html\n${SVG_OK}\n\`\`\``)).toContain('svg is inline, not fenced')
    expect(failed(`\`\`\`html-app\n${SVG_OK}<script>1</script>\n\`\`\``)).not.toContain('svg is inline, not fenced')
  })

  it('an svg must scale with the column', () => {
    expect(failed(`${PROSE}\n\n${SVG_OK}`, { svg: 'required' })).toEqual([])
    expect(failed(`${PROSE}\n\n<svg viewBox="0 0 660 190" width="660" height="190"></svg>`)).toContain('svg scales with the column')
    expect(failed(`${PROSE}\n\n<svg width="660"></svg>`)).toContain('svg scales with the column')
    expect(failed(`${PROSE}\n\n<svg viewBox="0 0 1 1" width="660" style="max-width:660px;width:100%"></svg>`)).toEqual([])
    expect(failed(`${PROSE}\n\n<svg viewBox="0 0 1 1" style="width:100%"></svg>`)).toEqual([])
  })

  it('an svg needs prose that carries the point without it', () => {
    expect(failed(SVG_OK)).toContain('prose carries the point beside the svg')
  })

  it('a short answer has no markup; a table answer has a markdown table', () => {
    expect(failed('Port **443**.', { svg: 'forbidden', html: 'forbidden' })).toEqual([])
    expect(failed('Port <b>443</b>.', { html: 'forbidden' })).toContain('no HTML at all')
    expect(failed('| a | b |\n| --- | --- |\n| 1 | 2 |', { table: true })).toEqual([])
    expect(failed('a: 1, b: 2', { table: true })).toContain('uses a markdown table')
  })

  it('a hand-built <pre> fails; the same text in a fence passes', () => {
    expect(failed('<pre>ls -la</pre>')).toContain('no hand-built <pre>')
    expect(failed('```console\n$ ls -la\n```', { fence: true })).toEqual([])
  })

  it('long CJK svg labels only warn', () => {
    const label = '\u4e2d'.repeat(20)
    const r = scoreReply(`${PROSE}\n\n<svg viewBox="0 0 1 1" width="100%"><text>${label}</text></svg>`, { svg: 'required' })
    expect(r.pass).toBe(true)
    expect((r.checks as Check[]).find((c) => c.name === 'svg labels stay short')?.ok).toBe(false)
  })

  it('an unclosed fence still counts as a fence', () => {
    expect(splitFences('```py\nx = 1').fences).toEqual([{ lang: 'py', body: 'x = 1', unclosed: true }])
  })
})
