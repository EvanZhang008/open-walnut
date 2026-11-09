/**
 * The letter body linker (src/lib/agent-html-refs.ts) copies the agent's HTML byte
 * for byte and only adds links; where the input is cut into chunks never changes
 * the output, and a huge attribute, comment or text never sits in memory whole.
 */
import { describe, expect, it } from 'vitest'
import { createAgentHtmlLinker, linkAgentHtml, NO_REFERRER_ATTRS, REF_TAG_MAX } from '../../src/lib/agent-html-refs.js'
import type { RefLinkOptions } from '../../src/lib/agent-text-refs.js'

const TOKEN = 'ab'.repeat(16)
const ADDED_RE = /<a href="[^"]*" target="_blank" rel="noopener noreferrer" data-walnut-ref="(?:url|file|task|letter)">([^<]*)<\/a>/g

/** The output with every anchor the linker wrapped around text, and every no-referrer insert, taken off again. */
function unwrap(html: string): string {
  return html.replace(ADDED_RE, '$1').replaceAll(NO_REFERRER_ATTRS, '')
}

/** What the linker makes of markup with no raw-text element: the attributes after each link tag's name. */
function nr(html: string): string {
  return html.replace(/<(a|area)(?=[\s/>])/gi, (_m, name: string) => `<${name}${NO_REFERRER_ATTRS}`)
}

function linked(html: string): Array<[string, string]> {
  return [...linkAgentHtml(html, { token: TOKEN }).matchAll(/data-walnut-ref="([a-z]+)">([^<]*)<\/a>/g)].map((m) => [m[1]!, m[2]!])
}

function chunked(html: string, sizes: (i: number) => number, opts: RefLinkOptions = { token: TOKEN }): string {
  const out: string[] = []
  const l = createAgentHtmlLinker({ ...opts, onOutput: (s) => out.push(s) })
  for (let i = 0, k = 0; i < html.length; k++) {
    const n = Math.max(1, sizes(k))
    l.write(html.slice(i, i + n))
    i += n
  }
  l.end()
  return out.join('')
}

const DOC = `<!DOCTYPE html>
<html lang="en"><HEAD><meta charset="utf-8"><title>/t/title.md</title>
<style>/* /s/style.css */ a { color: red }</style><script>var p = "/s/x.js"; if (a<b) {}</script></head>
<body class="x" data-path="/body/attr.ts" style="background:url(data:image/png;base64,QUJD/x/y.png)">
<!-- /c/comment.ts lt-mvx2abcd-9f3k -->
<h1>Report *not bold* # not a heading</h1>
<p>Built /repo/src/app.ts:10-20 and /repo/pkg/x.go#L5-L9; see https://ex.com/a?b=1&amp;c=2. Task mvu0ubnq-a02d, letter lt-mvx2abcd-9f3k.</p>
<p>Escaped &lt;/repo/esc.ts:3&gt; and /repo/a&#46;ts and caf&eacute; &copy x</p>
<pre>/repo/in/pre.md</pre><code>/repo/in/code.ts</code>
<a href="https://e.com/p/q.md">/a/inside/anchor.ts</a>
<button>/b/button.ts</button><select><option>/o/opt.ts<option>/o/opt2.ts</select>
<textarea>/t/area.ts</textarea><svg viewBox="0 0 1 1"><title>/svg/t.ts</title><text>/svg/x.ts</text></svg>
<math><mi>/m/x.ts</mi></math><template><p>/tpl/x.ts</p></template>
<p>after /repo/after.ts</p>
<task-ref id="mvu0ubnq-a02d" label="Fix &amp; ship"/> <task-ref id="mpwidref-0b1c"></task-ref>
<img src="data:image/gif;base64,R0lGOD/x/z.gif" alt="/alt/x.ts"><br/>
</body></html>`

