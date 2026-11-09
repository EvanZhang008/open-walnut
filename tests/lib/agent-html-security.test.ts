/**
 * The security pass (src/lib/agent-html-security.ts) reads a document with
 * parse5's standard tokenizer and tree construction and only adds attributes
 * right after the name of a/area/meta/iframe start tags. Checked here: the bytes
 * it keeps, the contexts where a `<a` is or is not a tag (judged against parse5's
 * own parse of the OUTPUT, standing in for the reader), that the output never
 * depends on how the input is cut, the trusted prefix, and that memory stays flat
 * for a 100MB data URI, a 12MB comment, long text with 100k closed elements,
 * table text, and long names, references and doctypes. Then the read-only
 * callbacks the linker builds on: text runs as source spans with the tree's
 * linkable verdict, tags, the link tag name position and processedEnd().
 */
import { createHash } from 'node:crypto'
import { parse, type DefaultTreeAdapterTypes, type Token, type TokenHandler } from 'parse5'
import { afterEach, describe, expect, it } from 'vitest'

// Let the worker acknowledge result RPCs between CPU-bound document checks.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))
import { BoundedTokenizer } from '../../src/lib/agent-html-tokenizer.js'
import { BoundedAdapter } from '../../src/lib/agent-html-tree.js'
import {
  createAgentHtmlSecurity,
  IFRAME_EMPTY_ATTRS,
  LINK_SAFE_ATTRS,
  META_OFF_ATTRS,
  secureAgentHtml,
  sha256Utf16Hex,
  type AgentHtmlSecurityStats,
} from '../../src/lib/agent-html-security.js'

const L = LINK_SAFE_ATTRS
const M = META_OFF_ATTRS
const I = IFRAME_EMPTY_ATTRS

interface RunOpts { scriptingEnabled?: boolean; trustedPrefix?: string }

function run(input: string, opts: RunOpts = {}, cut?: (k: number) => number): string {
  const parts: string[] = []
  const pass = createAgentHtmlSecurity({ scriptingEnabled: opts.scriptingEnabled ?? false, trustedPrefix: opts.trustedPrefix, onOutput: (s) => parts.push(s) })
  if (!cut) pass.write(input)
  else {
    for (let i = 0, k = 0; i < input.length; k++) {
      const n = Math.max(1, cut(k))
      pass.write(input.slice(i, i + n))
      i += n
    }
  }
  pass.end()
  return parts.join('')
}

function runSplit(input: string, at: number, opts: RunOpts = {}): string {
  const parts: string[] = []
  const pass = createAgentHtmlSecurity({ scriptingEnabled: opts.scriptingEnabled ?? false, trustedPrefix: opts.trustedPrefix, onOutput: (s) => parts.push(s) })
  pass.write(input.slice(0, at))
  pass.write(input.slice(at))
  pass.end()
  return parts.join('')
}

function count(s: string, needle: string): number {
  return s.split(needle).length - 1
}

/** The output with every added attribute taken off again. */
function strip(s: string): string {
  return s.split(L).join('').split(M).join('').split(I).join('')
}

/** Elements of parse5's own parse of the output that lack what the pass adds (every namespace, template contents included). */
function unprotected(out: string, scriptingEnabled: boolean): string[] {
  const bad: string[] = []
  const walk = (node: DefaultTreeAdapterTypes.ParentNode): void => {
    for (const child of node.childNodes) {
      if (!('tagName' in child)) continue
      const get = (name: string): string | undefined => child.attrs.find((a) => a.name === name)?.value
      const t = child.tagName
      if ((t === 'a' || t === 'area') && (get('rel') !== 'noopener noreferrer' || get('referrerpolicy') !== 'no-referrer')) bad.push(`${t} ${JSON.stringify(child.attrs)}`)
      if (t === 'meta' && (get('name') !== '' || get('http-equiv') !== '')) bad.push(`meta ${JSON.stringify(child.attrs)}`)
      if (t === 'iframe' && get('srcdoc') !== '') bad.push(`iframe ${JSON.stringify(child.attrs)}`)
      if ('content' in child && child.content) walk(child.content)
      walk(child)
    }
  }
  walk(parse(out, { scriptingEnabled }))
  return bad
}

