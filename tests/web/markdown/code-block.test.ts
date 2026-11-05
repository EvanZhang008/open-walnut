import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs, markdownToRichHtml, renderToolResultWithRefs } from '@/utils/markdown';
import { highlightCodeBlocks, highlightCodeInner, keepHyphens, markLines, parseFenceInfo, MAX_HIGHLIGHT_CHARS } from '@/utils/code-block';

/**
 * Fenced code in the in-app render: a header (language label, Wrap, Copy) and
 * Prism colors, with the links earlier passes put inside code kept intact
 * (web/src/utils/code-block.ts). Outside the app (copy as rich text) a block is
 * still marked's bare <pre><code>.
 */

const doc = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

/** The text a reader sees in a block's code, entities decoded. */
const codeText = (html: string) => doc(html).querySelector('.md-code pre code')?.textContent ?? null;

describe('code block frame', () => {
  it('wraps a fenced block in a header with the language and both buttons', () => {
    const d = doc(renderMarkdownWithRefs('Run this:\n\n```ts\nconst a: number = 1;\n```\n\nDone.'));
    const frame = d.querySelector('.md-code')!;
    expect(frame).not.toBeNull();
    expect(frame.querySelector('.md-code-lang')!.textContent).toBe('TypeScript');
    expect(frame.querySelector('[data-md-code-action="copy"]')!.getAttribute('type')).toBe('button');
    expect(frame.querySelector('[data-md-code-action="wrap"]')!.textContent).toBe('Wrap');
    // Copy's outcome has a live region to be read out from.
    expect(frame.querySelector('.md-code-status')!.getAttribute('aria-live')).toBe('polite');
    // The header is skipped by the in-app find bar (page-find.ts FIND_SKIP_SELECTOR).
    expect(frame.querySelector('.md-code-head')!.hasAttribute('data-find-skip')).toBe(true);
    const code = frame.querySelector('pre > code')!;
    expect(code.className).toBe('language-ts');
    // Focusable: a keyboard reaches a long line's sideways scroll.
    expect(frame.querySelector('pre')!.getAttribute('tabindex')).toBe('0');
    expect(code.textContent).toBe('const a: number = 1;\n');
    // Prose around the block is untouched.
    expect(d.querySelectorAll('p')).toHaveLength(2);
  });

  it('colors tokens and keeps the code text byte for byte', () => {
    const src = 'function f(x) {\n  // note <b> & "q"\n  return `a ${x}` + \'<i>\';\n}';
    const html = renderMarkdownWithRefs('```js\n' + src + '\n```');
    const d = doc(html);
    // A run of whitespace joins the span before it (fewer spans): compare trimmed.
    expect(d.querySelector('.md-code .token.keyword')!.textContent!.trim()).toBe('function');
    expect(d.querySelector('.md-code .token.comment')!.textContent!.trim()).toBe('// note <b> & "q"');
    // No markup from the code itself became markup.
    expect(d.querySelector('.md-code b, .md-code i')).toBeNull();
    expect(codeText(html)).toBe(src + '\n');
  });

  it('a block with no language gets the frame, a "Text" label and no colors', () => {
    const d = doc(renderMarkdownWithRefs('```\nplain words here\n```'));
    expect(d.querySelector('.md-code-lang')!.textContent).toBe('Text');
    expect(d.querySelector('.md-code .token')).toBeNull();
    expect(d.querySelector('.md-code pre code')!.textContent).toBe('plain words here\n');
  });

  it('an unknown language shows its name and stays plain', () => {
    const d = doc(renderMarkdownWithRefs('```mermaid\ngraph TD; A-->B\n```'));
    expect(d.querySelector('.md-code-lang')!.textContent).toBe('mermaid');
    expect(d.querySelector('.md-code .token')).toBeNull();
    expect(d.querySelector('.md-code pre code')!.textContent).toBe('graph TD; A-->B\n');
  });

  it('every block of a reply gets its own frame', () => {
    const d = doc(renderMarkdownWithRefs('```py\nx = 1\n```\n\ntext\n\n```bash\necho hi\n```\n\n~~~json\n{"a": 1}\n~~~'));
    expect([...d.querySelectorAll('.md-code-lang')].map((e) => e.textContent)).toEqual(['Python', 'Shell', 'JSON']);
  });

  it('inline code is not a block', () => {
    const d = doc(renderMarkdownWithRefs('Call `foo()` now.'));
    expect(d.querySelector('.md-code')).toBeNull();
    expect(d.querySelector('code')!.textContent).toBe('foo()');
  });

  it('a block still streaming (no closing fence yet) renders framed and colored', () => {
    const d = doc(renderMarkdownWithRefs('Here:\n\n```ts\nconst a = 1;\nconst b = "unterminated'));
    expect(d.querySelector('.md-code-lang')!.textContent).toBe('TypeScript');
    expect(d.querySelector('.md-code .token.keyword')!.textContent!.trim()).toBe('const');
  });

  it('a fence inside a list item gets the frame', () => {
    const d = doc(renderMarkdownWithRefs('1. Install:\n\n   ```sh\n   npm i\n   ```\n2. Run'));
    expect(d.querySelector('li .md-code')).not.toBeNull();
  });

  it('a block is drawn unwrapped, its Wrap button naming that block', () => {
    const btn = doc(renderMarkdownWithRefs('```ts\nconst a = 1;\n```')).querySelector('[data-md-code-action="wrap"]')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Wrap long lines');
    expect(doc(renderMarkdownWithRefs('```ts\nconst a = 1;\n```')).querySelector('.md-code')!.hasAttribute('data-wrap')).toBe(false);
  });

  it('each block has its own key, the same on every render and while it streams', () => {
    const keys = (md: string) => [...doc(renderMarkdownWithRefs(md)).querySelectorAll('.md-code')].map((f) => f.getAttribute('data-md-code-key'));
    // Two blocks with the same first line in one message are still two.
    const two = keys('```sh\ncd repo\nmake\n```\n\nthen\n\n```sh\ncd repo\nmake test\n```');
    expect(two).toHaveLength(2);
    expect(two[0]).toMatch(/^[0-9a-z-]+$/);
    expect(two[0]).not.toBe(two[1]);
    // Counted per message: the next message's first block is block 0 again.
    expect(keys('```sh\ncd repo\nmake\n```')[0]).toBe(two[0]);
    // A streaming block keeps its key as lines arrive and when its fence closes.
    let live = 'Writing:\n\n```ts\nconst first = 1;\n';
    const k0 = keys(live)[0];
    for (let i = 0; i < 5; i++) {
      live += `const n${i} = ${i};\n`;
      expect(keys(live)[0]).toBe(k0);
    }
    expect(keys(live + '```\n\nDone.')[0]).toBe(k0);
    // Another language or first line is another block.
    expect(keys('```js\nconst first = 1;\n```')[0]).not.toBe(k0);
  });

  it('trailing blank lines are neither drawn nor part of the code', () => {
    const d = doc(renderMarkdownWithRefs('```py\ndef f():\n    return 1\n\n\n  \n```'));
    expect(d.querySelector('.md-code pre code')!.textContent).toBe('def f():\n    return 1\n');
  });

  it('model-written markup in the fence word cannot inject attributes, and names nothing', () => {
    const d = doc(renderMarkdownWithRefs('```"><img src=x onerror=alert(1)>\nx\n```'));
    expect(d.querySelector('img')).toBeNull();
    expect(d.innerHTML).not.toContain('onerror');
    expect(d.querySelector('.md-code-lang')!.textContent).toBe('Text');
  });

  it('a long finished block is marked to open folded, with its line count; a streaming one never', () => {
    const body = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const done = doc(renderMarkdownWithRefs('```ts\n' + body + '\n```'));
    expect(done.querySelector('.md-code')!.hasAttribute('data-long')).toBe(true);
    expect(done.querySelector('[data-md-code-action="expand"]')!.textContent).toBe('Show all 80 lines');
    // Named by its word ("Fold"), as a voice command would say it.
    expect(done.querySelector('[data-md-code-action="fold"]')!.textContent).toBe('Fold');
    expect(done.querySelector('[data-md-code-action="fold"]')!.hasAttribute('aria-label')).toBe(false);
    const live = doc(renderMarkdownWithRefs('```ts\n' + body + '\n'));
    expect(live.querySelector('.md-code')!.hasAttribute('data-long')).toBe(false);
    expect(live.querySelector('.md-code')!.hasAttribute('data-open')).toBe(true);
    expect(live.querySelector('[data-md-code-action="expand"]')).toBeNull();
    expect(live.querySelector('[data-md-code-action="fold"]')).toBeNull();
    // Same block, same key: the streaming copy is how the closed one is known.
    expect(live.querySelector('.md-code')!.getAttribute('data-md-code-key')).toBe(done.querySelector('.md-code')!.getAttribute('data-md-code-key'));
    const short = doc(renderMarkdownWithRefs('```ts\nconst a = 1;\n```'));
    expect(short.querySelector('.md-code')!.hasAttribute('data-long')).toBe(false);
    expect(short.querySelector('[data-md-code-action="fold"]')).toBeNull();
  });

  it('an empty block is marked so it offers nothing to copy', () => {
    expect(doc(renderMarkdownWithRefs('```ts\n```')).querySelector('.md-code')!.hasAttribute('data-empty')).toBe(true);
    expect(doc(renderMarkdownWithRefs('```ts\nx\n```')).querySelector('.md-code')!.hasAttribute('data-empty')).toBe(false);
  });

  it("a diff's added and removed lines are marked, its file headers are not", () => {
    const d = doc(renderMarkdownWithRefs('```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\n```'));
    expect([...d.querySelectorAll('.md-code-ln-del')].map((l) => l.textContent)).toEqual(['-old']);
    expect([...d.querySelectorAll('.md-code-ln-add')].map((l) => l.textContent)).toEqual(['+new']);
  });
});