describe('copies the source and only adds links', () => {
  it('keeps the doctype, tags, attributes, comments, entities and data URIs byte for byte', () => {
    const out = linkAgentHtml(DOC, { token: TOKEN, kinds: ['url', 'file', 'letter'] })
    expect(unwrap(out)).toBe(DOC)
  })

  it('records the original UTF-16 range separately for identical paths without putting it in the DOM', () => {
    const input = '<p>/repo/a.ts</p><p>/repo/a.ts</p><a href="/repo/a.ts:2">File</a>';
    const refs: Array<{ offset: number; path: string }> = [];
    const ends: number[] = [];
    const output = linkAgentHtml(input, { onFileReference: (offset, path, end) => { refs.push({ offset, path }); ends.push(end); } });
    expect(refs).toEqual([
      { offset: input.indexOf('/repo/a.ts'), path: '/repo/a.ts' },
      { offset: input.indexOf('/repo/a.ts', input.indexOf('/repo/a.ts') + 1), path: '/repo/a.ts' },
      { offset: input.indexOf('"/repo/a.ts:2"'), path: '/repo/a.ts' },
    ]);
    expect(ends).toEqual(refs.map((ref, i) => ref.offset + (i === 2 ? '"/repo/a.ts:2"'.length : '/repo/a.ts'.length)));
    expect(output).not.toContain('data-walnut-source-offset');
    expect(output).toBe(linkAgentHtml(input));
  });

  it('links visible text only', () => {
    expect(linked(DOC)).toEqual([
      ['file', '/repo/src/app.ts:10-20'],
      ['file', '/repo/pkg/x.go#L5-L9'],
      ['url', 'https://ex.com/a?b=1&amp;c=2'],
      ['task', 'mvu0ubnq-a02d'],
      ['letter', 'lt-mvx2abcd-9f3k'],
      ['file', '/repo/esc.ts:3'],
      ['file', '/repo/a&#46;ts'],
      ['file', '/repo/in/pre.md'],
      ['file', '/repo/in/code.ts'],
      ['file', '/repo/after.ts'],
      ['task', 'Fix &amp; ship'],
      ['task', 'mpwidref-0b1c'],
    ])
  })

  it('links text in the browser context, including comment ends and foreign-content exits', () => {
    for (const input of [
      '<!-- comment --!><p>/repo/a.ts</p>',
      '<![CDATA[ > <p>/repo/a.ts</p>',
      '<svg><style><p>/repo/a.ts</p>',
      '<svg><plaintext/></svg><p>/repo/a.ts</p>',
      // <meta> leaves foreign content, so the <p> after it is HTML.
      '<svg><meta><p>/repo/a.ts</p>',
    ]) {
      const whole = linkAgentHtml(input)
      expect(whole).toContain('data-walnut-ref="file">/repo/a.ts</a>')
      expect(unwrap(whole)).toBe(input)
      for (let cut = 1; cut < input.length; cut++) expect(chunked(input, (k) => k === 0 ? cut : 1, {})).toBe(whole)
    }
    // After a foreign-content exit through <meta>, <style> is HTML's raw-text style element:
    // the <p> in it is its text, never shown, so nothing in it is linked.
    for (const input of ['<svg><meta><style><p>/repo/a.ts</p>', '<svg><meta><style><p>/repo/a.ts</p></style>']) {
      expect(linkAgentHtml(input)).toBe(input)
      for (let cut = 1; cut < input.length; cut++) expect(chunked(input, (k) => k === 0 ? cut : 1, {})).toBe(input)
    }
    // Once the style element closes, text is linked again.
    const closed = '<svg><meta><style>/repo/s.css</style><p>/repo/a.ts</p>'
    expect(linked(closed)).toEqual([['file', '/repo/a.ts']])
    const noscript = '<noscript><p>/repo/a.ts</p></noscript>'
    expect(linkAgentHtml(noscript, { scriptingEnabled: false })).toContain('data-walnut-ref="file">/repo/a.ts</a>')
    expect(linkAgentHtml(noscript, { scriptingEnabled: true })).toBe(noscript)
  })

  it('decodes entities for the href and keeps them raw in the visible text', () => {
    const out = linkAgentHtml('<p>x &lt;/repo/esc.ts:3&gt; https://ex.com/a?b=1&amp;c=2</p>')
    expect(out).toContain('&lt;<a href="/open-ref?kind=file&amp;path=%2Frepo%2Fesc.ts&amp;line=3" target="_blank" rel="noopener noreferrer" data-walnut-ref="file">/repo/esc.ts:3</a>&gt;')
    expect(out).toContain('<a href="https://ex.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer" data-walnut-ref="url">https://ex.com/a?b=1&amp;c=2</a>')
    expect(linkAgentHtml('<p>/repo/a&#46;ts</p>')).toContain('path=%2Frepo%2Fa.ts')
  })

  it('writes a task-ref as a task anchor with its label, and leaves a bad or unwanted one', () => {
    expect(linkAgentHtml('<p><task-ref id="mvu0ubnq-a02d" label="Fix &amp; ship &lt;now&gt;"/></p>'))
      .toBe('<p><a href="/open-ref?kind=task&amp;id=mvu0ubnq-a02d" target="_blank" rel="noopener noreferrer" data-walnut-ref="task">Fix &amp; ship &lt;now&gt;</a></p>')
    for (const html of ['<task-ref id="bad id"/>', '<task-ref label="x"/>', '<task-ref id="9c1d4e2a"/>', '<task-ref id="hello" label="H"/>', '<a href="#"><task-ref id="mvu0ubnq-a02d"/></a>']) {
      expect(linkAgentHtml(html)).toBe(nr(html))
    }
    const big = `<task-ref id="mvu0ubnq-a02d" label="${'x'.repeat(REF_TAG_MAX)}"/>`
    expect(linkAgentHtml(big)).toBe(big)
    expect(linkAgentHtml('<task-ref id="mvu0ubnq-a02d"/> mvu0ubnq-a02d', { kinds: ['file', 'url', 'letter'] }))
      .toBe('<task-ref id="mvu0ubnq-a02d"/> mvu0ubnq-a02d')
  })

  it('points an agent anchor to a local file or letter at /open-ref, keeping its label and attributes', () => {
    expect(linkAgentHtml('<a class="k" href="/tmp/report.html">Report</a>', { token: TOKEN }))
      .toBe(`<a${NO_REFERRER_ATTRS} target="_blank" data-walnut-ref="file" class="k" href="/open-ref#token=${TOKEN}&amp;kind=file&amp;path=%2Ftmp%2Freport.html">Report</a>`)
    expect(linkAgentHtml('<a href=letter:lt-abc1234-9f3k target=_self title="t">L</a>'))
      .toBe(`<a${NO_REFERRER_ATTRS} data-walnut-ref="letter" href="/open-ref?kind=letter&amp;id=lt-abc1234-9f3k" target="_blank" title="t">L</a>`)
    expect(linkAgentHtml("<a target href='/r/My%20Notes.md#L4'>N</a>"))
      .toBe(`<a${NO_REFERRER_ATTRS} data-walnut-ref="file" target="_blank" href="/open-ref?kind=file&amp;path=%2Fr%2FMy%20Notes.md&amp;line=4">N</a>`)
    // A marker the agent wrote is replaced with the kind the destination really is.
    expect(linkAgentHtml('<a data-walnut-ref="task" href="/tmp/r.md" data-walnut-ref=url>R</a>'))
      .toBe(`<a${NO_REFERRER_ATTRS} target="_blank" data-walnut-ref="file" href="/open-ref?kind=file&amp;path=%2Ftmp%2Fr.md" data-walnut-ref=url>R</a>`)
    // A marker on an anchor that is not retargeted is the agent's own and stays.
    expect(linkAgentHtml('<a data-walnut-ref="file" href="https://e.com">E</a>')).toBe(nr('<a data-walnut-ref="file" href="https://e.com">E</a>'))
    for (const html of [
      '<a href="https://e.com/x/y.md">x</a>', '<a href="#top">x</a>', '<a href="/api/images/a.png">x</a>',
      '<a href="/tasks/mvu0ubnq-a02d">x</a>', '<a href="mailto:a@b.c">x</a>', '<a href="../up/x.md">x</a>', '<a>x</a>',
    ]) expect(linkAgentHtml(html)).toBe(nr(html))
  })

  it('survives malformed markup without touching it', () => {
    const bad = '<p>a < b /repo/x.ts<<<div <p class=x>/repo/y.ts</div></span><a href="/x"<p>'
      + '<!-- unterminated /repo/c.ts'
    const out = linkAgentHtml(bad)
    expect(unwrap(out)).toBe(bad)
    expect(linked(bad).map(([, t]) => t)).toEqual(['/repo/x.ts', '/repo/y.ts'])
    // Everything after <plaintext> is shown as text by a browser: never linked.
    expect(linkAgentHtml('<plaintext>/repo/x.ts</plaintext> /repo/y.ts')).toBe('<plaintext>/repo/x.ts</plaintext> /repo/y.ts')
    // An unclosed anchor keeps the rest unlinked.
    expect(linkAgentHtml('<a href="https://e.com">x /repo/y.ts')).toBe(nr('<a href="https://e.com">x /repo/y.ts'))
    // Uppercase raw-text tags.
    expect(linkAgentHtml('<SCRIPT>/repo/s.ts</SCRIPT>')).toBe('<SCRIPT>/repo/s.ts</SCRIPT>')
  })
})