function elements(node: DefaultTreeAdapterTypes.ParentNode, into: DefaultTreeAdapterTypes.Element[] = []): DefaultTreeAdapterTypes.Element[] {
  for (const child of node.childNodes) {
    if (!('tagName' in child)) continue
    into.push(child)
    if ('content' in child && child.content) elements(child.content, into)
    elements(child, into)
  }
  return into
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Every way of cutting a short document in two, one character at a time, and random cuts: all the same output. */
function expectCutInvariant(input: string, opts: RunOpts = {}): string {
  const whole = run(input, opts)
  for (let at = 0; at <= input.length; at++) expect(runSplit(input, at, opts), `cut at ${at}`).toBe(whole)
  expect(run(input, opts, () => 1)).toBe(whole)
  const rnd = mulberry32(input.length)
  expect(run(input, opts, () => 1 + Math.floor(rnd() * 9))).toBe(whole)
  return whole
}

describe('agent-html-security: what it adds', () => {
  it('puts the attributes first in every link, meta and iframe start tag, and changes nothing else', () => {
    const input = '<p><a href="https://x" rel="opener" referrerpolicy="unsafe-url">x</a><AREA href=y>'
      + '<meta http-equiv="refresh" content="0;url=https://x"><meta charset="utf-8"><meta name="referrer" content="unsafe-url">'
      + '<iframe srcdoc="<a href=x>" src="https://x"></iframe><a/href=z><a\thref=w></a>'
    const out = secureAgentHtml(input, { scriptingEnabled: false })
    expect(out).toBe('<p><a' + L + ' href="https://x" rel="opener" referrerpolicy="unsafe-url">x</a><AREA' + L + ' href=y>'
      + '<meta' + M + ' http-equiv="refresh" content="0;url=https://x"><meta' + M + ' charset="utf-8"><meta' + M + ' name="referrer" content="unsafe-url">'
      + '<iframe' + I + ' srcdoc="<a href=x>" src="https://x"></iframe><a' + L + '/href=z><a' + L + '\thref=w></a>')
    expect(unprotected(out, false)).toEqual([])
    // The first of a repeated attribute wins, and a charset stays.
    const all = elements(parse(out, { scriptingEnabled: false }))
    const attr = (el: DefaultTreeAdapterTypes.Element, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value
    const link = all.find((el) => el.tagName === 'a' && attr(el, 'href') === 'https://x')!
    expect([attr(link, 'rel'), attr(link, 'referrerpolicy')]).toEqual(['noopener noreferrer', 'no-referrer'])
    const charset = all.find((el) => el.tagName === 'meta' && attr(el, 'charset') !== undefined)!
    expect([attr(charset, 'charset'), attr(charset, 'http-equiv')]).toEqual(['utf-8', ''])
  })

  it('keeps CSS, SVG, entities and every other byte as written', () => {
    const input = '<!doctype html><style>a[href^="x"]{color:red}/* <a href=x> */</style>'
      + '<svg viewBox="0 0 10 10"><path d="M0 0L10 10" stroke="#000"/><text>&lt;a&gt; &amp;amp;</text></svg>'
      + '<p class=x>&lt;a href=x&gt; text&nbsp;<img src="data:image/png;base64,AAAA"></p>\r\n<video src="data:video/mp4;base64,AAAA" controls></video>'
    expect(secureAgentHtml(input, { scriptingEnabled: false })).toBe(input)
  })
})

describe('agent-html-security: where a tag is a tag', () => {
  // [input, scripting, links, metas, iframes]
  const CASES: Array<[string, boolean, number, number, number]> = [
    ['<!--<a href=x>--><a href=y>', false, 1, 0, 0],
    ['<!--x--!><a href=y>', false, 1, 0, 0],
    ['<!--><a href=y>', false, 1, 0, 0],
    ['<!---><a href=y>', false, 1, 0, 0],
    ['<!-- -- --!x <a href=x> --><a href=y>', false, 1, 0, 0],
    ['<?php <a href=x> ?><a href=y>', false, 1, 0, 0],
    ['<![CDATA[<a href=x>]]><a href=y>', false, 1, 0, 0],
    ['<svg><![CDATA[<a href=x>]]><a href=y></svg>', false, 1, 0, 0],
    ['<style><a href=x></style><a href=y>', false, 1, 0, 0],
    ['<svg><style><a href=x></style></svg>', false, 1, 0, 0],
    ['<math><style><a href=x></style></math>', false, 1, 0, 0],
    ['<svg><p><style><a href=x></style>', false, 0, 0, 0],
    ['<plaintext><a href=x></plaintext><a href=y>', false, 0, 0, 0],
    ['<svg><plaintext><a href=x>', false, 1, 0, 0],
    ['<textarea><a href=x></textarea><title><a href=x></title><xmp><a href=x></xmp><noembed><a href=x></noembed><noframes><a href=x></noframes>', false, 0, 0, 0],
    ['<iframe src=x><a href=y></iframe><a href=z>', false, 1, 0, 1],
    ['<script>"<a href=x>"</script><a href=y>', false, 1, 0, 0],
    ['<script><!--<script>x</script><a href=x></script><a href=y>', false, 1, 0, 0],
    ['&lt;a href=x&gt; &#60;a href=x&#62;', false, 0, 0, 0],
    ['<template><a href=x><meta http-equiv=refresh content=0></template>', false, 1, 1, 0],
    ['<table><tr><a href=x></table>', false, 1, 0, 0],
    ['<select><a href=x></select>', false, 1, 0, 0],
    ['<noscript><a href=x></noscript>', false, 1, 0, 0],
    ['<noscript><a href=x></noscript>', true, 0, 0, 0],
    ['<head><noscript><meta http-equiv=refresh content=0></noscript></head><a href=y>', false, 1, 1, 0],
    ['<head><noscript><meta http-equiv=refresh content=0></noscript></head><a href=y>', true, 1, 0, 0],
    ['<math><mi><a href=x></mi></math>', false, 1, 0, 0],
    ['<math><annotation-xml encoding="text/html"><style><a href=x></style></annotation-xml></math>', false, 0, 0, 0],
    ['<math><annotation-xml encoding="x"><style><a href=x></style></annotation-xml></math>', false, 1, 0, 0],
    ['<svg><font color=red><style><a href=x></style>', false, 0, 0, 0],
    ['<svg><font><style><a href=x></style>', false, 1, 0, 0],
    ['<svg><foreignObject><style><a href=x></style><a href=y></foreignObject></svg>', false, 1, 0, 0],
    ['<frameset><style><a href=x></style><noframes><a href=y></noframes>', false, 1, 0, 0],
    ['<A HREF=1/><a\nhref=2><a\fhref=3><area/>', false, 4, 0, 0],
  ]

  for (const [input, scripting, links, metas, iframes] of CASES) {
    it(`${JSON.stringify(input)} (scripting ${scripting})`, () => {
      const out = expectCutInvariant(input, { scriptingEnabled: scripting })
      expect(strip(out)).toBe(input)
      expect([count(out, L), count(out, M), count(out, I)]).toEqual([links, metas, iframes])
      expect(unprotected(out, scripting)).toEqual([])
    })
  }

  it('tells two long tag names apart that share their first characters, and matches one with itself', () => {
    const a = 'x-' + 'n'.repeat(1000) + 'a'
    const b = 'x-' + 'n'.repeat(1000) + 'b'
    // A different end tag leaves <svg> open, so its <style> holds markup.
    const kept = `<div><${a}><svg></${b}><style><a href=x></style>`
    // The same end tag closes the svg too, so the <style> is raw text.
    const closed = `<div><${a}><svg></${a}><style><a href=x></style>`
    expect(count(run(kept), L)).toBe(1)
    expect(count(run(closed), L)).toBe(0)
    expect(unprotected(run(kept), false)).toEqual([])
    expect(unprotected(run(closed), false)).toEqual([])
  })

  it('fuzzed documents: every link, meta and iframe the output parses into is covered, and cuts never matter', () => {
    const FRAGMENTS = [
      '<a href=x>', '</a>', '<a rel=opener referrerpolicy=unsafe-url href=y>', '<area href=y>', '<meta http-equiv=refresh content="0;url=z">',
      '<meta charset=utf-8>', '<iframe srcdoc="<a href=q>">', '</iframe>', '<svg>', '</svg>', '<math>', '</math>', '<mi>', '<mglyph>',
      '<foreignObject>', '<desc>', '<annotation-xml encoding="text/html">', '<style>', '</style>', '<noscript>', '</noscript>',
      '<textarea>', '</textarea>', '<title>', '</title>', '<script>', '</script>', '<!--', '-->', '--!>', '<!-- c -->', '<![CDATA[', ']]>',
      '<table>', '</table>', '<tr>', '<td>', '<caption>', '<select>', '</select>', '<option>', '<template>', '</template>', '<b>', '</b>',
      '<b x=1>', '<i>', '</i>', '<font color=red>', '<font>', '</font>', '<p>', '</p>', '<div>', '</div>', '<input type=hidden>',
      'text', ' ', '\n', '&lt;a&gt;', '&amp', '&#60;', '<xmp>', '</xmp>', '<noembed>', '<noframes>', '</noframes>', '<frameset>',
      '<body>', '<head>', '<html>', '<a/', '>', '<A HREF=1/>', '<a\n', '"', "'", '=', '<', '</', '<!', '<?x>', '<!doctype html>',
      '<listing>', '<pre>', '<nobr>', '<button>', '<form>', '</form>', '<object>', '<applet>', '<marquee>', '<plaintext>',
    ]
    const rnd = mulberry32(20261107)
    for (let n = 0; n < 300; n++) {
      const len = 5 + Math.floor(rnd() * 60)
      let input = ''
      for (let k = 0; k < len; k++) input += FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)]
      const scripting = rnd() < 0.5
      const out = run(input, { scriptingEnabled: scripting })
      expect(strip(out), input).toBe(input)
      expect(unprotected(out, scripting), input).toEqual([])
      expect(run(input, { scriptingEnabled: scripting }, () => 1 + Math.floor(rnd() * 13)), input).toBe(out)
      expect(run(input, { scriptingEnabled: scripting }, () => 1), input).toBe(out)
    }
  })
})