describe('each line knows its indent', () => {
  it('one span per non-empty line with its indent; newlines stay outside, text unchanged', () => {
    const inner = 'def f():\n    return 1\n\n\tpass\n';
    const out = markLines(inner);
    const d = doc(`<code>${out}</code>`);
    expect(d.textContent).toBe(inner);
    const lines = [...d.querySelectorAll('.md-code-ln')];
    expect(lines.map((l) => l.textContent)).toEqual(['def f():', '    return 1', '\tpass']);
    expect(lines.map((l) => l.getAttribute('style'))).toEqual(['--in:0', '--in:4', '--in:4']);
    expect(out).not.toMatch(/\n<\/span>/);
  });

  it('a token spanning lines is closed at each line end and reopened, nesting intact', () => {
    const out = markLines('a <span class="token comment">/* one\n  two */</span> b\n');
    const d = doc(`<code>${out}</code>`);
    const lines = [...d.querySelectorAll('.md-code-ln')];
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.querySelector('.token.comment')!.textContent)).toEqual(['/* one', '  two */']);
    expect(d.textContent).toBe('a /* one\n  two */ b\n');
  });

  it("a diff line's indent counts from after its +, - or space", () => {
    const d = doc(renderMarkdownWithRefs('```diff\n-    return a\n+  b\n```'));
    expect([...d.querySelectorAll('.md-code-ln')].map((l) => l.getAttribute('style'))).toEqual(['--in:5', '--in:3']);
  });

  it('every rendered block is marked, colored or plain', () => {
    for (const fence of ['ts', 'text']) {
      const d = doc(renderMarkdownWithRefs('```' + fence + '\nconst a = 1;\n  const b = 2;\n```'));
      expect([...d.querySelectorAll('.md-code-ln')].map((l) => l.getAttribute('style'))).toEqual(['--in:0', '--in:2']);
    }
  });
});

