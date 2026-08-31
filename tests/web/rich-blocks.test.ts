/**
 * Block-stable streaming for model-written HTML — the layer that decides whether
 * an interactive reply survives its own delivery.
 *
 * Two failure modes drive most of these cases:
 *  - a chunk boundary that MOVES as text arrives un-freezes a block the user is
 *    already interacting with (the radio stepper resets), which is the exact bug
 *    chunking exists to prevent. Hence the prefix-invariant property test: every
 *    prefix of every text must produce a stable list that is a prefix of the
 *    final one.
 *  - CSS that escapes its block restyles the WHOLE console from one chat message.
 *    scopeStyleHtml must therefore be paranoid, and must drop rather than guess.
 *
 * Both invariants are checked on realistic shapes, not minimal ones: the bugs live
 * in fences wrapping fences, `</div>` inside CSS, and tags mentioned in prose.
 */
import { describe, it, expect } from 'vitest';
import {
  splitRichChunks, scopeStyleHtml, hasRichContent, extractAppHtml, isAppComplete,
  richScopeId, richChunkKey, richChunkKeys,
  type RichChunk,
} from '@/utils/rich-blocks';

/** Everything a render would show, in order. */
function allChunks(text: string): RichChunk[] {
  const { stable, tail } = splitRichChunks(text);
  return tail ? [...stable, tail] : stable;
}

function kinds(text: string): string[] {
  return allChunks(text).map((c) => c.kind);
}

// ── Realistic shapes, reused by the property test ─────────────────────────────

const DETAILS = [
  'Here is the summary you asked for.',
  '',
  '<details>',
  '<summary>Why the deploy failed</summary>',
  '',
  'The dist was stale.',
  '',
  '</details>',
  '',
  'Want me to redeploy?',
].join('\n');

/** No blank lines anywhere inside — the whole widget must stay ONE chunk. */
const STEPPER = [
  'Pick a tier:',
  '',
  '<style>',
  '.step { display: flex }',
  '.step input:checked + label { background: #333 }',
  '/* a fake closer inside CSS: </div> must not count */',
  '</style>',
  '<div class="step">',
  '<input type="radio" id="a" name="t"><label for="a">A</label>',
  '<input type="radio" id="b" name="t"><label for="b">B</label>',
  '</div>',
  '',
  'That is the stepper.',
].join('\n');

const APP_FENCE = [
  'Try this calculator:',
  '',
  '```html-app',
  '<div id="out">0</div>',
  '<button onclick="document.getElementById(\'out\').textContent=1">Set</button>',
  '<script>console.log("hi")</script>',
  '```',
  '',
  'Click it.',
].join('\n');

/** A 4-backtick fence wrapping 3-backtick samples — the 2026-07-25 fence bug. */
const NESTED_FENCE = [
  'Copy this prompt verbatim:',
  '',
  '````',
  'Write me a page:',
  '',
  '```html',
  '<div class="x">',
  '',
  '</div>',
  '```',
  '',
  'Then stop.',
  '````',
  '',
  'Done.',
].join('\n');

const LOOSE_LIST = [
  'Three things:',
  '',
  '- first thing',
  '',
  '- second thing',
  '  with a continuation',
  '',
  '- third thing',
  '',
  'That is all.',
  '',
].join('\n');

const PROSE_WITH_CODE = [
  'You can wrap it in a `<div>` if you like.',
  '',
  'A `<style>` tag would work too, but is overkill.',
  '',
  'Here is a real one: <span class="x">ok</span>',
].join('\n');

/**
 * Angle brackets that are NOT markup: a scheme autolink, an email, a generic
 * parameter. Each one used to open a depth level that never closed, which pinned
 * depth above 0 and silently disabled chunking for the whole rest of the reply —
 * so the widget below them never froze.
 */
const PROSE_ANGLES = [
  'See <https://example.com/x> and mail <user@host> if Array<T> breaks.',
  '',
  '<div class="card">',
  '<p>Body</p>',
  '</div>',
  '',
  'Done.',
].join('\n');