describe('agent-html-security: the trusted prefix', () => {
  const PREFIX = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">'
    + '<meta name="referrer" content="no-referrer"><base target="_blank"><style>a{color:blue}</style></head><body>'
  const BODY = '<meta http-equiv=refresh content=0><a href=x>y</a>'
  const TAIL = '</body></html>'

  it('copies the prefix as written, still edits what follows, and every cut across the boundary agrees', () => {
    const input = PREFIX + BODY + TAIL
    const out = expectCutInvariant(input, { trustedPrefix: PREFIX })
    expect(out).toBe(PREFIX + '<meta' + M + ' http-equiv=refresh content=0><a' + L + ' href=x>y</a>' + TAIL)
  })

  it('takes part in the tree: what the prefix opened decides how the body is read', () => {
    const body = '<style><a href=x></style>'
    expect(count(run('<svg>' + body, { trustedPrefix: '<svg>' }), L)).toBe(1)
    expect(count(run(body), L)).toBe(0)
    expect(run('<a href=t>' + body, { trustedPrefix: '<a href=t>' })).toBe('<a href=t>' + body)
  })

  it('refuses input that does not start with the prefix, or ends inside it', () => {
    expect(() => run('<html><bad>', { trustedPrefix: '<html><head>' })).toThrow(/trustedPrefix/)
    expect(() => run('<html>', { trustedPrefix: '<html><head>' })).toThrow(/trustedPrefix/)
    const pass = createAgentHtmlSecurity({ scriptingEnabled: false, onOutput: () => {} })
    pass.end()
    expect(() => pass.write('x')).toThrow(/after end/)
  })
})

