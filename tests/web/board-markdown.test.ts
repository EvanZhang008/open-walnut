/**
 * The Board's thread message renderer (web/src/components/board/board-markdown.frame.js):
 * light markdown, evaluated the way the frame loads it, but with a fake window
 * and no DOM (the file may touch nothing but `window.__wnBoardKit`). The escaper
 * is the core's own `esc`, read out of board-runtime.frame.js.
 *
 * Pins every supported construct, the literal fallbacks, CJK text, the safety
 * cases, and that a plain message renders exactly as it did before markdown.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const BOARD_DIR = fileURLToPath(new URL('../../web/src/components/board/', import.meta.url))
const SRC = fs.readFileSync(`${BOARD_DIR}board-markdown.frame.js`, 'utf-8')
const CORE = fs.readFileSync(`${BOARD_DIR}board-runtime.frame.js`, 'utf-8')

function coreEsc(): (s: unknown) => string {
  const map = /^\s*var ESC = \{.*\};$/m.exec(CORE)?.[0]
  const fn = /^\s*function esc\(s\) \{.*\}$/m.exec(CORE)?.[0]
  if (!map || !fn) throw new Error('board-runtime.frame.js no longer defines ESC and esc on one line each')
  return new Function(`${map}\n${fn}\nreturn esc;`)() as (s: unknown) => string
}

function loadRenderer(): (text: unknown) => string {
  const fakeWindow = { __wnBoardKit: { esc: coreEsc() } as Record<string, unknown> }
  new Function('window', SRC)(fakeWindow)
  const richText = fakeWindow.__wnBoardKit.richText
  if (typeof richText !== 'function') throw new Error('the renderer did not set kit.richText')
  return richText as (text: unknown) => string
}

const md = loadRenderer()

// The inertness check: only the renderer's own tags, attributes and nesting

const TAGS = new Set(['p', 'br', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'div', 'strong', 'em', 'del', 'a'])
const ATTRS: Record<string, RegExp> = {
  a: /^ class="wn-link" href="https?:\/\/[^"<>]*"$/,
  div: /^ class="wn-md-h"$/,
  ol: /^(?: start="\d{1,9}")?$/,
}

function expectTextInert(text: string, html: string): void {
  expect(text, html).not.toMatch(/[<>"']/)
  expect(text, html).not.toMatch(/&(?!(?:amp|lt|gt|quot|#39);)/)
}

/** Every tag is one the renderer makes, with only its fixed attributes, properly nested; text is escaped. */
function expectInert(html: string): void {
  const stack: string[] = []
  const re = /<(\/?)([a-z]+)([^<>]*)>/g
  let last = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    expectTextInert(html.slice(last, m.index), html)
    last = m.index + m[0].length
    const [, close, tag, attrs] = m
    expect(TAGS.has(tag), `tag <${tag}> in ${html}`).toBe(true)
    if (close) {
      expect(attrs, html).toBe('')
      expect(stack.pop(), html).toBe(tag)
      continue
    }
    expect(attrs, html).toMatch(ATTRS[tag] ?? /^$/)
    if (tag === 'a') expect(stack, `a link inside a link in ${html}`).not.toContain('a')
    if (tag !== 'br') stack.push(tag)
  }
  expectTextInert(html.slice(last), html)
  expect(stack, html).toEqual([])
}

describe('a plain message renders exactly as before', () => {
  it('escaped text, newlines as <br>, bare URLs linked with the trailing punctuation left out', () => {
    expect(md('a\nb')).toBe('a<br>b')
    expect(md('Hello')).toBe('Hello')
    expect(md('')).toBe('')
    expect(md(undefined)).toBe('')
    expect(md('Red because the probe timed out.\nRun: https://example.com/run/1.')).toBe(
      'Red because the probe timed out.<br>Run: <a class="wn-link" href="https://example.com/run/1">https://example.com/run/1</a>.')
    expect(md('(see https://example.com/a?b=1&c=2), then')).toBe(
      '(see <a class="wn-link" href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>), then')
    expect(md('Tom & Jerry say "hi" <3')).toBe('Tom &amp; Jerry say &quot;hi&quot; &lt;3')
    expect(md('a\r\nb')).toBe('a<br>b')
  })
})

