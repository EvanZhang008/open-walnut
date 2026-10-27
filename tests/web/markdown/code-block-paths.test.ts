import { describe, it, expect } from 'vitest';
import { codeRegions, filePathsToHtml, renderMarkdownWithRefs } from '@/utils/markdown';

/**
 * Paths inside code, and line ranges, become ONE whole link.
 *
 * The 2026-10-27 report: a reply's Go block opened with a path comment,
 * `// /workplace/<user>/remotessh/<repo>/…/pkg/remote/object.go:31-34`, and the
 * user's own message quoting it (`did u find it?```go` + that line + "```")
 * rendered wrong; in prose `/tmp/k8s-src/objectmeta_validation.go:237-239`
 * linked only up to `:237`. Three causes, each pinned here:
 *   1. the bare-path regexes took `:42` only, so `-34` / `#L5-L9` / `(42,7)`
 *      were left outside the anchor;
 *   2. codeRegions read a closing ``` on the LAST line, right under prose, as a
 *      fence opener, while marked (which needs a newline after a fence line to
 *      interrupt a paragraph) read a code span: the pre-pass then injected an
 *      anchor into that span and marked printed it as escaped `<a class=…>` text;
 *   3. `./lib/x.ts` and `../lib/x.ts` were read as the absolute `/lib/x.ts`.
 *
 * The rule for a path in code (fenced block or inline span), and in prose:
 *   - absolute (`/a/b.ext`, `~/a/b.ext`; a directory needs 3+ segments) and not
 *     glued to what precedes it: no word char or `/` right before (the middle of
 *     a path or URL), no `./` or `../` token (a relative path), and in code no
 *     `word:` either (`host:/x`, a `-v src:/dst` volume, `C:/x`, a `PATH=a:b`
 *     tail; prose keeps `Output:/tmp/x.md`);
 *   - not inside a URL (`https://…`; `file:///…` and `s3://…` fail the glue rule);
 *   - escaped slashes never match, so a regex literal stays text;
 *   - a relative path needs the session cwd, a code extension, and a start of
 *     text, whitespace, `(` or a backtick before it: a quoted import specifier
 *     (`'./a/b.ts'`, escaped to `&#39;` in code) stays text;
 *   - a position written right after the path is part of the link, in exactly
 *     the forms parsePathRef reads: `:42`, `:42:7`, `:L42`, `:10-20`, `#L42`,
 *     `#42`, `#L10-L20`, `(42)`, `(42,7)`; a `#` form must end there
 *     (`guide.md#2-setup` is a heading anchor). A range sets data-file-line and
 *     data-file-end-line; a column lands on its line (the viewer has no column).
 */

const P = '/workplace/dev/remotessh/acme/src/marina/pkg/remote/object.go';
const CWD = '/repo';

const anchors = (html: string) => (html.match(/<a[\s>]/gi) ?? []).length;
const fileAnchors = (html: string) => html.match(/<a class="file-link"[^>]*>[^<]*<\/a>/g) ?? [];