describe('agent-html-security: memory stays flat', () => {
  const PIECE = 64 * 1024

  interface Streamed { inLen: number; outLen: number; head: string; tail: string; links: number; metas: number; stats: AgentHtmlSecurityStats }

  function streamed(pieces: Array<[string, number]>): Streamed {
    const r = { inLen: 0, outLen: 0, head: '', tail: '', links: 0, metas: 0 }
    const pass = createAgentHtmlSecurity({
      scriptingEnabled: false,
      onOutput: (s) => {
        r.outLen += s.length
        if (r.head.length < 200) r.head += s.slice(0, 200 - r.head.length)
        r.tail = (r.tail + s).slice(-200)
        r.links += count(s, L)
        r.metas += count(s, M)
      },
    })
    for (const [piece, times] of pieces) {
      for (let i = 0; i < times; i++) { pass.write(piece); r.inLen += piece.length }
    }
    pass.end()
    return { ...r, stats: pass.stats() }
  }

  function expectFlat(s: AgentHtmlSecurityStats): void {
    expect(s.maxHeldChars).toBeLessThan(40_000)
    expect(s.maxBufferChars).toBeLessThan(100_000)
    expect(s.maxTokenChars).toBeLessThan(400)
    expect(s.maxOutputChunk).toBeLessThan(100_000)
    expect(s.maxPendingTableText).toBeLessThanOrEqual(2)
  }

  it('a 100MB data URI in a link (hashed, a formatting element) and in an image', () => {
    const A = 'A'.repeat(PIECE)
    const r = streamed([['<p><a href="data:text/plain,', 1], [A, 1600], ['">x</a><img src="data:image/png;base64,', 1], [A, 1600], ['"><a href=y>z</a>', 1]])
    expect(r.links).toBe(2)
    expect(r.outLen).toBe(r.inLen + 2 * L.length)
    expect(r.head.startsWith('<p><a' + L + ' href="data:text/plain,AAAA')).toBe(true)
    expect(r.tail.endsWith('AAAA"><a' + L + ' href=y>z</a>')).toBe(true)
    expectFlat(r.stats)
  }, 300_000)

  it('a 12MB comment, then a link after it', () => {
    // 8192 * 6 characters per piece, 250 pieces: 12.3MB.
    const r = streamed([['<!--', 1], ['c- -<!'.repeat(PIECE / 8), 250], ['--><a href=y>', 1]])
    expect(r.links).toBe(1)
    expect(r.outLen).toBe(r.inLen + L.length)
    expectFlat(r.stats)
  }, 120_000)

  it('long text and 100k closed elements keep the tree small', () => {
    const r = streamed([
      ['<body>', 1], ['word '.repeat(PIECE / 5), 160],
      ['<div><span>a</span><b>b</b><i class=c>c</i><br><img src=x><table><td>t</table><!-- n --></div>', 100_000],
      ['<a href=y>', 1],
    ])
    expect(r.links).toBe(1)
    expect(r.outLen).toBe(r.inLen + L.length)
    expect(r.stats.maxTreeNodes).toBeLessThan(10_000)
    expectFlat(r.stats)
  }, 300_000)

  it('text inside a table keeps one held token of each kind', () => {
    const r = streamed([['<table>', 1], ['a b\n', 300_000], ['</table><a href=y>', 1]])
    expect(r.links).toBe(1)
    expectFlat(r.stats)
  }, 120_000)

  it('long tag and attribute names, numeric references, doctype ids, bogus comments and script text', () => {
    const r = streamed([
      ['<!DOCTYPE html PUBLIC "', 1], ['p'.repeat(PIECE), 40], ['" "', 1], ['s'.repeat(PIECE), 40], ['">', 1],
      ['<x', 1], ['n'.repeat(PIECE), 80], [' ', 1], ['m'.repeat(PIECE), 80], ['=1>', 1],
      ['&#', 1], ['0'.repeat(PIECE), 80], ['65;', 1],
      ['<a title="&#x', 1], ['0'.repeat(PIECE), 80], ['41;" href=y>', 1],
      ['<?', 1], ['q'.repeat(PIECE), 80], ['>', 1],
      ['<script>', 1], ['var a = "<a href=x>";'.repeat(PIECE / 16), 80], ['</script><meta http-equiv=refresh content=0>', 1],
    ])
    expect(r.links).toBe(1)
    expect(r.metas).toBe(1)
    expect(r.outLen).toBe(r.inLen + L.length + M.length)
    expectFlat(r.stats)
  }, 300_000)
})