/** Legal HTML the old counter got wrong: `<p>` implicitly ends the open `<p>`. */
const IMPLICIT_P = [
  'Intro line.',
  '',
  '<div><p>a',
  '<p>b</div>',
  '',
  'After.',
].join('\n');

/** Same widget over CRLF — every blank-line and fence rule must survive the \r. */
const CRLF_STEPPER = STEPPER.replace(/\n/g, '\r\n');

const TILDE_FENCE = [
  'Config sample:',
  '',
  '~~~yaml',
  'key: <value>',
  '',
  'other: 1',
  '~~~',
  '',
  'Done.',
].join('\n');

const PRE_BLOCK = [
  'Output:',
  '',
  '<pre>',
  '&lt;div&gt; literal',
  '',
  'more',
  '</pre>',
  '',
  'Done.',
].join('\n');

const NESTED_DETAILS = [
  'Two levels:',
  '',
  '<details>',
  '<summary>Outer</summary>',
  '',
  '<details>',
  '<summary>Inner</summary>',
  '',
  'Deep body.',
  '',
  '</details>',
  '',
  '</details>',
  '',
  'After.',
].join('\n');

const SHAPES: Array<[string, string]> = [
  ['details block', DETAILS],
  ['style + radio stepper', STEPPER],
  ['html-app fence', APP_FENCE],
  ['nested fence', NESTED_FENCE],
  ['loose list', LOOSE_LIST],
  ['prose with tags in inline code', PROSE_WITH_CODE],
  ['prose angles (autolink / email / generic)', PROSE_ANGLES],
  ['implicitly closed paragraphs', IMPLICIT_P],
  ['CRLF stepper', CRLF_STEPPER],
  ['tilde fence', TILDE_FENCE],
  ['pre block', PRE_BLOCK],
  ['nested details', NESTED_DETAILS],
];

describe('splitRichChunks — plain markdown', () => {
  it('returns nothing for empty text', () => {
    expect(splitRichChunks('')).toEqual({ stable: [], tail: null });
  });

  it('keeps a single paragraph as the tail, with nothing frozen', () => {
    const { stable, tail } = splitRichChunks('Just **prose**.');
    expect(stable).toEqual([]);
    expect(tail).toEqual({ kind: 'md', text: 'Just **prose**.' });
  });

  it('freezes a completed paragraph once the next one starts', () => {
    const { stable, tail } = splitRichChunks('First para.\n\nSecond para.');
    expect(stable).toEqual([{ kind: 'md', text: 'First para.\n\n' }]);
    expect(tail!.text).toBe('Second para.');
  });

  it('never freezes the last chunk, however finished it looks', () => {
    const { stable, tail } = splitRichChunks('<div>done</div>\n\n');
    expect(stable).toEqual([]);
    expect(tail!.text).toBe('<div>done</div>\n\n');
  });
});

describe('splitRichChunks — the streaming prefix invariant', () => {
  for (const [name, full] of SHAPES) {
    it(`holds for every prefix of the ${name}`, () => {
      const final = splitRichChunks(full).stable;
      for (let n = 1; n <= full.length; n += 7) {
        const prefix = full.slice(0, n);
        const { stable, tail } = splitRichChunks(prefix);
        // 1. Frozen chunks are append-only: what was frozen at any prefix is
        //    still frozen, byte for byte, in the finished text.
        expect(stable.length).toBeLessThanOrEqual(final.length);
        expect(final.slice(0, stable.length)).toEqual(stable);
        // 2. Nothing is invented or dropped along the way.
        expect(stable.map((c) => c.text).join('') + (tail?.text ?? '')).toBe(prefix);
      }
      const { stable, tail } = splitRichChunks(full);
      expect(stable.map((c) => c.text).join('') + (tail?.text ?? '')).toBe(full);
    });
  }
});

