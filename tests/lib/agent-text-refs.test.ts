/**
 * References in literal agent text (src/lib/agent-text-refs.ts): the shapes are the
 * browser's own, the hand-off href is one protocol, and how the text is chunked
 * never changes which references are found.
 */
import { describe, expect, it } from 'vitest'
import {
  findAgentTextRefs,
  isRefToken,
  linkAgentText,
  openRefHref,
  RefUnitSplitter,
  refsInUnit,
  REF_SEGMENT_MAX,
  REF_WORD_MAX,
  scanAgentTextRefs,
} from '../../src/lib/agent-text-refs.js'

const TOKEN = 'ab'.repeat(16)

function kinds(text: string): Array<[string, string]> {
  return findAgentTextRefs(text).map((r) => [r.kind, r.text])
}

describe('large URL runs', () => {
  it('trims long punctuation tails without repeatedly scanning the URL', () => {
    const input = 'https://example.com/x' + ')'.repeat(32_000);
    const start = performance.now();
    expect(findAgentTextRefs(input).map(ref => ref.href)).toEqual(['https://example.com/x']);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('openRefHref', () => {
  it('puts a valid token in the fragment and everything else in the query form', () => {
    expect(openRefHref({ kind: 'file', path: '/a b/c&d#e.md', line: 3, endLine: 9 }, { token: TOKEN }))
      .toBe(`/open-ref#token=${TOKEN}&kind=file&path=%2Fa%20b%2Fc%26d%23e.md&line=3&endLine=9`)
    expect(openRefHref({ kind: 'task', id: 'mvu0ubnq-a02d' })).toBe('/open-ref?kind=task&id=mvu0ubnq-a02d')
    expect(openRefHref({ kind: 'letter', id: 'lt-abc-1234' }, { refBase: 'https://h:3456/open-ref' }))
      .toBe('https://h:3456/open-ref?kind=letter&id=lt-abc-1234')
  })

  it('ignores a token that is not 32 lowercase hex, and an endLine not after line', () => {
    for (const bad of ['', 'ABCDEF0123456789abcdef0123456789', `${TOKEN}0`, 'x'.repeat(32)]) {
      expect(isRefToken(bad)).toBe(false)
      expect(openRefHref({ kind: 'task', id: 'x' }, { token: bad })).toBe('/open-ref?kind=task&id=x')
    }
    expect(openRefHref({ kind: 'file', path: '/a/b.ts', line: 5, endLine: 5 })).toBe('/open-ref?kind=file&path=%2Fa%2Fb.ts&line=5')
  })
})

describe('reference shapes', () => {
  it('finds URLs with the shared punctuation and CJK rules', () => {
    expect(kinds('see https://w.dev/wiki/Foo_(bar), and (https://x.dev/a).')).toEqual([
      ['url', 'https://w.dev/wiki/Foo_(bar)'], ['url', 'https://x.dev/a'],
    ])
    // CJK prose after a URL (fullwidth comma) ends it.
    expect(kinds('\u6253\u5f00 https://a.com/x\uff0c\u4e2a\u4eba')).toEqual([['url', 'https://a.com/x']])
  })

  it('finds absolute files with their position, never a path inside a URL or a relative one', () => {
    const refs = findAgentTextRefs('a /repo/src/app.ts:10-20 b ~/notes/H1 2026 Overview.md c /r/x.go#L5-L9 d ../lib/x.ts e https://h/p/q/x.md f /api/images/a.png')
    expect(refs.map((r) => [r.kind, r.path, r.line, r.endLine])).toEqual([
      ['file', '/repo/src/app.ts', 10, 20],
      ['file', '~/notes/H1 2026 Overview.md', undefined, undefined],
      ['file', '/r/x.go', 5, 9],
      ['url', undefined, undefined, undefined],
    ])
    expect(refs[0]!.text).toBe('/repo/src/app.ts:10-20')
  })

  it('links whole task ids and letter ids, never a bare prefix', () => {
    expect(kinds('task mvu0ubnq-a02d, uuid 2ac88910-1111-2222-3333-444455556666, prefix mvu0ubnq, letter lt-mvx2abcd-9f3k.'))
      .toEqual([['task', 'mvu0ubnq-a02d'], ['task', '2ac88910-1111-2222-3333-444455556666'], ['letter', 'lt-mvx2abcd-9f3k']])
  })

  it('honors kinds', () => {
    const text = 'https://a.com /a/b.ts mvu0ubnq-a02d lt-mvx2abcd-9f3k'
    expect(refsInUnit(text, { kinds: ['file', 'letter'] }).map((r) => r.kind)).toEqual(['file', 'letter'])
  })
})

describe('linkAgentText', () => {
  it('escapes every character and keeps markdown syntax literal', () => {
    const html = linkAgentText('*bold* # head `c` <b>&amp; /a/b.md:3')
    expect(html).toBe('*bold* # head `c` &lt;b&gt;&amp;amp; '
      + '<a href="/open-ref?kind=file&amp;path=%2Fa%2Fb.md&amp;line=3" target="_blank" rel="noopener noreferrer" data-walnut-ref="file">/a/b.md:3</a>')
  })
})

describe('units do not depend on chunking', () => {
  /** Units in order; pass-through (unscanned) text may arrive in any number of parts, so those are joined. */
  function unitsOf(pieces: string[]): string[] {
    const out: Array<{ start: number; scan: boolean; text: string }> = []
    const s = new RefUnitSplitter((text, start, scan) => {
      const last = out[out.length - 1]
      if (!scan && last && !last.scan) last.text += text
      else out.push({ start, scan, text })
    })
    for (const p of pieces) s.push(p)
    s.finish()
    return out.map((u) => `${u.start}:${u.scan ? 's' : 'r'}:${u.text}`)
  }

  it('gives the same units for any split, including word mode and an overlong word', () => {
    const text = 'line one /a/b.ts\nsecond <x> https://h/x\t'
      + 'w '.repeat(REF_SEGMENT_MAX / 2 + 10) + '/q/r.md ' + 'z'.repeat(REF_WORD_MAX + 50) + ' /s/t.ts\nend'
    const whole = unitsOf([text]).join('\n')
    let seed = 7
    for (let trial = 0; trial < 40; trial++) {
      const pieces: string[] = []
      for (let i = 0; i < text.length;) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        const n = 1 + (seed % 5000)
        pieces.push(text.slice(i, i + n))
        i += n
      }
      expect(unitsOf(pieces).join('\n')).toBe(whole)
    }
  })

  it('links in word mode, and never an overlong word', () => {
    const long = '/q/' + 'z'.repeat(REF_WORD_MAX + 10) + '.md'
    const text = 'w '.repeat(REF_SEGMENT_MAX) + '/repo/a.ts ' + long + ' /repo/b.ts'
    expect(findAgentTextRefs(text).map((r) => r.text)).toEqual(['/repo/a.ts', '/repo/b.ts'])
  })

  it('scans a range and stops at a unit end under a limit', () => {
    const text = '/a/b.ts\n'.repeat(1000)
    const { refs, end } = scanAgentTextRefs(text, { limit: 80 })
    expect(end % 8).toBe(0)
    expect(refs.length).toBe(end / 8)
    const rest = scanAgentTextRefs(text, { from: end })
    expect(refs.length + rest.refs.length).toBe(1000)
    expect(rest.refs[0]!.start).toBe(end)
  })
})