interface Observed {
  /** Text runs between boundaries: their source, and "L" when every segment was linkable, "N" when none, "M" mixed. */
  runs: string[]
  tags: string[]
  linkNames: string[]
}

/** Runs the callbacks and checks their contract as it goes: spans contiguous inside a run, never before processedEnd. */
function observe(input: string, opts: RunOpts = {}, cut?: (k: number) => number): Observed {
  const o: Observed = { runs: [], tags: [], linkNames: [] }
  let raw = ''
  let flags = ''
  let last = -1
  let floor = 0
  const close = (): void => {
    if (!flags) return
    o.runs.push(`${/^L+$/.test(flags) ? 'L' : /^N+$/.test(flags) ? 'N' : 'M'}:${raw}`)
    raw = ''
    flags = ''
    last = -1
  }
  const pass = createAgentHtmlSecurity({
    scriptingEnabled: opts.scriptingEnabled ?? false,
    trustedPrefix: opts.trustedPrefix,
    onOutput: () => {},
    onTextSegment: (s, e, linkable) => {
      expect(e).toBeGreaterThan(s)
      expect(s, 'a span before processedEnd').toBeGreaterThanOrEqual(floor)
      if (last >= 0) expect(s, 'a run is contiguous').toBe(last)
      last = e
      raw += input.slice(s, e)
      flags += linkable ? 'L' : 'N'
    },
    onMarkupBoundary: close,
    onTag: (name, s, e, closing, linkable) => o.tags.push(`${closing ? '/' : ''}${name}${linkable ? '' : '!'} ${input.slice(s, e)}`),
    onLinkTagName: (name, at) => o.linkNames.push(`${name}@${at}:${input.slice(at - name.length - 1, at)}`),
  })
  const step = (piece: string): void => {
    pass.write(piece)
    const pe = pass.processedEnd()
    expect(pe).toBeGreaterThanOrEqual(floor)
    floor = pe
  }
  if (!cut) step(input)
  else {
    for (let i = 0, k = 0; i < input.length; k++) {
      const n = Math.max(1, cut(k))
      step(input.slice(i, i + n))
      i += n
    }
  }
  pass.end()
  expect(pass.processedEnd()).toBe(input.length)
  close()
  return o
}