describe('no link sends a Referer', () => {
  const ATTACK = '<meta name="referrer" content="unsafe-url"><a href="https://x.example/">x</a>'

  it('puts the no-referrer attributes first in every agent anchor and area, ahead of its own', () => {
    expect(linkAgentHtml(ATTACK)).toBe(`<meta name="referrer" content="unsafe-url"><a${NO_REFERRER_ATTRS} href="https://x.example/">x</a>`)
    // The agent's own rel / referrerpolicy come after, so the browser ignores them (first wins).
    expect(linkAgentHtml('<a referrerpolicy="unsafe-url" rel="opener" href="https://x.example/">x</a>'))
      .toBe(`<a${NO_REFERRER_ATTRS} referrerpolicy="unsafe-url" rel="opener" href="https://x.example/">x</a>`)
    for (const html of [
      '<A HREF="https://x.example/">x</A>', '<a/href="https://x.example/">x</a>', '<a\nhref=https://x.example/>x</a>',
      '<a>x</a>', '<map name=m><area shape=default href="https://x.example/"></map>',
      '<svg><a href="https://x.example/"><text>x</text></a></svg>', '<button><a href="https://x.example/">x</a></button>',
      '<a href="https://e.com"><a href="https://x.example/">nested</a></a>', '<p><abbr>x</abbr><address>y</address></p>',
    ]) expect(linkAgentHtml(html)).toBe(nr(html))
  })

  it('leaves an <a> that a browser reads as text alone', () => {
    for (const html of [
      '<script>"<a href=x>"</script>', '<style>/*<a href=x>*/</style>', '<textarea><a href=x>t</a></textarea>',
      '<title><a href=x></title>', '<xmp><a href=x></xmp>', '<iframe><a href=x></iframe>', '<plaintext><a href=x>',
      '<!-- <a href=x> -->',
    ]) expect(linkAgentHtml(html)).toBe(html)
  })

  it('also over an anchor longer than REF_TAG_MAX, retargeted or not', () => {
    const long = `<a title="${'t'.repeat(REF_TAG_MAX * 4)}" href="https://x.example/">x</a>`
    expect(linkAgentHtml(long)).toBe(nr(long))
    // Too long to retarget: the href stays as written, the attributes still go in.
    const longLocal = `<a title="${'t'.repeat(REF_TAG_MAX * 4)}" href="/tmp/r.md">x</a>`
    expect(linkAgentHtml(longLocal)).toBe(nr(longLocal))
    const huge = `<a href="data:text/plain,${'B'.repeat(2 * 1024 * 1024)}">x</a>`
    expect(chunked(huge, () => 64 * 1024, {})).toBe(nr(huge))
  })

  it('keeps meta tags so the security parser sees the same tree-building boundaries', () => {
    for (const bad of [
      '<meta name="referrer" content="unsafe-url">', '<META NAME=Referrer CONTENT=origin>', '<meta name=" referrer " content="always"/>',
      '<meta name="referrer">', '<meta content="unsafe-url" name="referrer" content="no-referrer">',
      '<meta http-equiv="refresh" content="0;url=https://x.example/">', '<meta HTTP-EQUIV=Refresh content=1>',
      '<meta name="referrer" content="no-referrer" http-equiv="refresh" content="0;url=/x">',
      '<meta name="refer&#114;er" content="unsafe-url">',
    ]) {
      expect(linkAgentHtml(`<p>a</p>${bad}<p>b</p>`)).toBe(`<p>a</p>${bad}<p>b</p>`)
      expect(linkAgentHtml(`<svg>${bad}</svg><a>${bad}</a>`)).toBe(`<svg>${bad}</svg><a${NO_REFERRER_ATTRS}>${bad}</a>`)
    }
    for (const good of [
      '<meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`, '<meta name="referrer" content="no-referrer">',
      '<meta name="referrer-x" content="unsafe-url">', '<meta http-equiv="refresh-x" content="0">', '<meta name="description" content="refresh">',
    ]) expect(linkAgentHtml(`<head>${good}</head>`)).toBe(`<head>${good}</head>`)
    // As text a browser does not parse, it stays.
    for (const html of ['<script>"<meta name=referrer content=unsafe-url>"</script>', '<textarea><meta http-equiv=refresh></textarea>', '<!-- <meta http-equiv=refresh> -->'])
      expect(linkAgentHtml(html)).toBe(html)
  })

  it('copies a meta too long to read whole at any chunking without holding it', () => {
    const pad = 'v'.repeat(REF_TAG_MAX + 1)
    for (const long of [`<meta name="viewport" content="${pad}">`, `<meta content="${pad}" name="referrer" content="unsafe-url">`]) {
      const doc = `<p>a</p>${long}<p>/repo/a.ts</p>`
      const one = linkAgentHtml(doc)
      expect(one).toContain(long)
      expect(one).toContain('<p><a ')
      for (const step of [1, 7, 512, REF_TAG_MAX, doc.length]) expect(chunked(doc, () => step, {})).toBe(one)
    }
    const huge = `<meta name="referrer" x="${'B'.repeat(4 * 1024 * 1024)}" content="unsafe-url"><p>after</p>`
    let held = 0
    let seen = 0
    const out: string[] = []
    const l = createAgentHtmlLinker({ onOutput: (s) => out.push(s) })
    for (let i = 0; i < huge.length; i += 64 * 1024) {
      l.write(huge.slice(i, i + 64 * 1024))
      seen = Math.min(huge.length, i + 64 * 1024)
      held = Math.max(held, (l as unknown as { raw: string }).raw.length)
    }
    l.end()
    expect(seen).toBe(huge.length)
    expect(held).toBeLessThan(128 * 1024)
    expect(out.join('')).toBe(huge)
  })

  it('at every cut point, retargeted and plain anchors alike', () => {
    for (const doc of [
      `${ATTACK}<p>/repo/a.ts</p>`,
      '<p>x<a class="k" href="/tmp/report.html" target=_self>R</a> <A\tHREF=letter:lt-abc1234-9f3k>L</A></p>',
      `<a title="${'t'.repeat(REF_TAG_MAX + 10)}" href="/tmp/r.md">x</a><area href=/tmp/y.md>`,
      '<head><meta charset=utf-8><meta name="referrer" content="unsafe-url"><meta http-equiv=refresh content="0;url=https://x.example/"></head><p>/repo/b.ts</p>',
    ]) {
      const one = linkAgentHtml(doc, { token: TOKEN })
      expect(one.split(NO_REFERRER_ATTRS).length - 1).toBe((doc.match(/<(a|area)[\s/>]/gi) ?? []).length)
      for (const meta of doc.match(/<meta[^>]*>/gi) ?? []) expect(one).toContain(meta)
      for (let cut = 1; cut < doc.length; cut++) {
        const got = chunked(doc, (k) => (k === 0 ? cut : 1 + (k % 97)))
        if (got !== one) expect({ doc: doc.slice(0, 80), cut, got }).toEqual({ doc: doc.slice(0, 80), cut, got: one })
      }
    }
  })
})