describe('a path in a fenced code block', () => {
  it('a comment line `// /abs:31-34` links the whole reference with its range', () => {
    const html = renderMarkdownWithRefs(['Here:', '', '```go', `// ${P}:31-34`, 'func x() {}', '```'].join('\n'), CWD);
    expect(fileAnchors(html)).toEqual([
      `<a class="file-link" data-file-path="${P}" data-file-line="31" data-file-end-line="34" href="#">${P}:31-34</a>`,
    ]);
    // The block is still a code block with its language class, and its text is
    // byte-for-byte the code (what a select-and-copy yields).
    expect(html).toContain('<pre><code class="language-go">// <a ');
    expect(html.replace(/<[^>]+>/g, '')).toContain(`// ${P}:31-34\nfunc x() {}`);
  });

  it('`# /abs`, a bare path line, and an indented block all link', () => {
    for (const md of [
      ['```bash', `# ${P}`, 'ls', '```'].join('\n'),
      ['```', P, '```'].join('\n'),
      ['Output:', '', `    ${P}:12`, ''].join('\n'),
    ]) {
      const html = renderMarkdownWithRefs(md, CWD);
      expect(fileAnchors(html), md).toHaveLength(1);
      expect(html).toContain(`data-file-path="${P}"`);
      expect(html).not.toContain('&lt;a');
    }
  });

  it('every position form is linked whole', () => {
    const cases: Array<[string, string]> = [
      [':31-34', ' data-file-line="31" data-file-end-line="34"'],
      ['#L5-L9', ' data-file-line="5" data-file-end-line="9"'],
      ['#L5-9', ' data-file-line="5" data-file-end-line="9"'],
      ['#L42', ' data-file-line="42"'],
      ['#42', ' data-file-line="42"'],
      [':7:3', ' data-file-line="7"'],
      [':L8', ' data-file-line="8"'],
      [':42', ' data-file-line="42"'],
      ['(12,4)', ' data-file-line="12"'],
      ['(12, 4)', ' data-file-line="12"'],
      ['(12,  4)', ' data-file-line="12"'],
      ['(12)', ' data-file-line="12"'],
      [':31\u201334', ' data-file-line="31" data-file-end-line="34"'],
    ];
    for (const [suffix, attrs] of cases) {
      for (const md of [['```', `${P}${suffix}`, '```'].join('\n'), `see ${P}${suffix} here`, `see \`${P}${suffix}\` here`]) {
        const html = renderMarkdownWithRefs(md, CWD);
        expect(fileAnchors(html), md).toEqual([`<a class="file-link" data-file-path="${P}"${attrs} href="#">${P}${suffix}</a>`]);
      }
    }
  });

  it('a reversed or half-written range keeps its first line only', () => {
    expect(renderMarkdownWithRefs(`see ${P}:34-31 x`, CWD)).toContain(`data-file-line="34" href="#">${P}:34-31</a>`);
    // Mid-stream `:31-`: the link covers `:31`, and grows to the range on the next frame.
    expect(renderMarkdownWithRefs(['```', `// ${P}:31-`].join('\n'), CWD)).toContain(`data-file-line="31" href="#">${P}:31</a>-`);
  });

  it('code that only looks like a path stays text', () => {
    const block = [
      '```ts',
      "import util from '../lib/util/strings.ts'",
      "import api from './client/api/index.ts'",
      'const re = /^\\/usr\\/lib\\/.*\\.so$/',
      'scp build.tar host:/srv/app/build.tar',
      'docker run -v /data:/var/lib/app/db.conf img',
      'open C:/Users/dev/proj/main.ts',
      'fetch file:///etc/app/config/app.yaml',
      'aws s3 cp s3://bucket/a/b/c.json .',
      'curl https://example.com/a/b/c.go',
      '```',
    ].join('\n');
    const html = renderMarkdownWithRefs(block, CWD);
    expect(fileAnchors(html)).toEqual([]);
    // The URL is still an external link, whole.
    expect(html).toContain('<a href="https://example.com/a/b/c.go" target="_blank" rel="noopener noreferrer">https://example.com/a/b/c.go</a>');
    expect(anchors(html)).toBe(1);
  });

  it('a `#` suffix that runs on into a word is a heading anchor, not a line', () => {
    for (const md of [`see ${P}#2-setup now`, ['```', `${P}#2-setup`, '```'].join('\n')]) {
      const html = renderMarkdownWithRefs(md, CWD);
      expect(fileAnchors(html), md).toEqual([`<a class="file-link" data-file-path="${P}" href="#">${P}</a>`]);
    }
    expect(renderMarkdownWithRefs('see docs/guide/setup.md#2-setup now', CWD)).toContain('data-rel-path="docs/guide/setup.md" data-cwd="/repo" href="#">docs/guide/setup.md</a>#2-setup');
  });

  it('a relative path in code still links against the cwd, with its range', () => {
    const html = renderMarkdownWithRefs(['```', 'modified:   src/remote/object.go:31-34', '```'].join('\n'), CWD);
    expect(fileAnchors(html)).toEqual([
      `<a class="file-link" data-rel-path="src/remote/object.go" data-cwd="${CWD}" data-file-line="31" data-file-end-line="34" href="#">src/remote/object.go:31-34</a>`,
    ]);
  });
});