describe('a hyphen stays with what follows it', () => {
  it('pairs a hyphen with the next character in text and path links, never inside a tag or a pill', () => {
    const out = keepHyphens('go test -bench <a href="/src/marina-api">src/marina-api</a> --count=1 a - b <a class="task-link" href="#">fix-it</a>\n');
    const d = doc(`<code>${out}</code>`);
    expect(d.textContent).toBe('go test -bench src/marina-api --count=1 a - b fix-it\n');
    expect([...d.querySelectorAll('.md-code-nb')].map((e) => e.textContent)).toEqual(['-b', '-a', '-c']);
    expect(out).toContain('>fix-it</a>');
    expect(d.querySelector('a')!.getAttribute('href')).toBe('/src/marina-api');
  });

  it('colored and plain blocks both get it, text unchanged', () => {
    for (const fence of ['bash', 'text', '']) {
      const html = renderMarkdownWithRefs('```' + fence + '\ngo test -benchtime 5s ./pkg/...\n```');
      const d = doc(html);
      expect(d.querySelector('.md-code-nb')!.textContent).toBe('-b');
      expect(codeText(html)).toBe('go test -benchtime 5s ./pkg/...\n');
    }
  });

  it('a path may break after a slash between its parts, never at `//` or a leading slash; copy text unchanged', () => {
    const out = keepHyphens('// /tmp/acme/src/app.go:3 https://x.dev/a/b\n');
    expect(out.split('<wbr>').length - 1).toBe(5);
    expect(out.startsWith('// /tmp/<wbr>acme/')).toBe(true);
    expect(out).toContain('https://x.dev/<wbr>a/<wbr>b');
    expect(doc(`<code>${out}</code>`).textContent).toBe('// /tmp/acme/src/app.go:3 https://x.dev/a/b\n');
    const pill = keepHyphens('<a class="task-link" href="#">a/b</a>');
    expect(pill).toBe('<a class="task-link" href="#">a/b</a>');
  });

  it('a link that gets break points keeps its plain text as its name', () => {
    const out = keepHyphens('see <a class="file-link" href="#">/tmp/acme/src/a.go:3</a> and <a href="#" aria-label="x">a/b</a>\n');
    expect(out).toContain('aria-label="/tmp/acme/src/a.go:3">/tmp/<wbr>acme/');
    expect(out).toContain('<a href="#" aria-label="x">a/<wbr>b</a>');
  });

  it('each Copy is named for its block', () => {
    const names = ['```ts\nconst a = 1;\n```', '```\nplain\n```', '```go title="src/app.go"\nx\n```'].map((md) =>
      doc(renderMarkdownWithRefs(md)).querySelector('[data-md-code-action="copy"]')!.getAttribute('aria-label'));
    expect(names[0]).toBe('Copy TypeScript code');
    expect(names[1]).toBe('Copy code');
    expect(names[2]).toMatch(/^Copy .*app\.go/);
  });

  it('an emoji after a hyphen stays whole', () => {
    const d = doc(`<code>${keepHyphens('a-\u{1F600} b\n')}</code>`);
    expect(d.querySelector('.md-code-nb')!.textContent).toBe('-\u{1F600}');
  });
});