describe('chunking never changes the output', () => {
  const whole = linkAgentHtml(DOC, { token: TOKEN })

  it('at every single cut point', () => {
    for (let cut = 1; cut < DOC.length; cut++) {
      const sizes = (k: number) => (k === 0 ? cut : DOC.length)
      const got = chunked(DOC, sizes)
      if (got !== whole) expect({ cut, got }).toEqual({ cut, got: whole })
    }
  })

  it('at every cut point when a literal < precedes an entity in the same text', () => {
    for (const doc of [
      '<p>if a < b see /repo/src/a.ts &amp; more</p>',
      '<p>x <= y /a/b.ts &lt; z &amp; /c/d.md</p>',
      '<p>a <3 /r/x.ts &copy y /r/z.ts</p>',
    ]) {
      const one = linkAgentHtml(doc)
      expect(one).toContain('data-walnut-ref="file"')
      expect(unwrap(one)).toBe(doc)
      for (let cut = 1; cut < doc.length; cut++) {
        const got = chunked(doc, (k) => (k === 0 ? cut : doc.length), {})
        if (got !== one) expect({ doc, cut, got }).toEqual({ doc, cut, got: one })
      }
    }
  })

  it('for random chunk sizes', () => {
    let seed = 42
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed }
    for (let trial = 0; trial < 300; trial++) {
      const max = [2, 7, 31, 200][trial % 4]!
      expect(chunked(DOC, () => 1 + (next() % max))).toBe(whole)
    }
  })
})