function linkable(o: Observed): string[] {
  return o.runs.filter((r) => r.startsWith('L:')).map((r) => r.slice(2).trim()).filter(Boolean)
}

function expectObserveCutInvariant(input: string, opts: RunOpts = {}): Observed {
  const whole = observe(input, opts)
  for (let at = 0; at <= input.length; at++) {
    expect(observe(input, opts, (k) => (k === 0 ? at : input.length)), `cut at ${at}`).toEqual(whole)
  }
  expect(observe(input, opts, () => 1)).toEqual(whole)
  const rnd = mulberry32(input.length + 1)
  expect(observe(input, opts, () => 1 + Math.floor(rnd() * 9))).toEqual(whole)
  return whole
}

describe('agent-html-security: the callbacks', () => {
  it('links text only where the tree puts it outside head, title, raw text, svg, math, template, a, button and form controls', () => {
    const doc = '<head><title>/t.md</title></head><body><p>see /a/b.ts and x</p><a href=y>/in/a.ts</a><button>/b.ts</button>'
      + '<select><option>/o.ts</select><textarea>/x.ts</textarea><style>/s.css</style><svg><text>/v.ts</text></svg>'
      + '<p>/after.ts</p><template>/tp.ts</template><math><mi>/m.ts</mi></math>'
    const o = expectObserveCutInvariant(doc)
    expect(linkable(o)).toEqual(['see /a/b.ts and x', '/after.ts'])
    for (const t of ['/t.md', '/in/a.ts', '/b.ts', '/o.ts', '/x.ts', '/s.css', '/v.ts', '/tp.ts', '/m.ts']) expect(o.runs).toContain(`N:${t}`)
  })

  it('follows the tokenizer: a comment closed by --!>, foreign exit, svg style, plaintext', () => {
    expect(linkable(expectObserveCutInvariant('<p><!--x--!>/after.ts'))).toEqual(['/after.ts'])
    expect(linkable(expectObserveCutInvariant('<svg><p>/p.ts</p>'))).toEqual(['/p.ts'])
    expect(linkable(expectObserveCutInvariant('<svg><style>/s.css</style></svg>/out.ts'))).toEqual(['/out.ts'])
    const plain = expectObserveCutInvariant('<p>/a.ts<plaintext>/p.ts <a href=x>/q.ts')
    expect(linkable(plain)).toEqual(['/a.ts'])
    expect(plain.runs).toContain('N:/p.ts <a href=x>/q.ts')
  })

  it('noscript: its markup is real with scripting off, raw text with it on', () => {
    const doc = '<body><noscript>/n.ts<p>/q.ts</p><a href=x>/in.ts</a></noscript>'
    expect(linkable(expectObserveCutInvariant(doc, { scriptingEnabled: false }))).toEqual(['/n.ts', '/q.ts'])
    const on = expectObserveCutInvariant(doc, { scriptingEnabled: true })
    expect(linkable(on)).toEqual([])
    expect(on.runs).toEqual(['N:/n.ts<p>/q.ts</p><a href=x>/in.ts</a>'])
  })

  it('a run spans its references from the & and is cut where the reader drops source', () => {
    const o = expectObserveCutInvariant('<p>/a&amp;b.ts&#32;&lt;x&gt; &notin; &notit;</p>')
    expect(o.runs).toEqual(['L:/a&amp;b.ts&#32;&lt;x&gt; &notin; &notit;'])
    expect(expectObserveCutInvariant('<p>ab</>cd').runs).toEqual(['L:ab', 'L:cd'])
    // The LF of a CRLF goes with the character after it; before markup it is in no run.
    expect(expectObserveCutInvariant('<p>a\r\nb /x.ts\r\n</p>').runs).toEqual(['L:a\r\nb /x.ts\r'])
    expect(expectObserveCutInvariant('<p>a < b <\n/c.ts</p>').runs).toEqual(['L:a < b <\n/c.ts'])
  })

  it('table text is judged where the tree inserts it: foster parented, or inside a reopened link', () => {
    expect(linkable(expectObserveCutInvariant('<table>/t.ts<tr><td>/c.ts</table>'))).toEqual(['/t.ts', '/c.ts'])
    const reopened = expectObserveCutInvariant('<p><a href=x>x</p><table>/in.ts</table>')
    expect(linkable(reopened)).toEqual([])
    expect(reopened.runs).toContain('N:/in.ts')
  })

  it('reports tags with their source and whether their place links, the element itself left out', () => {
    const o = expectObserveCutInvariant('<p>x</p><a href=y>t</a><svg><a>u</a></svg><b>v</b>')
    expect(o.tags).toEqual([
      'p <p>', '/p </p>', 'a <a href=y>', '/a </a>', 'svg <svg>', 'a! <a>', '/a! </a>', '/svg </svg>', 'b <b>', '/b </b>',
    ])
    expect(o.linkNames).toEqual(['a@10:<a', 'a@30:<a']) // an svg <a> gets the attributes too
    expect(linkable(o)).toEqual(['x', 'v'])
  })

  it('counts raw positions from the start of the trusted prefix, and reports no link tag name inside it', () => {
    const prefix = '<!doctype html><body><a href=t>/k.ts</a><div>'
    const doc = prefix + '/x.ts<area href=y></div>'
    const o = observe(doc, { trustedPrefix: prefix })
    for (let at = 0; at <= doc.length; at++) expect(observe(doc, { trustedPrefix: prefix }, (k) => (k === 0 ? at : doc.length))).toEqual(o)
    expect(o.linkNames).toEqual([`area@${prefix.length + 10}:<area`])
    expect(o.runs).toEqual(['N:/k.ts', 'L:/x.ts'])
    expect(o.tags).toContain('a <a href=t>')
  })

  it('CDATA in foreign content: its opener and its end are markup, with a run on each side, however it is cut', () => {
    expect(expectObserveCutInvariant('<svg>a<![CDATA[/b.ts]x]]y]]]>c]]>d</svg><p>/f.ts').runs)
      .toEqual(['N:a', 'N:/b.ts]x]]y]', 'N:c]]>d', 'L:/f.ts'])
    expect(expectObserveCutInvariant('<svg>x<![CDATA[]]>y</svg>').runs).toEqual(['N:x', 'N:y'])
    // A third "]" before the end is the CDATA text, reported at its own source.
    expect(expectObserveCutInvariant('<svg><![CDATA[]]]>').runs).toEqual(['N:]'])
    expect(expectObserveCutInvariant('<svg><![CDATA[]]]]>z').runs).toEqual(['N:]]', 'N:z'])
    // Unterminated: the text runs to the end of the input.
    expect(expectObserveCutInvariant('<svg> <![CDATA[<!--c--><textarea>x</table>').runs)
      .toEqual(['N: ', 'N:<!--c--><textarea>x</table>'])
    // The LF of a CRLF goes with the character after it; before markup it is in no run.
    expect(expectObserveCutInvariant('<svg>\r\n<![CDATA[/a.ts\r\n]]]>\r\nx</svg>').runs)
      .toEqual(['N:\r', 'N:/a.ts\r\n]', 'N:\r\nx'])
    // In HTML content it is a bogus comment, as before.
    expect(linkable(expectObserveCutInvariant('<p><![CDATA[x]]>/a.ts'))).toEqual(['/a.ts'])
  })

  it('fuzzed documents: the same runs and tags however they are cut', () => {
    const parts = ['<p>', '</p>', '<a href=x>', '</a>', '<table>', '<td>', '</table>', '<svg>', '</svg>', '<!--c-->', '&amp;', '&#x41;',
      ' /a/b.ts ', 'x', '\r\n', '</>', '<', '</', ']]>', '<![CDATA[', '<textarea>', '</textarea>', '<b>', '</b>', '<select>', '<noscript>']
    const rnd = mulberry32(99)
    for (let n = 0; n < 60; n++) {
      const doc = Array.from({ length: 4 + Math.floor(rnd() * 10) }, () => parts[Math.floor(rnd() * parts.length)]).join('')
      const whole = observe(doc)
      expect(observe(doc, undefined, () => 1), doc).toEqual(whole)
      expect(observe(doc, undefined, () => 1 + Math.floor(rnd() * 7)), doc).toEqual(whole)
    }
  })

  it('100MB of text: every character reported once, in runs cut at 16K, memory flat', () => {
    const PIECE = 64 * 1024
    const A = 'a'.repeat(PIECE)
    let sum = 0
    let maxSeg = 0
    let segs = 0
    let total = 0
    const pass = createAgentHtmlSecurity({
      scriptingEnabled: false,
      onOutput: () => {},
      onTextSegment: (s, e, ok) => {
        expect(ok).toBe(true)
        sum += e - s
        maxSeg = Math.max(maxSeg, e - s)
        segs++
      },
    })
    pass.write('<p>')
    total += 3
    for (let i = 0; i < 1600; i++) {
      pass.write(A)
      total += PIECE
      expect(pass.processedEnd()).toBe(total)
    }
    pass.write('</p>')
    pass.end()
    expect(sum).toBe(1600 * PIECE)
    expect(maxSeg).toBeLessThanOrEqual(16 * 1024)
    expect(segs).toBeGreaterThanOrEqual(1600 * 4)
    const st = pass.stats()
    expect(st.maxHeldChars).toBeLessThan(40_000)
    expect(st.maxBufferChars).toBeLessThan(100_000)
    expect(st.maxTokenChars).toBeLessThan(400)
  }, 300_000)
})