describe('links inside highlighted code survive', () => {
  it('an absolute path in a colored block is still one whole file link', () => {
    const P = '/home/dev/projects/marina/src/server.ts';
    const html = renderMarkdownWithRefs('```ts\n// see ' + P + ':42\nimport x from "./y";\n```');
    const d = doc(html);
    const a = d.querySelector('.md-code a.file-link')!;
    expect(a).not.toBeNull();
    expect(a.getAttribute('data-file-path')).toBe(P);
    expect(a.getAttribute('data-file-line')).toBe('42');
    expect(a.textContent).toBe(P + ':42');
    // The link text is not split into token spans.
    expect(a.querySelector('span')).toBeNull();
    // Still colored around it.
    expect(d.querySelector('.md-code .token.keyword')!.textContent!.trim()).toBe('import');
    expect(codeText(html)).toBe('// see ' + P + ':42\nimport x from "./y";\n');
  });

  it('a relative path with a cwd and a URL both stay links', () => {
    const html = renderMarkdownWithRefs('```bash\ncat src/app/main.ts && curl https://example.com/x?a=1\n```', '/repo');
    const d = doc(html);
    expect(d.querySelector('.md-code a.file-link')!.getAttribute('data-rel-path')).toBe('src/app/main.ts');
    expect(d.querySelector('.md-code a[href^="https://example.com"]')).not.toBeNull();
    expect(codeText(html)).toBe('cat src/app/main.ts && curl https://example.com/x?a=1\n');
  });
});