describe('bounded on a large body', () => {
  it('keeps surrogate pairs together when each output chunk is encoded separately', () => {
    const source = `<!--${'x'.repeat(2044)}\u{1f642}${'z'.repeat(2048)}--><p>/repo/a.ts</p>`
    const output: Buffer[] = []
    const linker = createAgentHtmlLinker({ onOutput: (chunk) => output.push(Buffer.from(chunk, 'utf8')) })
    linker.write(source.slice(0, 4096))
    linker.write(source.slice(4096))
    linker.end()
    expect(Buffer.concat(output).toString('utf8')).toBe(linkAgentHtml(source))
  })

  /** Feed in 64KB chunks; the output may trail the input by little, whatever the input holds. */
  function maxLag(html: string, opts: RefLinkOptions = {}): { lag: number; out: string } {
    const out: string[] = []
    let outLen = 0
    const l = createAgentHtmlLinker({ ...opts, onOutput: (s) => { out.push(s); outLen += unwrap(s).length } })
    let lag = 0
    const CHUNK = 64 * 1024
    for (let i = 0; i < html.length; i += CHUNK) {
      l.write(html.slice(i, i + CHUNK))
      lag = Math.max(lag, Math.min(html.length, i + CHUNK) - outLen)
    }
    l.end()
    return { lag, out: out.join('') }
  }

  const MB = 1024 * 1024
  const cases: Array<[string, string]> = [
    ['a 12MB data URI attribute', `<p>x</p><img src="data:image/png;base64,${'A'.repeat(12 * MB)}"><p>/repo/a.ts</p>`],
    ['a 12MB data URI href', `<a href="data:text/plain,${'B'.repeat(12 * MB)}">x</a><p>/repo/a.ts</p>`],
    ['a 12MB comment', `<!--${'c'.repeat(12 * MB)}--><p>/repo/a.ts</p>`],
    ['a 12MB word with no break', `<p>${'w'.repeat(12 * MB)} /repo/a.ts</p>`],
    ['12MB of prose with paths', `<p>${'see /repo/a.ts and https://x.dev/y. '.repeat(330_000)}</p>`],
    ['a 12MB task-ref label', `<task-ref id="mvu0ubnq-a02d" label="${'l'.repeat(12 * MB)}"/><p>/repo/a.ts</p>`],
  ]
  for (const [name, html] of cases) {
    it(name, () => {
      const { lag, out } = maxLag(html)
      expect(lag).toBeLessThan(256 * 1024)
      expect(out).toContain('data-walnut-ref="file">/repo/a.ts</a>')
      if (!name.startsWith('12MB of prose')) expect(unwrap(out)).toBe(html)
    }, 60_000)
  }
})
