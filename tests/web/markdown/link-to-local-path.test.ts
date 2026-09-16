import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs, filePathsToHtml, markdownToRichHtml } from '@/utils/markdown';

/**
 * A markdown link whose destination is a LOCAL path renders as one file-link
 * carrying the model's label, not as literal brackets around a bare path link.
 *
 * The 2026-09-15 report, verbatim shape: the model wrote
 * `[eventprocessor.go:58-75](/repo/.../eventprocessor.go#L58)` inside CJK prose
 * (full-width parentheses U+FF08/U+FF09) and the screen showed
 * `[eventprocessor.go:58-75](` + a path link + `#L58))`. The absolute-path
 * pre-pass had rewritten the destination before marked saw the link. Same on the
 * rich path, since both share renderMarkdownWithRefs.
 *
 * Division of labour under test: filePathsToHtml only FENCES link spans; marked
 * parses the link with its own grammar; the `link` renderer override decides
 * whether the destination is a local path (fileLinkAttrsForDestination).
 */

const ABS = '/workplace/acme/hub/src/pkg/eventprocessor/eventprocessor.go';
const CWD = '/repo';
// CJK test data as escapes: U+FF08/U+FF09 are the full-width parentheses of the
// report, U+51E0... is the surrounding prose.
const CJK_BEFORE = '\u51E0\u767E\u5FAE\u79D2\u5185 transform+\u5199\u5B8C\uFF08';
const CJK_AFTER = '\uFF09\uFF0C\u800C\u540C\u4E00\u4E2A pod';

/** Number of anchor OPEN tags in a rendered string. */
const anchors = (html: string) => (html.match(/<a[\s>]/gi) ?? []).length;

describe('markdown link to a local path (the report)', () => {
  const md = `${CJK_BEFORE}[eventprocessor.go:58-75](${ABS}#L58)${CJK_AFTER}`;

  it('renders ONE file-link with the label as text and #L58 as the line', () => {
    const html = renderMarkdownWithRefs(md);
    expect(anchors(html)).toBe(1);
    expect(html).toContain(`<a class="file-link" data-file-path="${ABS}" data-file-line="58" href="#">eventprocessor.go:58-75</a>`);
    // No link syntax leaks around the anchor.
    expect(html).not.toContain('[eventprocessor.go');
    expect(html).not.toContain('](');
    expect(html).not.toContain('#L58');
    // The surrounding CJK parentheses stay where the model put them.
    expect(html).toContain('\uFF08<a');
    expect(html).toContain('</a>\uFF09');
  });

  it('rich mode renders the same anchor (mode does not matter)', () => {
    const plain = renderMarkdownWithRefs(md);
    const rich = renderMarkdownWithRefs(md, undefined, undefined, { allowStyle: true });
    expect(rich).toBe(plain);
  });

  it('negative control: the bare path in the same prose still linkifies as before', () => {
    const html = renderMarkdownWithRefs(`see ${ABS}:58 and also [it](${ABS}#L58)`);
    expect(anchors(html)).toBe(2);
    expect(html).toContain(`data-file-path="${ABS}" data-file-line="58" href="#">${ABS}:58</a>`);
    expect(html).toContain(`data-file-path="${ABS}" data-file-line="58" href="#">it</a>`);
  });

  it('copy-as-rich-text never gets in-app anchors (the context is only set for the on-screen render)', () => {
    const html = markdownToRichHtml(`[it](${ABS}#L58)`);
    expect(html).not.toContain('file-link');
    expect(html).toContain('<a href=');
  });
});