describe('a line range in prose', () => {
  it('the report: `:237-239` is linked whole, not up to `:237`', () => {
    const html = renderMarkdownWithRefs('Read /tmp/k8s-src/objectmeta_validation.go:237-239 first.', CWD);
    expect(fileAnchors(html)).toEqual([
      '<a class="file-link" data-file-path="/tmp/k8s-src/objectmeta_validation.go" data-file-line="237" data-file-end-line="239" href="#">/tmp/k8s-src/objectmeta_validation.go:237-239</a>',
    ]);
    expect(html).toContain('</a> first.');
  });

  it('a relative prose path takes the range too', () => {
    const html = renderMarkdownWithRefs('See src/remote/object.go#L31-L34.', CWD);
    expect(html).toContain(`data-rel-path="src/remote/object.go" data-cwd="${CWD}" data-file-line="31" data-file-end-line="34" href="#">src/remote/object.go#L31-L34</a>.`);
  });

  it('a markdown link destination with a range carries the end line', () => {
    const html = renderMarkdownWithRefs(`[object.go:31-34](${P}#L31-L34)`, CWD);
    expect(fileAnchors(html)).toEqual([`<a class="file-link" data-file-path="${P}" data-file-line="31" data-file-end-line="34" href="#">object.go:31-34</a>`]);
  });

  it('prose keeps a path glued to `word:` or `e.g.`, which code declines', () => {
    expect(fileAnchors(renderMarkdownWithRefs('Output:/tmp/acme/out/report.md', CWD))).toEqual([
      '<a class="file-link" data-file-path="/tmp/acme/out/report.md" href="#">/tmp/acme/out/report.md</a>',
    ]);
    expect(fileAnchors(renderMarkdownWithRefs('e.g./tmp/acme/out/report.md', CWD))).toEqual([
      '<a class="file-link" data-file-path="/tmp/acme/out/report.md" href="#">/tmp/acme/out/report.md</a>',
    ]);
    expect(fileAnchors(renderMarkdownWithRefs('`Output:/tmp/acme/out/report.md`', CWD))).toEqual([]);
  });

  it('`./x` and `../x` are relative, never the absolute `/x`', () => {
    expect(renderMarkdownWithRefs('open ../lib/util/strings.ts now', CWD)).not.toContain('data-file-path="/lib/util/strings.ts"');
    expect(renderMarkdownWithRefs('open ./lib/util/strings.ts now', CWD)).toContain('data-rel-path="lib/util/strings.ts"');
    expect(renderMarkdownWithRefs('open ../lib/util/deeper now', CWD)).not.toContain('data-file-path="/lib/util/deeper"');
  });
});

describe('a code span closed by ``` on the last line (the user\'s message)', () => {
  const msg = `did u find it?\`\`\`go\n// ${P}:31-34\n\`\`\``;

  it('codeRegions agrees with marked: the span is code, the last ``` opens no fence', () => {
    const regions = codeRegions(msg);
    const at = msg.indexOf(P);
    expect(regions.some(([s, e]) => s <= at && at < e)).toBe(true);
    // The pre-pass therefore leaves it alone...
    expect(filePathsToHtml(msg, CWD)).toBe(msg);
  });

  it('renders one link inside the span and no escaped markup', () => {
    const html = renderMarkdownWithRefs(msg, CWD);
    expect(html).not.toContain('&lt;a');
    expect(html).not.toContain('&quot;');
    expect(fileAnchors(html)).toEqual([`<a class="file-link" data-file-path="${P}" data-file-line="31" data-file-end-line="34" href="#">${P}:31-34</a>`]);
    expect(html).toContain('<code>go // <a ');
  });

  it('with a newline after the closing ```, marked opens a fence, and so does codeRegions', () => {
    const md = `${msg}\n`;
    const close = md.lastIndexOf('```');
    expect(codeRegions(md).some(([s, e]) => s <= close && close < e && s > md.indexOf(P))).toBe(true);
    const html = renderMarkdownWithRefs(md, CWD);
    expect(html).not.toContain('&lt;a');
    expect(fileAnchors(html)).toHaveLength(1);
  });

  it('inside a list item, marked ends the item at the last-line fence, and so does codeRegions', () => {
    const md = `- did u find it?\`\`\`go\n// ${P}:31-34\n\`\`\``;
    const html = renderMarkdownWithRefs(md, CWD);
    expect(html).toContain('<li>');
    expect(fileAnchors(html)).toHaveLength(1);
    expect(html).not.toContain('&lt;a');
  });

  // Every shape around a last-line ``` must agree with marked: whatever marked
  // makes of it, a path link never comes out as escaped text, and the path is
  // linked exactly once.
  it('no shape around a last-line fence leaks escaped anchors', () => {
    // A path on the fence line itself must not land in the info string either.
    for (const md of ['Title\n--\n``` /tmp/acme/out/x.go', '- item\nlazy\n``` /tmp/acme/out/x.go', 'text\n``` /tmp/acme/out/x.go']) {
      const html = renderMarkdownWithRefs(md, CWD);
      expect(html, JSON.stringify(md)).not.toContain('&lt;a');
      expect(html, JSON.stringify(md)).not.toContain('language-&lt;');
    }
    const befores = ['did u find it?```go\n', 'text\n```go\n', 'text\n\n```go\n', '# Title\n```go\n', '- item\n```go\n', '- did u find it?```go\n', '- item\n\nback out```go\n', '> quote\n```go\n', '---\n```go\n', 'Title\n--\n', '    code\n```go\n', 'a ```go\n', ''];
    const closers = ['```', '```\n', '~~~', '````', '  ```'];
    for (const before of befores) {
      for (const closer of closers) {
        const md = `${before}// ${P}:31-34\n${closer}`;
        const html = renderMarkdownWithRefs(md, CWD);
        expect(html, JSON.stringify(md)).not.toContain('&lt;a');
        expect(html, JSON.stringify(md)).not.toContain('&lt;/a');
        expect(fileAnchors(html).length, JSON.stringify(md)).toBe(1);
      }
    }
  });
});