describe('blocks', () => {
  it('a blank line separates paragraphs; single newlines inside one stay <br>', () => {
    expect(md('a\n\nb')).toBe('<p>a</p><p>b</p>')
    expect(md('a\nb\n\n\nc')).toBe('<p>a<br>b</p><p>c</p>')
  })

  it('bullet lists with -, * and +; a paragraph before and after', () => {
    expect(md('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(md('* a\n* b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(md('+ a')).toBe('<ul><li>a</li></ul>')
    expect(md('Done:\n- a\n- b\nNext.')).toBe('<p>Done:</p><ul><li>a</li><li>b</li></ul><p>Next.</p>')
    // A blank line between items keeps one list; an indented line continues its item.
    expect(md('- a\n\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(md('- item\n  continued\n- next')).toBe('<ul><li>item<br>continued</li><li>next</li></ul>')
  })

  it('numbered lists with 1. and 1); another start number is kept; a switch of kind starts a new list', () => {
    expect(md('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
    expect(md('1) a\n2) b')).toBe('<ol><li>a</li><li>b</li></ol>')
    expect(md('3. a\n4. b')).toBe('<ol start="3"><li>a</li><li>b</li></ol>')
    expect(md('1. a\n- b')).toBe('<ol><li>a</li></ol><ul><li>b</li></ul>')
    // Only a list starting at 1 interrupts a paragraph, so prose with a number stays prose.
    expect(md('Steps:\n3. x')).toBe('Steps:<br>3. x')
    expect(md('Steps:\n1. x')).toBe('<p>Steps:</p><ol><li>x</li></ol>')
  })

  it('one level of nesting, by two spaces or a tab', () => {
    expect(md('- a\n  - b\n  - c\n- d')).toBe('<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>')
    expect(md('- a\n\t- b')).toBe('<ul><li>a<ul><li>b</li></ul></li></ul>')
    expect(md('1. a\n   - b\n2. c')).toBe('<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>')
    // Deeper indents flatten into the one nested level.
    expect(md('- a\n  - b\n    - c')).toBe('<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>')
  })

  it('fenced code keeps its text verbatim (escaped, no formatting), closed or not', () => {
    expect(md('```js\nconst a = 1 < 2;\n**x** `y`\n```\nafter')).toBe(
      '<pre><code>const a = 1 &lt; 2;\n**x** `y`</code></pre><p>after</p>')
    expect(md('```\nunclosed\n- not a list')).toBe('<pre><code>unclosed\n- not a list</code></pre>')
    expect(md('Run:\n```\nnpm test\n```')).toBe('<p>Run:</p><pre><code>npm test</code></pre>')
  })

  it('> quotes, with blocks inside', () => {
    expect(md('> quoted\n> more')).toBe('<blockquote>quoted<br>more</blockquote>')
    expect(md('> - a\n> - b')).toBe('<blockquote><ul><li>a</li><li>b</li></ul></blockquote>')
    expect(md('> > nested')).toBe('<blockquote><blockquote>nested</blockquote></blockquote>')
    expect(md('You asked:\n> why?\nBecause.')).toBe('<p>You asked:</p><blockquote>why?</blockquote><p>Because.</p>')
  })

  it('# headings render as a bold line, never a big heading', () => {
    expect(md('# Title')).toBe('<div class="wn-md-h">Title</div>')
    expect(md('###### six')).toBe('<div class="wn-md-h">six</div>')
    expect(md('# C# notes #')).toBe('<div class="wn-md-h">C# notes</div>')
    expect(md('## Plan\n- a')).toBe('<div class="wn-md-h">Plan</div><ul><li>a</li></ul>')
    expect(md('####### seven')).toBe('####### seven')
    expect(md('#hashtag')).toBe('#hashtag')
  })
})

describe('inline', () => {
  it('`code` takes no formatting inside', () => {
    expect(md('`**x**` and `a < b`')).toBe('<code>**x**</code> and <code>a &lt; b</code>')
    expect(md('``a`b``')).toBe('<code>a`b</code>')
    expect(md('`https://example.com`')).toBe('<code>https://example.com</code>')
    expect(md('a ` b')).toBe('a ` b')
  })

  it('bold, italic and strike, each in both spellings where markdown has two', () => {
    expect(md('**bold** and __bold__')).toBe('<strong>bold</strong> and <strong>bold</strong>')
    expect(md('*it* and _it_')).toBe('<em>it</em> and <em>it</em>')
    expect(md('~~gone~~')).toBe('<del>gone</del>')
    expect(md('***both***')).toBe('<em><strong>both</strong></em>')
    expect(md('**a *b* c**')).toBe('<strong>a <em>b</em> c</strong>')
    expect(md('**two\nlines**')).toBe('<strong>two<br>lines</strong>')
  })

  it('[text](http link) and bare URLs; the link text may carry code and emphasis', () => {
    expect(md('[docs](https://example.com/a_(b))')).toBe('<a class="wn-link" href="https://example.com/a_(b)">docs</a>')
    expect(md('[`x` **y**](http://example.com)')).toBe('<a class="wn-link" href="http://example.com"><code>x</code> <strong>y</strong></a>')
    expect(md('**https://example.com**')).toBe('<strong><a class="wn-link" href="https://example.com">https://example.com</a></strong>')
    expect(md('https://example.com/a_b_c and https://example.com/*x*')).toBe(
      '<a class="wn-link" href="https://example.com/a_b_c">https://example.com/a_b_c</a> and '
      + '<a class="wn-link" href="https://example.com/*x">https://example.com/*x</a>*')
  })

  it('the literal fallbacks: unclosed **, snake_case, 2 * 3 * 4', () => {
    expect(md('**unclosed')).toBe('**unclosed')
    expect(md('snake_case_name and MAX_RETRY_COUNT')).toBe('snake_case_name and MAX_RETRY_COUNT')
    expect(md('2 * 3 * 4')).toBe('2 * 3 * 4')
    expect(md('*nix and *BSD')).toBe('*nix and *BSD')
    expect(md('~~ not strike ~~')).toBe('~~ not strike ~~')
    expect(md('[no link](not a url)')).toBe('[no link](not a url)')
  })

  it('mixed CJK text: asterisks work next to CJK; an underscore inside CJK stays literal', () => {
    expect(md('\u4fee\u590d **\u7f13\u5b58** \u5df2\u4e0a\u7ebf')).toBe('\u4fee\u590d <strong>\u7f13\u5b58</strong> \u5df2\u4e0a\u7ebf')
    expect(md('\u8fd9\u662f**\u91cd\u70b9**\u5185\u5bb9')).toBe('\u8fd9\u662f<strong>\u91cd\u70b9</strong>\u5185\u5bb9')
    expect(md('\u6587\u4ef6_\u540d_\u79f0')).toBe('\u6587\u4ef6_\u540d_\u79f0')
    expect(md('- **10-01 18:00Z \u6211\u7b54**\uff1a\u6587\u5b57\n- `CR-1` \u5f85\u5ba1'))
      .toBe('<ul><li><strong>10-01 18:00Z \u6211\u7b54</strong>\uff1a\u6587\u5b57</li><li><code>CR-1</code> \u5f85\u5ba1</li></ul>')
  })
})

describe('safety: a message never becomes markup', () => {
  it('html in the text is escaped, wherever it sits', () => {
    expect(md('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;')
    expect(md('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(md('**<b onclick=x>hi</b>**')).toBe('<strong>&lt;b onclick=x&gt;hi&lt;/b&gt;</strong>')
    expect(md('- <img src=x onerror=alert(1)>')).toBe('<ul><li>&lt;img src=x onerror=alert(1)&gt;</li></ul>')
    expect(md('```\n</code></pre><script>x</script>\n```')).toBe('<pre><code>&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;</code></pre>')
    expect(md('# <svg onload=x>')).toBe('<div class="wn-md-h">&lt;svg onload=x&gt;</div>')
  })

  it('only an http(s) link target becomes a link', () => {
    for (const target of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.example', 'https:evil']) {
      const html = md(`[x](${target})`)
      expect(html, target).not.toContain('<a')
      expect(html, target).toContain('[x](')
      expectInert(html)
    }
  })

  it('a quote in a URL cannot leave the href', () => {
    const linked = md('[x](https://a.com/"onmouseover=alert(1))')
    expect(linked).toBe('<a class="wn-link" href="https://a.com/&quot;onmouseover=alert(1)">x</a>')
    expectInert(linked)
    const bare = md('https://a.com/x"onmouseover="alert(1)')
    expect(bare).toBe('<a class="wn-link" href="https://a.com/x">https://a.com/x</a>&quot;onmouseover=&quot;alert(1)')
    expectInert(bare)
    expectInert(md("[x](https://a.com/'onmouseover=alert(1))"))
  })

  it('a NUL in the text cannot reach the renderer\'s own placeholders', () => {
    const html = md('a\u00000\u0000b `c` \u00001\u0000')
    expect(html).not.toContain('\u0000')
    expect(html).not.toContain('undefined')
    expect(html).toContain('<code>c</code>')
    expectInert(html)
  })

  it('every output of a seeded random mix of markdown and html stays inert and well nested', () => {
    const tokens = ['*', '**', '_', '__', '~~', '`', '```', '[', ']', '(', ')', '](', '<', '>', '"', "'", '&', '\n',
      '\n\n', '- ', '1. ', '  ', '\t', '# ', '> ', 'a', 'b c', 'snake_case', 'https://x.io/p', 'javascript:alert(1)',
      '<img src=x onerror=alert(1)>', '\u4e2d', '\u0000', ' ', '&quot;', '\u00001\u0000']
    let seed = 20261001
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let n = 0; n < 600; n++) {
      let s = ''
      const len = 1 + Math.floor(rand() * 40)
      for (let i = 0; i < len; i++) s += tokens[Math.floor(rand() * tokens.length)]
      expectInert(md(s))
    }
  })

  it('a long pathological message renders in bounded time (CPU time, so machine load does not count)', () => {
    const start = process.cpuUsage()
    md('**a '.repeat(2000))
    md('`'.repeat(4000) + 'x')
    md('> '.repeat(2000) + 'deep')
    md(Array.from({ length: 400 }, (_, i) => `${' '.repeat(i % 6)}- item ${i} _x_ *y*`).join('\n'))
    const used = process.cpuUsage(start)
    expect((used.user + used.system) / 1000).toBeLessThan(3000)
  })
})

describe('loading', () => {
  it('touches nothing but window.__wnBoardKit, and is a no-op without a kit', () => {
    const empty: Record<string, unknown> = {}
    new Function('window', SRC)(empty)
    expect(empty).toEqual({})
    expect(SRC).not.toMatch(/\b(document|customElements|postMessage|innerHTML)\b/)
  })
})