describe('destination shapes that become a file-link', () => {
  it.each([
    ['no position', `${ABS}`, ''],
    [':42', `${ABS}:42`, ' data-file-line="42"'],
    [':10-20 range (start line wins)', `${ABS}:10-20`, ' data-file-line="10"'],
    ['#L42', `${ABS}#L42`, ' data-file-line="42"'],
    ['#L10-L20 range', `${ABS}#L10-L20`, ' data-file-line="10"'],
    ['#42 (GitHub short form)', `${ABS}#42`, ' data-file-line="42"'],
    [':42:7 (editor form, column dropped)', `${ABS}:42:7`, ' data-file-line="42"'],
  ])('absolute file, %s', (_name, dest, lineAttr) => {
    const html = renderMarkdownWithRefs(`[x](${dest})`);
    expect(html).toContain(`<a class="file-link" data-file-path="${ABS}"${lineAttr} href="#">x</a>`);
    expect(anchors(html)).toBe(1);
  });

  it('a heading fragment opens the file (headings are not addressable in the viewer)', () => {
    const html = renderMarkdownWithRefs('[Menus](/workplace/acme/hub/web/src/AGENTS.md#menus--overlays--hard-rules)');
    expect(html).toContain('<a class="file-link" data-file-path="/workplace/acme/hub/web/src/AGENTS.md" href="#">Menus</a>');
    const rel = renderMarkdownWithRefs('[Testing](./docs/reference/testing-pipeline.md#tiers)', CWD);
    expect(rel).toContain(`<a class="file-link" data-rel-path="docs/reference/testing-pipeline.md" data-cwd="${CWD}" href="#">Testing</a>`);
  });

  it('absolute directory, with and without a trailing slash', () => {
    for (const dest of ['/workplace/acme/hub/src', '/workplace/acme/hub/src/']) {
      const html = renderMarkdownWithRefs(`[src](${dest})`);
      expect(html).toContain('<a class="file-link" data-file-path="/workplace/acme/hub/src" href="#">src</a>');
      expect(anchors(html)).toBe(1);
    }
  });

  it('home-relative ~/ path keeps the tilde (the backend expands it)', () => {
    const html = renderMarkdownWithRefs('[cfg](~/.open-walnut/config.yaml:3)');
    expect(html).toContain('<a class="file-link" data-file-path="~/.open-walnut/config.yaml" data-file-line="3" href="#">cfg</a>');
  });

  it('relative paths carry rel + cwd (resolution happens on click)', () => {
    const html = renderMarkdownWithRefs('[ctl](src/pkg/eventcontroller.go:1041) and [readme](./README.md) and [core](src/core)', CWD);
    expect(html).toContain(`<a class="file-link" data-rel-path="src/pkg/eventcontroller.go" data-cwd="${CWD}" data-file-line="1041" href="#">ctl</a>`);
    expect(html).toContain(`<a class="file-link" data-rel-path="README.md" data-cwd="${CWD}" href="#">readme</a>`);
    expect(html).toContain(`<a class="file-link" data-rel-path="src/core" data-cwd="${CWD}" href="#">core</a>`);
    expect(anchors(html)).toBe(3);
  });

  it('a link to an inline-renderable image stays with marked: image + caption, not a file-link', () => {
    const html = renderMarkdownWithRefs('[shot](/tmp/walnut-shots/01-panel.png)');
    expect(html).toContain('inline-image-block');
    expect(html).toContain('<span class="inline-image-path">shot</span>');
    expect(html).not.toContain('file-link');
  });

  it('a link to an image marked does NOT render inline (svg) opens in the Files panel', () => {
    const html = renderMarkdownWithRefs('[logo](/workplace/acme/hub/assets/logo.svg)');
    expect(html).toContain('<a class="file-link" data-file-path="/workplace/acme/hub/assets/logo.svg" href="#">logo</a>');
    expect(anchors(html)).toBe(1);
  });

  it("CommonMark's angle-bracket destination carries spaces, a parenthesized tag and an apostrophe", () => {
    const p = "/Users/me/.open-walnut/notes/Projects/Marina Renewal/2026-08-08 Bob's Status Ping to Acme (draft).md";
    const html = renderMarkdownWithRefs(`draft: [status ping](<${p}>)`);
    expect(html).toContain(`<a class="file-link" data-file-path="${p}" href="#">status ping</a>`);
    expect(anchors(html)).toBe(1);
  });

  it('a bare destination with spaces is not a link to marked, so the text stays literal and its path links as before', () => {
    const p = '/Users/me/.open-walnut/notes/Projects/Marina Renewal/H1 2026 Overview.md';
    const html = renderMarkdownWithRefs(`draft: [status ping](${p})`);
    expect(html).toContain('[status ping](<a class="file-link"');
    expect(html).toContain(`data-file-path="${p}"`);
    expect(anchors(html)).toBe(1);
  });

  it('CJK in label and destination', () => {
    const p = '/Users/me/.open-walnut/notes/Areas/\u804C\u4E1A/\u534A\u5E74\u603B\u7ED3.md';
    const html = renderMarkdownWithRefs(`\u89C1 [\u534A\u5E74\u603B\u7ED3](${p})`);
    expect(html).toContain(`<a class="file-link" data-file-path="${p}" href="#">\u534A\u5E74\u603B\u7ED3</a>`);
  });

  it('a title after the destination rides along as the title attribute', () => {
    const html = renderMarkdownWithRefs(`[x](${ABS} "Event processor")`);
    expect(html).toContain(`<a class="file-link" data-file-path="${ABS}" title="Event processor" href="#">x</a>`);
  });

  it('an empty label shows the destination as written', () => {
    const html = renderMarkdownWithRefs(`[](${ABS}#L58)`);
    expect(html).toContain(`<a class="file-link" data-file-path="${ABS}" data-file-line="58" href="#">${ABS}#L58</a>`);
  });

  it('a label with nested brackets (CommonMark-legal) converts', () => {
    const html = renderMarkdownWithRefs(`[a [b] c](${ABS})`);
    expect(html).toContain(`<a class="file-link" data-file-path="${ABS}" href="#">a [b] c</a>`);
    expect(html).not.toContain('](');
  });

  it('a reference-style link resolves through its definition', () => {
    const html = renderMarkdownWithRefs(`see [the file][r] here\n\n[r]: ${ABS}#L58`);
    expect(html).toContain(`<a class="file-link" data-file-path="${ABS}" data-file-line="58" href="#">the file</a>`);
    expect(anchors(html)).toBe(1);
    expect(html).not.toContain('[r]:');
  });

  it('label markdown survives: a code-span label renders as <code> INSIDE the one anchor', () => {
    const html = renderMarkdownWithRefs(`see [\`src/pkg/eventprocessor.go\`](${ABS})`, CWD);
    expect(html).toContain(`<a class="file-link" data-file-path="${ABS}" href="#"><code>src/pkg/eventprocessor.go</code></a>`);
    // linkifyPathsInCode must not grow a second anchor inside the first.
    expect(anchors(html)).toBe(1);
  });

  it('an anchor already inside the label (a task pill) is flattened to its text, never nested', () => {
    const html = renderMarkdownWithRefs(`[<task-ref id="abc1234-def0"/> spec](${ABS})`);
    expect(anchors(html)).toBe(1);
    expect(html).toMatch(new RegExp(`<a class="file-link" data-file-path="${ABS}" href="#">[^<]*abc1234-def0[^<]* spec</a>`));
  });

  it('several links and a bare path in one paragraph, in order', () => {
    const html = renderMarkdownWithRefs(`[a](${ABS}#L1), then /workplace/acme/hub/README.md, then [b](/workplace/acme/hub/docs/guide.md)`);
    const order = [...html.matchAll(/href="#">([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(order).toEqual(['a', '/workplace/acme/hub/README.md', 'b']);
  });
});

describe('links that stay ordinary links', () => {
  it('external http(s) link: one ordinary anchor, no file-link', () => {
    // target=_blank is a DOMPurify hook, which this tier's window cannot run;
    // tests/e2e/browser/external-links-new-tab.spec.ts pins that half.
    const html = renderMarkdownWithRefs('[docs](https://example.com/a/b/c.md)');
    expect(anchors(html)).toBe(1);
    expect(html).toContain('href="https://example.com/a/b/c.md"');
    expect(html).not.toContain('file-link');
  });

  it('a path in the LABEL of an external link is not linkified (no nested anchors)', () => {
    const html = renderMarkdownWithRefs('[/workplace/acme/hub/src/x.ts](https://github.com/acme/hub/blob/main/src/x.ts)', CWD);
    expect(anchors(html)).toBe(1);
    expect(html).toContain('href="https://github.com/acme/hub/blob/main/src/x.ts"');
    expect(html).toContain('>/workplace/acme/hub/src/x.ts</a>');
    expect(html).not.toContain('file-link');
  });

  it('a code-span path in the label of an external link is not linkified either', () => {
    const html = renderMarkdownWithRefs('[`src/pkg/a.go`](https://example.com/src/pkg/a.go)', CWD);
    expect(anchors(html)).toBe(1);
    expect(html).toContain('<code>src/pkg/a.go</code></a>');
    expect(html).not.toContain('file-link');
  });

  it.each([
    ['in-page anchor', '[top](#top)', 'href="#top"'],
    ['mailto', '[mail](mailto:someone@example.com)', 'href="mailto:someone@example.com"'],
    ['protocol-relative URL', '[cdn](//cdn.example.com/lib/x.js)', 'href="//cdn.example.com/lib/x.js"'],
    ['in-app route (two segments, no extension)', '[task](/tasks/abc1234-def0)', 'href="/tasks/abc1234-def0"'],
    ['single root segment', '[board](/tasks)', 'href="/tasks"'],
    ['plugin app deep route (three segments, but ~ is not a path character)', '[Open Mail](/apps/walnut-mail~main/inbox)', 'href="/apps/walnut-mail~main/inbox"'],
    ['API URL with a query string', '[dl](/api/files/download?path=/a/b.md)', 'href="/api/files/download?path=/a/b.md"'],
  ])('%s', (_name, md, expectedHref) => {
    const html = renderMarkdownWithRefs(md, CWD);
    expect(anchors(html)).toBe(1);
    expect(html).toContain(expectedHref);
    expect(html).not.toContain('file-link');
  });

  it('a traversal destination is never made clickable, and is not mangled either', () => {
    const html = renderMarkdownWithRefs('[x](../../etc/passwd)', CWD);
    expect(anchors(html)).toBe(1);
    expect(html).not.toContain('file-link');
    expect(html).not.toContain('](');
  });

  it('a relative destination with no cwd is left to marked (nothing to resolve against)', () => {
    const html = renderMarkdownWithRefs('[ctl](src/pkg/eventcontroller.go:1041)');
    expect(anchors(html)).toBe(1);
    expect(html).not.toContain('file-link');
    expect(html).toContain('>ctl</a>');
  });

  it.each([
    ['a bare word', '[docs](docs)'],
    ['a single-segment file (the resolver would answer with any same-named file)', '[readme](README.md)'],
    ['a relative file outside the code extensions, like the bare-path pass', '[report](out/summary.docx)'],
    ['a relative image, like the bare-path pass', '[shot](assets/logo.png)'],
    ['an extensionless directory with spaces (declined, like the bare-path pass)', '[r](</workplace/acme/hub/notes/Report (2024)>)'],
  ])('%s is left to marked', (_name, md) => {
    const html = renderMarkdownWithRefs(md, CWD);
    expect(anchors(html)).toBe(1);
    expect(html).not.toContain('file-link');
    expect(html).not.toContain('data-file-line');
  });

  it('prose in parentheses after a bracketed word is not a link; the paths inside it link as before', () => {
    const html = renderMarkdownWithRefs('Fixed [1](see /workplace/acme/hub/src/a.ts and /workplace/acme/hub/src/b.ts for details) today.', CWD);
    expect(html).toContain('[1](see <a class="file-link" data-file-path="/workplace/acme/hub/src/a.ts"');
    expect(html).toContain('for details) today.');
    expect(anchors(html)).toBe(2);
  });

  it('a markdown IMAGE with a local path is still an image', () => {
    const html = renderMarkdownWithRefs('![shot](/tmp/walnut-shots/01-panel.png)');
    expect(html).toContain('<img');
    expect(html).not.toContain('file-link');
  });

  it('an image whose source has a non-image extension is not rewritten either', () => {
    // Before, only the extension filter kept image sources intact; a `.md` source
    // was linkified inside the parentheses and the image syntax fell apart.
    const html = renderMarkdownWithRefs('![diagram](/workplace/acme/hub/docs/flow.svg.md)');
    expect(html).toContain('<img');
    expect(html).not.toContain('file-link');
    expect(html).not.toContain('![');
  });

  it('link syntax inside a code span is literal code, untouched by the pre-pass', () => {
    const out = filePathsToHtml(`type \`[x](${ABS})\` to link it`);
    expect(out).toBe(`type \`[x](${ABS})\` to link it`);
    const html = renderMarkdownWithRefs(`type \`[x](${ABS})\` to link it`);
    expect(html).toContain('<code>[x](');
  });

  it('link syntax inside a fenced block is literal code', () => {
    const md = ['```md', `[x](${ABS})`, '```'].join('\n');
    expect(filePathsToHtml(md)).toBe(md);
  });
});

describe('the pre-pass fence', () => {
  it('a link still streaming (no closing parenthesis yet) is not linkified to a prefix of its path', () => {
    const partial = `Start from [entry point](${ABS.slice(0, -6)}`;
    expect(filePathsToHtml(partial, CWD)).toBe(partial);
  });

  it('a reference definition line is left for marked', () => {
    const md = `[r]: ${ABS}#L58`;
    expect(filePathsToHtml(md, CWD)).toBe(md);
  });
});

describe('code spans next to anchors (linkifyPathsInCode)', () => {
  it('a stray </a> before a code-label link does not produce a nested anchor', () => {
    const html = renderMarkdownWithRefs(`stray </a> then [\`src/lib/util.ts\`](/workplace/acme/hub/src/lib/util.ts)`, CWD);
    expect(anchors(html)).toBe(1);
    expect(html).toContain('<code>src/lib/util.ts</code></a>');
  });

  it('a self-closing <a/> earlier in the message does not switch off path links in later code', () => {
    const html = renderMarkdownWithRefs('Top <a id="top"/> then `src/lib/util.ts` and `web/src/app.ts`', CWD);
    expect(html).toContain('<code><a class="file-link" data-rel-path="src/lib/util.ts"');
    expect(html).toContain('<code><a class="file-link" data-rel-path="web/src/app.ts"');
  });

  it('an uppercase model-written anchor around a code span is still an anchor', () => {
    const html = renderMarkdownWithRefs('<A HREF="https://example.com/1">`src/pkg/a.ts`</A>', CWD);
    expect(anchors(html)).toBe(1);
    expect(html).not.toContain('file-link');
  });
});

describe('unclosed link syntax stays cheap (the pre-pass runs on every streamed delta)', () => {
  it.each([
    ['one long word', `[x](${'a'.repeat(50_000)}`],
    ['many words', `[x](${'word '.repeat(10_000)}`],
    ['many groups', `[x](${'(g)a'.repeat(10_000)}`],
    ['many openers', `${'[x](/a/b/c '.repeat(2_000)}`],
    ['many nested-bracket labels', `${'[a [b] c '.repeat(5_000)}`],
  ])('%s, no closing parenthesis', (_name, md) => {
    const t0 = performance.now();
    filePathsToHtml(md, CWD);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('attribute safety', () => {
  it('a quote, angle bracket or backslash in a destination declines the file-link and never reaches an attribute', () => {
    for (const bad of [`[x](${ABS}"onclick=alert(1))`, `[x](/aa/bb/c(<x>).md)`, `[x](/aa/bb/c\\d.md)`]) {
      const html = renderMarkdownWithRefs(bad);
      expect(html).not.toContain('file-link');
      expect(html).not.toMatch(/\sonclick=/);
    }
  });

  it('an ampersand in a path is escaped in the attribute and decodes back to the path', () => {
    const html = renderMarkdownWithRefs('[x](/workplace/acme/hub/a&b.md)');
    expect(html).toContain('data-file-path="/workplace/acme/hub/a&amp;b.md"');
  });

  it('a raw </a> in the label cannot close the file-link early', () => {
    const html = renderMarkdownWithRefs(`[</a>evil<a href="https://evil.test">click</a>](${ABS})`);
    expect(anchors(html)).toBe(1);
    expect(html).toContain(`<a class="file-link" data-file-path="${ABS}" href="#">evilclick</a>`);
  });
});