describe('agent-html-security: numeric references', () => {
  /** The characters and kept attributes the tokenizer emits, fed in pieces of `cut(k)` characters. */
  function decoded(input: string, cut?: (k: number) => number): { text: string; attrs: string[] } {
    const r = { text: '', attrs: [] as string[] }
    const chars = (t: Token.CharacterToken): void => { r.text += t.chars }
    const handler: TokenHandler = {
      onComment() {}, onDoctype() {}, onEndTag() {}, onEof() {},
      onStartTag(t: Token.TagToken) { for (const a of t.attrs) r.attrs.push(`${t.tagName}.${a.name}=${a.value}`) },
      onCharacter: chars, onNullCharacter: chars, onWhitespaceCharacter: chars,
    }
    const tok = new BoundedTokenizer({}, handler, { prefixLen: 0, adapter: new BoundedAdapter(), observe: false, insert() {}, boundary() {} })
    if (!cut) tok.write(input, false)
    else {
      for (let i = 0, k = 0; i < input.length; k++) {
        const n = Math.max(1, cut(k))
        tok.write(input.slice(i, i + n), false)
        i += n
      }
    }
    tok.write('', true)
    return r
  }

  /** The same decoding whole, cut once anywhere, one character at a time, and at random. */
  function expectDecoded(input: string, text: string, attrs: string[] = []): void {
    const whole = decoded(input)
    expect(whole, input.slice(0, 40)).toEqual({ text, attrs })
    for (let at = 1; at < input.length; at++) expect(decoded(input, (k) => (k === 0 ? at : input.length)), `cut at ${at}`).toEqual(whole)
    expect(decoded(input, () => 1)).toEqual(whole)
    const rnd = mulberry32(input.length + 7)
    expect(decoded(input, () => 1 + Math.floor(rnd() * 40))).toEqual(whole)
  }

  // Past 308 digits in one write the decoder's own sum overflowed (0 * Infinity = NaN for leading zeros).
  const Z = '0'.repeat(400)

  it('leading zeros count for nothing, decimal and hex, however the digits are cut', () => {
    expectDecoded(`&#${Z}65;`, 'A')
    expectDecoded(`&#x${Z}41;`, 'A')
    expectDecoded(`&#X${Z}20;`, ' ')
    expectDecoded(`&#${Z}65 b`, 'A b') // no semicolon: still a reference in text
    expectDecoded(`<font size="&#x${Z}33;">`, '', ['font.size=3'])
  })

  it('a value past U+10FFFF is U+FFFD, the decoder\'s own replacements stay, and the last code point is kept', () => {
    expectDecoded(`&#${'9'.repeat(400)};`, '\uFFFD')
    expectDecoded(`&#x${'f'.repeat(400)};`, '\uFFFD')
    expectDecoded(`&#1${Z};`, '\uFFFD')
    expectDecoded('&#1114112;', '\uFFFD')
    expectDecoded('&#x110000;', '\uFFFD')
    expectDecoded(`&#x${Z}10FFFF;`, String.fromCodePoint(0x10ffff))
    expectDecoded('&#128;', '\u20AC')
    expectDecoded('&#xD800;', '\uFFFD')
  })

  it('a 64K run of zeros in one write, through the whole pass', () => {
    const doc = `<p>&#${'0'.repeat(64 * 1024)}65;<a href=y>`
    expect(secureAgentHtml(doc, { scriptingEnabled: false })).toBe(`<p>&#${'0'.repeat(64 * 1024)}65;<a${L} href=y>`)
  })
})

describe('agent-html-security: the hash that keeps long names apart', () => {
  it('is SHA-256 over UTF-16BE code units, lone surrogates included', () => {
    const rnd = mulberry32(7)
    const samples = ['', 'abc', '\ud800', 'x\udc00y', 'a'.repeat(1000)]
    for (let n = 0; n <= 70; n++) samples.push(Array.from({ length: n }, () => String.fromCharCode(Math.floor(rnd() * 0x10000))).join(''))
    for (const s of samples) {
      expect(sha256Utf16Hex(s)).toBe(createHash('sha256').update(Buffer.from(s, 'utf16le').swap16()).digest('hex'))
    }
  })
})