describe('splitRichChunks — code protection', () => {
  it('ignores tags inside a fence, so the fence stays one chunk', () => {
    // Blank lines INSIDE the fence must not cut, and the `<div class="x">` in
    // there must not open a depth level that blocks later boundaries.
    const chunks = allChunks(NESTED_FENCE);
    expect(chunks).toHaveLength(3); // prose · fence · "Done."
    expect(chunks[1].text).toContain('```html');
    expect(chunks[1].kind).toBe('md');
  });

  it('ignores tags inside an inline code span', () => {
    expect(kinds(PROSE_WITH_CODE)).toEqual(['md', 'md', 'html']);
  });

  it('keeps everything in the tail while a fence is unclosed', () => {
    const text = 'Here:\n\n```\nline one\n\nline two\n';
    const { stable, tail } = splitRichChunks(text);
    expect(stable).toEqual([{ kind: 'md', text: 'Here:\n\n' }]);
    expect(tail!.text).toBe('```\nline one\n\nline two\n');
  });
});

describe('splitRichChunks — HTML depth', () => {
  it('does not cut inside an open element', () => {
    const chunks = allChunks(DETAILS);
    expect(chunks).toHaveLength(3); // prose · <details>…</details> · prose
    expect(chunks[1].text).toContain('</details>');
    expect(chunks[1].kind).toBe('html');
  });

  it('treats a `</div>` inside <style> as CSS text, not a closer', () => {
    // If the rawtext rule were missing, depth would go negative-then-zero and the
    // widget would split at the blank line before "That is the stepper."
    const chunks = allChunks(STEPPER);
    expect(chunks).toHaveLength(3);
    expect(chunks[1].text).toContain('<style>');
    expect(chunks[1].text).toContain('</div>');
    expect(chunks[1].kind).toBe('html');
  });

  it('does not open depth on void or self-closing tags', () => {
    const text = 'One<br>two <img src="x.png" alt="">\n\nNext.\n\n<svg><path d="M0 0"/></svg>\n\nEnd.';
    expect(kinds(text)).toEqual(['html', 'md', 'html', 'md']);
  });

  it('ends a tag at the real `>`, not one inside a quoted attribute', () => {
    const text = '<div data-x="a>b">one</div>\n\nNext.';
    const chunks = allChunks(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('<div data-x="a>b">one</div>\n\n');
  });

  it('holds no boundary while a tag is still arriving', () => {
    const { stable } = splitRichChunks('Text.\n\n<div class="a\n\nmore');
    expect(stable).toEqual([{ kind: 'md', text: 'Text.\n\n' }]);
  });

  it('skips an unterminated comment to end of text', () => {
    const { stable } = splitRichChunks('Text.\n\n<!-- note\n\nstill in the comment');
    expect(stable).toEqual([{ kind: 'md', text: 'Text.\n\n' }]);
  });
});

describe('splitRichChunks — angle brackets that are not markup', () => {
  it('keeps chunking after an autolink, an email and a generic parameter', () => {
    // The regression: any of these read as an element that opens a depth level and
    // never closes, so every later blank line saw depth > 0 and NOTHING after it
    // ever froze — the widget the reply then wrote reset on every delta.
    const chunks = allChunks(PROSE_ANGLES);
    expect(chunks).toHaveLength(3); // prose · the card · "Done."
    expect(chunks[0].kind).toBe('md'); // …and the prose is not "html" either
    expect(chunks[1].text).toContain('</div>');
  });

  it('treats each shape as prose on its own', () => {
    expect(hasRichContent('See <https://example.com/x> for the plan.')).toBe(false);
    expect(hasRichContent('mail <user@host> about it')).toBe(false);
    expect(hasRichContent('an Array<T> of <string> values')).toBe(false);
    expect(kinds('See <https://example.com/x>.\n\nNext.\n')).toEqual(['md', 'md']);
  });

  it('still sees a real tag whose attribute value contains an @', () => {
    // `<user@host>` is prose because it has no whitespace; an attribute does.
    expect(hasRichContent('<a href="mailto:x@y">mail</a>')).toBe(true);
    const { stable } = splitRichChunks('<a href="mailto:x@y">m</a>\n\nNext.\n');
    expect(stable).toEqual([{ kind: 'html', text: '<a href="mailto:x@y">m</a>\n\n' }]);
  });
});

describe('splitRichChunks — the tag STACK, not a counter', () => {
  it('applies HTML5 implicit paragraph closing so a div still balances', () => {
    const chunks = allChunks(IMPLICIT_P);
    expect(chunks).toHaveLength(3);
    expect(chunks[1].text).toContain('<p>b</div>');
  });

  it('ignores a closer for an element that was never opened', () => {
    // A counter went NEGATIVE here and then read as "depth 0" one tag too early.
    const { stable } = splitRichChunks('<div>a</span></div>\n\nNext.\n');
    expect(stable).toEqual([{ kind: 'html', text: '<div>a</span></div>\n\n' }]);
  });

  it('unwinds a closer past unclosed inner elements', () => {
    const { stable } = splitRichChunks('<div><span>a</div>\n\nNext.\n');
    expect(stable).toEqual([{ kind: 'html', text: '<div><span>a</div>\n\n' }]);
  });

  it('does not cut while an element of a DIFFERENT name is still open', () => {
    expect(splitRichChunks('<section>\n<p>a</p>\n\n<p>b</p>\n').stable).toEqual([]);
  });

  it('closes an open li when the next li starts, and cells as HTML5 does', () => {
    const list = '<ul><li>a<li>b</ul>\n\nNext.\n';
    expect(splitRichChunks(list).stable).toEqual([{ kind: 'html', text: '<ul><li>a<li>b</ul>\n\n' }]);
    const table = '<table><tr><td>a<td>b<tr><td>c</table>\n\nNext.\n';
    expect(splitRichChunks(table).stable[0].text).toBe('<table><tr><td>a<td>b<tr><td>c</table>\n\n');
  });

  it('keeps nested same-name elements together', () => {
    const chunks = allChunks(NESTED_DETAILS);
    expect(chunks).toHaveLength(3);
    expect(chunks[1].text).toContain('Deep body.');
    expect(chunks[1].text.match(/<details>/g)).toHaveLength(2);
  });
});

describe('splitRichChunks — boundary timing', () => {
  it('does not cut at a blank line that ends the text', () => {
    expect(splitRichChunks('Para.\n\n').stable).toEqual([]);
  });

  it('cuts once a non-blank successor line arrives', () => {
    expect(splitRichChunks('Para.\n\nN').stable).toEqual([{ kind: 'md', text: 'Para.\n\n' }]);
  });

  it('keeps a blank run with the chunk it ends', () => {
    const { stable } = splitRichChunks('Para.\n\n\n\nNext.');
    expect(stable).toEqual([{ kind: 'md', text: 'Para.\n\n\n\n' }]);
  });

  it('never emits a whitespace-only chunk', () => {
    expect(splitRichChunks('\n\nPara.').stable).toEqual([]);
  });
});

describe('splitRichChunks — list continuity', () => {
  it('keeps a loose list in one chunk', () => {
    const chunks = allChunks(LOOSE_LIST);
    expect(chunks).toHaveLength(3); // intro · the whole list · outro
    expect(chunks[1].text).toContain('- first thing');
    expect(chunks[1].text).toContain('- third thing');
  });

  it('defers the decision while the successor line could still become a bullet', () => {
    // `-` alone is not list content; `- x` is. Cutting now and merging later
    // would move a frozen boundary, so after list content the cut waits until the
    // successor line is newline-terminated and can no longer change its mind.
    expect(splitRichChunks('- one\n\n-').stable).toEqual([]);
    expect(splitRichChunks('- one\n\n- two').stable).toEqual([]);
    expect(splitRichChunks('- one\n\nProse').stable).toEqual([]);
    expect(splitRichChunks('- one\n\nProse\n').stable).toEqual([{ kind: 'md', text: '- one\n\n' }]);
  });

  it('still cuts after a list when the next block is prose', () => {
    const { stable } = splitRichChunks('- one\n- two\n\nProse follows.\n');
    expect(stable).toEqual([{ kind: 'md', text: '- one\n- two\n\n' }]);
  });
});

describe('splitRichChunks — classification', () => {
  it('routes a script-bearing chunk to an app island', () => {
    const text = 'Watch:\n\n<div id="x"></div>\n<script>document.title="x"</script>\n\nDone.';
    expect(kinds(text)).toEqual(['md', 'app', 'md']);
  });

  it('routes a ```html-app fence to an app island, body only', () => {
    const chunks = allChunks(APP_FENCE);
    expect(chunks.map((c) => c.kind)).toEqual(['md', 'app', 'md']);
    const body = extractAppHtml(chunks[1]);
    expect(body).toContain('<div id="out">0</div>');
    expect(body).not.toContain('```');
    expect(isAppComplete(chunks[1])).toBe(true);
  });

  it('leaves a plain ```html fence as a markdown code SAMPLE', () => {
    const text = 'Like this:\n\n```html\n<div>hi</div>\n```\n\nSee?';
    expect(kinds(text)).toEqual(['md', 'md', 'md']);
  });

  it('calls an app chunk incomplete until its fence closes', () => {
    const open = allChunks('Try:\n\n```html-app\n<div>x</div>');
    expect(open[1].kind).toBe('app');
    expect(isAppComplete(open[1])).toBe(false);
  });

  it('closes an app fence that arrived over CRLF', () => {
    // Without the `\r?` the closer never matched, so a finished island stayed a
    // "building interactive block…" placeholder for the rest of the session.
    const crlf = 'Try:\r\n\r\n```html-app\r\n<div>x</div>\r\n```\r\n\r\nDone.';
    const chunks = allChunks(crlf);
    const app = chunks.find((c) => c.kind === 'app');
    expect(app).toBeDefined();
    expect(isAppComplete(app!)).toBe(true);
    expect(extractAppHtml(app!)).toContain('<div>x</div>');
    expect(extractAppHtml(app!)).not.toContain('```');
  });

  it('puts a leading <style> and the markup it styles in DIFFERENT chunks', () => {
    // Why the CSS scope is per MESSAGE and not per chunk: "here is the CSS, here
    // is the markup" is the shape a model writes most naturally, and the blank
    // line between the two IS a chunk boundary — so a chunk-scoped rule could
    // never match the element it was written for.
    const chunks = allChunks('<style>\n.led{color:red}\n</style>\n\n<div class="led">t</div>\n\nafter.');
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toContain('<style>');
    expect(chunks[1].text).toContain('class="led"');
  });

  it('calls a balanced script-bearing tail complete, so a reply can END with one', () => {
    const chunks = allChunks('Watch:\n\n<div><script>1</script></div>');
    expect(chunks[1].kind).toBe('app');
    expect(isAppComplete(chunks[1])).toBe(true);
    expect(isAppComplete({ kind: 'app', text: '<div><script>1</scr' })).toBe(false);
  });

  it('does not treat walnut ref pills as HTML', () => {
    const text = 'See <task-ref id="ab12cd34-9f0a" label="Fix it"/> for the rest.';
    expect(kinds(text)).toEqual(['md']);
    expect(hasRichContent(text)).toBe(false);
  });
});

describe('hasRichContent', () => {
  it('is false for text with no tag', () => {
    expect(hasRichContent('')).toBe(false);
    expect(hasRichContent('plain **markdown** and 3 < 5')).toBe(false);
  });

  it('is true for any real tag, even in code', () => {
    expect(hasRichContent('a `<div>` sample')).toBe(true);
    expect(hasRichContent('closing only: </div>')).toBe(true);
  });
});

describe('richScopeId / richChunkKey', () => {
  it('gives one attribute-safe id per message scope', () => {
    expect(richScopeId('m1')).toBe(richScopeId('m1'));
    expect(richScopeId('m2')).not.toBe(richScopeId('m1'));
    // Folded segment index (SuggestSegments) must not collide with the message.
    expect(richScopeId('m1#1')).not.toBe(richScopeId('m1'));
    expect(richScopeId('m1')).toMatch(/^rb[0-9a-z]+$/);
  });

  it('keys chunks by index within a scope', () => {
    const s = richScopeId('m1');
    expect(richChunkKey(s, 0)).toBe(richChunkKey(s, 0));
    expect(richChunkKey(s, 1)).not.toBe(richChunkKey(s, 0));
    expect(richChunkKey(richScopeId('m2'), 0)).not.toBe(richChunkKey(s, 0));
  });

  it('KEEPS a chunk key when the tail is promoted to stable', () => {
    // THE bug this contract exists for: promotion APPENDS the boundary blank line
    // to the chunk ("Second para." → "Second para.\n\n"), so a key that folded the
    // text in changed at exactly the moment the chunk became permanent. React then
    // unmounted the node — reloading an iframe island and resetting widget state,
    // which is the whole thing chunking is supposed to prevent.
    const prefix = 'First para.\n\nSecond para.';
    const full = 'First para.\n\nSecond para.\n\nThird para.';
    const promotedIndex = splitRichChunks(prefix).stable.length; // the tail's index
    expect(promotedIndex).toBe(1);
    // The promoted chunk really did change its text…
    expect(splitRichChunks(prefix).tail!.text).not.toBe(splitRichChunks(full).stable[1].text);
    // …and its key did not.
    const before = richChunkKeys(prefix, 'm1');
    const after = richChunkKeys(full, 'm1');
    expect(after[promotedIndex]).toBe(before[promotedIndex]);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('holds that promotion invariant across every realistic shape', () => {
    for (const [name, full] of SHAPES) {
      const finalKeys = richChunkKeys(full, 'm1');
      for (let n = 1; n <= full.length; n += 7) {
        const keys = richChunkKeys(full.slice(0, n), 'm1');
        // Every key a prefix rendered — the tail's included — is still that same
        // chunk's key in the finished message, so React never remounts a block.
        expect(keys.length, name).toBeLessThanOrEqual(finalKeys.length);
        expect(finalKeys.slice(0, keys.length), name).toEqual(keys);
      }
    }
  });
});

// ── CSS scoping ──────────────────────────────────────────────────────────────

const SCOPE = '[data-rblk="s1"]';

/** The CSS left inside the (single) style block after scoping. */
function scopedCss(css: string): string {
  const out = scopeStyleHtml(`<style>${css}</style>`, 's1');
  const m = /<style>([\s\S]*)<\/style>/.exec(out);
  expect(m).not.toBeNull();
  return m![1].replace(/\s+/g, ' ').trim();
}

describe('scopeStyleHtml', () => {
  it('leaves html without a style block untouched', () => {
    expect(scopeStyleHtml('<p>hi</p>', 's1')).toBe('<p>hi</p>');
  });

  it('prefixes a simple rule', () => {
    expect(scopedCss('.a { color: red }')).toBe(`${SCOPE} .a { color: red }`);
  });

  it('prefixes every selector in a comma list', () => {
    expect(scopedCss('.a, .b > i { color: red }'))
      .toBe(`${SCOPE} .a, ${SCOPE} .b > i { color: red }`);
  });

  it('remaps :root, html and body to the block itself', () => {
    expect(scopedCss(':root { --x: 1 }')).toBe(`${SCOPE} { --x: 1 }`);
    expect(scopedCss('body { margin: 0 }')).toBe(`${SCOPE} { margin: 0 }`);
    expect(scopedCss('HTML { color: red }')).toBe(`${SCOPE} { color: red }`);
  });

  it('recurses into @media, @supports and @container', () => {
    expect(scopedCss('@media (max-width: 500px) { .a { color: red } }'))
      .toBe(`@media (max-width: 500px) { ${SCOPE} .a { color: red } }`);
    expect(scopedCss('@supports (display: grid) { body { display: grid } }'))
      .toBe(`@supports (display: grid) { ${SCOPE} { display: grid } }`);
    expect(scopedCss('@container (min-width: 10px) { .a { color: red } }'))
      .toContain(`${SCOPE} .a`);
  });

  it('leaves a @keyframes BODY alone but renames the animation', () => {
    // `from`/`to` are not selectors; prefixing them would break the animation. The
    // NAME is the leak: `spin` is a document-wide identifier, so two replies (or a
    // reply and the app itself) defining it overwrite each other.
    expect(scopedCss('@keyframes spin { from { opacity: 0 } to { opacity: 1 } }'))
      .toBe('@keyframes spin-s1 { from { opacity: 0 } to { opacity: 1 } }');
    expect(scopedCss('@-webkit-keyframes spin { from { opacity: 0 } }'))
      .toBe('@-webkit-keyframes spin-s1 { from { opacity: 0 } }');
  });

  it('rewrites every reference to a renamed animation', () => {
    expect(scopedCss('.a { animation-name: spin } @keyframes spin { to { opacity: 1 } }'))
      .toBe(`${SCOPE} .a { animation-name: spin-s1 } @keyframes spin-s1 { to { opacity: 1 } }`);
    // The shorthand: only the NAME token moves, the rest of the value is untouched.
    expect(scopedCss('@keyframes spin { to { opacity: 1 } } .a { animation: spin 2s linear infinite }'))
      .toContain('animation: spin-s1 2s linear infinite');
    // A class or a string that happens to share the name is not a reference.
    const out = scopedCss('@keyframes spin { to { opacity: 1 } } .spin::after { content: "spin" }');
    expect(out).toContain(`${SCOPE} .spin::after`);
    expect(out).toContain('content: "spin"');
  });

  it('drops @font-face and @property, which register GLOBAL identifiers', () => {
    // Neither can be scoped: `font-family: X` rebinds the name X document-wide and
    // `@property --x` registers the custom property globally. A missing font falls
    // back to the stack, which is a far smaller problem.
    expect(scopedCss('@font-face { font-family: X; src: url(x.woff2) }')).toBe('');
    expect(scopedCss('@property --x { syntax: "<color>"; inherits: false }')).toBe('');
    expect(scopedCss('@font-face { font-family: X } .a { color: red }'))
      .toBe(`${SCOPE} .a { color: red }`);
  });

  it('drops @import entirely', () => {
    expect(scopedCss('@import url("evil.css"); .a { color: red }'))
      .toBe(`${SCOPE} .a { color: red }`);
  });

  it('survives braces and semicolons inside strings and url()', () => {
    expect(scopedCss('.a::after { content: "}" }')).toBe(`${SCOPE} .a::after { content: "}" }`);
    expect(scopedCss('.a { background: url(a{b.png) }')).toBe(`${SCOPE} .a { background: url(a{b.png) }`);
  });

  it('drops the whole block on unbalanced-brace garbage rather than leaking it', () => {
    // The failure mode this guards: half a rule surviving with NO scope prefix,
    // which restyles the entire console from one chat message.
    expect(scopedCss('.a { color: red')).toBe('');
    expect(scopedCss('.a { color: red } }')).toBe('');
    expect(scopedCss('.a { content: "unterminated }')).toBe('');
  });

  it('drops a truncated trailing rule, keeping nothing unscoped', () => {
    expect(scopedCss('.a { color: red } .b')).toBe('');
  });

  it('renames an animation defined in a DIFFERENT style block of the same message', () => {
    // Chunk 1 uses it, chunk 2 defines it — both share the message's scope, so the
    // rename pass has to run after every block has been walked, not per block.
    const out = scopeStyleHtml(
      '<style>.a{animation: spin 2s linear infinite}</style><div></div><style>@keyframes spin{to{opacity:1}}</style>',
      's1',
    );
    expect(out).toContain('animation: spin-s1 2s linear infinite');
    expect(out).toContain('@keyframes spin-s1');
  });

  it('scopes several style blocks in one html string', () => {
    const out = scopeStyleHtml('<style>.a{color:red}</style><p>x</p><style>.b{color:blue}</style>', 's1');
    expect(out).toContain(`${SCOPE} .a {color:red}`);
    expect(out).toContain(`${SCOPE} .b {color:blue}`);
  });

  it('refuses to let a scope id break out of the attribute selector', () => {
    expect(scopeStyleHtml('<style>.a{color:red}</style>', 'x"] , * ')).toContain('[data-rblk="x"]');
  });
});