describe('only the in-app render is framed', () => {
  it('copy as rich text keeps bare pre/code', () => {
    const html = markdownToRichHtml('```ts\nconst a = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).not.toContain('md-code');
    expect(html).not.toContain('<button');
  });

  it('tool results keep bare pre/code', () => {
    const html = renderToolResultWithRefs('```\nout\n```');
    expect(html).not.toContain('md-code');
  });
});

describe('parseFenceInfo', () => {
  it.each([
    ['ts', 'TypeScript', 'typescript', null],
    ['TypeScript', 'TypeScript', 'typescript', null],
    ['tsx', 'TSX', 'tsx', null],
    ['zsh', 'Shell', 'bash', null],
    ['console', 'Shell', 'bash', null],
    ['yml', 'YAML', 'yaml', null],
    ['html', 'HTML', 'html', null],
    ['dockerfile', 'Dockerfile', 'docker', null],
    ['toml', 'TOML', 'toml', null],
    ['text', 'Text', null, null],
    ['', '', null, null],
    ['src/app.py', 'Python', 'python', 'src/app.py'],
    ['ts title="src/a.ts"', 'TypeScript', 'typescript', 'src/a.ts'],
    ['ts:src/a.ts', 'TypeScript', 'typescript', 'src/a.ts'],
    ['{.python}', 'Python', 'python', null],
  ])('%j → label %j, grammar %j, title %j', (info, label, grammar, title) => {
    const f = parseFenceInfo(info);
    expect(f.label).toBe(label);
    expect(f.grammar).toBe(grammar);
    expect(f.title).toBe(title);
  });

  it('a version number is not a file name', () => {
    expect(parseFenceInfo('v1.2').title).toBeNull();
  });

  it('a file-name fence shows the file and names it whole, with its language, in its tooltip', () => {
    const d = doc(renderMarkdownWithRefs('```src/app.py\nprint(1)\n```'));
    const label = d.querySelector('.md-code-lang')!;
    expect(label.textContent).toBe('src/app.py');
    expect(label.getAttribute('title')).toBe('src/app.py (Python)');
    // The folders are what gives way when the header is narrow.
    expect(label.querySelector('.md-code-lang-dir')!.textContent).toBe('src');
    expect(label.querySelector('.md-code-lang-base')!.textContent).toBe('/app.py');
    expect(d.querySelector('.md-code .token.keyword')!.textContent!.trim()).toBe('print');
  });
});

describe('highlightCodeInner', () => {
  it('re-inserts tags at their text offsets and leaves link text uncolored', () => {
    const inner = 'const p = &quot;<a class="file-link" href="#">/a/b.ts</a>&quot;;\n';
    const out = highlightCodeInner(inner, 'typescript')!;
    const d = doc(`<code>${out}</code>`);
    expect(d.textContent).toBe('const p = "/a/b.ts";\n');
    const a = d.querySelector('a')!;
    expect(a.textContent).toBe('/a/b.ts');
    expect(a.querySelector('span')).toBeNull();
    expect(d.querySelector('.token.keyword')!.textContent!.trim()).toBe('const');
  });

  it('nested tags (a pill with an inner span) keep their structure', () => {
    const inner = 'x(<a class="task-link"><span class="l">abc</span></a>);\n';
    const out = highlightCodeInner(inner, 'javascript')!;
    expect(out).toContain('<a class="task-link"><span class="l">abc</span></a>');
    expect(doc(`<code>${out}</code>`).textContent).toBe('x(abc);\n');
  });

  it('a no-break space shows and copies as itself, not as an entity name', () => {
    // An engine serializes U+00A0 in text as &nbsp;.
    const out = highlightCodeInner('const a\u00a0= 1;\nconst b&nbsp;= 2;\n', 'javascript')!;
    const d = doc(`<code>${out}</code>`);
    expect(d.textContent).toBe('const a\u00a0= 1;\nconst b\u00a0= 2;\n');
    expect(out).not.toContain('&amp;nbsp;');
  });

  it('a raw ">" inside an attribute value (older engines serialize it so) never splits the tag', () => {
    // As an older WebKit serializes a sanitized link whose URL holds an escaped quote.
    const inner = '<a href="https://x/>&quot;onmouseover=alert(1)//">https://x/&gt;"onmouseover</a>\n';
    for (const grammar of ['yaml', 'diff', 'markdown', 'javascript']) {
      const out = highlightCodeInner(inner, grammar)!;
      const d = doc(`<code>${out}</code>`);
      const anchors = d.querySelectorAll('a');
      expect(anchors).toHaveLength(1);
      expect(anchors[0]!.getAttributeNames()).toEqual(['href']);
      expect(d.querySelector('[onmouseover]')).toBeNull();
      expect(out.startsWith('<a href="https://x/>&quot;onmouseover=alert(1)//">')).toBe(true);
    }
  });

  it('text never carries a raw quote out, and a stray "<" stays text', () => {
    const out = highlightCodeInner('a = 1 < 2; b = "q";\n', 'javascript')!;
    expect(out).not.toMatch(/"q"/);
    expect(doc(`<code>${out}</code>`).textContent).toBe('a = 1 < 2; b = "q";\n');
    const stray = highlightCodeInner('x <y\n', 'javascript')!;
    expect(doc(`<code>${stray}</code>`).textContent).toBe('x <y\n');
    expect(stray).not.toContain('<y');
  });

  it('a void element (source, track, col...) does not leave the rest of the block uncolored', () => {
    const out = highlightCodeInner('<source src="a.mp4">const a = 1;\n', 'javascript')!;
    expect(doc(`<code>${out}</code>`).querySelector('.token.keyword')!.textContent!.trim()).toBe('const');
  });

  it('numeric entities decode before highlighting', () => {
    const out = highlightCodeInner('a = &#39;x&#39;\n', 'python')!;
    expect(doc(`<code>${out}</code>`).querySelector('.token.string')!.textContent!.trim()).toBe("'x'");
  });
});

describe('limits', () => {
  it('a large block still streaming colors its head, the rest once its fence closes', () => {
    const body = 'const value = 1;\n'.repeat(400); // ~7KB, over the open-block cap
    const open = doc(renderMarkdownWithRefs('Writing:\n\n```ts\n' + body + 'const tail = 2;'));
    expect(open.querySelector('.md-code-lang')!.textContent).toBe('TypeScript');
    const code = open.querySelector('.md-code pre code')!;
    // Colored up to the cap, never beyond, and the text is all there.
    const colored = [...code.querySelectorAll('.token.keyword')];
    expect(colored.length).toBeGreaterThan(100);
    expect(colored.length).toBeLessThan(400);
    expect(code.textContent).toBe(body + 'const tail = 2;\n');
    const closed = doc(renderMarkdownWithRefs('Writing:\n\n```ts\n' + body + 'const tail = 2;\n```\n'));
    expect(closed.querySelectorAll('.md-code .token.keyword').length).toBe(401);
  });

  it('a diff colors its hunk and file headers', () => {
    const d = doc(renderMarkdownWithRefs('```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```'));
    const coord = [...d.querySelectorAll('.md-code .token.coord')].map((e) => e.textContent).join('');
    for (const head of ['--- a/x', '+++ b/x', '@@ -1 +1 @@']) expect(coord).toContain(head);
    expect(coord).not.toContain('old');
  });

  it('only colored token types become spans, and runs of one type share one', () => {
    const html = renderMarkdownWithRefs('```ts\nfoo(a, b); bar(c);\n```');
    expect(html).not.toContain('token punctuation');
    expect(html).not.toContain('token operator');
  });

  it('coloring never turns escaped code text into markup', () => {
    // (Attribute stripping itself is DOMPurify's, checked in a real browser in
    // tests/e2e/browser/code-block-actions-helpers.ts: this DOM shim keeps attrs.)
    const html = renderMarkdownWithRefs('```js\na = "<img src=x onerror=alert(1)>"; </code><script>x()</script>\n```');
    const d = doc(html);
    expect(d.querySelector('img, script')).toBeNull();
    expect(d.querySelector('.md-code code')!.textContent).toBe('a = "<img src=x onerror=alert(1)>"; </code><script>x()</script>\n');
  });

  it('a block over the cap keeps at least the colored head it showed while streaming, the rest plain', () => {
    const big = 'let a = 1;\n'.repeat(Math.ceil(MAX_HIGHLIGHT_CHARS / 11) + 10);
    const lines = big.split('\n').length - 1;
    const streaming = doc(renderMarkdownWithRefs('```js\n' + big));
    const closed = doc(renderMarkdownWithRefs('```js\n' + big + '```'));
    for (const d of [streaming, closed]) {
      expect(d.querySelector('.md-code')).not.toBeNull();
      const kws = d.querySelectorAll('.md-code .token.keyword').length;
      expect(kws).toBeGreaterThan(100);
      expect(kws).toBeLessThan(lines);
      expect(d.querySelector('.md-code pre code')!.textContent).toBe(big);
    }
    // The finished block says it is colored in part; the streaming one does not.
    expect(closed.querySelector('.md-code-note')!.textContent).toBe('Colored in part');
    expect(streaming.querySelector('.md-code-note')).toBeNull();
    // Closing the fence never takes colors away; it colors up to the cap.
    const closedKws = closed.querySelectorAll('.md-code .token.keyword').length;
    expect(closedKws).toBeGreaterThan(streaming.querySelectorAll('.md-code .token.keyword').length);
    expect(closedKws).toBeGreaterThan(Math.floor(MAX_HIGHLIGHT_CHARS / 11) - 5);
  });

  it('a block that grows on every delta stays fast (streaming)', () => {
    const line = 'export function step(n: number): string { return `n=${n}`; } // tick\n';
    let text = 'Working:\n\n```ts\n';
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      text += line;
      renderMarkdownWithRefs(text);
    }
    const perDelta = (performance.now() - t0) / 200;
    // 200 deltas up to ~14KB of code: generous bound, the point is no blowup.
    expect(perDelta).toBeLessThan(40);
  });

  it('html with no marked blocks passes through', () => {
    expect(highlightCodeBlocks('<p>x</p>')).toBe('<p>x</p>');
  });
});
