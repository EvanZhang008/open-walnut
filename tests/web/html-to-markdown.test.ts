/**
 * Rich paste → markdown for the plain-textarea composers.
 *
 * A wiki page copied into the session composer arrived as a flat run of lines
 * with every list marker and every level of nesting gone (2026-09-03). The
 * converter walks the clipboard's text/html instead; these pin the shapes real
 * editors put on the clipboard, and the gate that leaves prose-only HTML to the
 * browser's native paste.
 */
import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { pastedHtmlToMarkdown, domToMarkdown } from '../../web/src/utils/html-to-markdown';

const parse = (html: string) => parseHTML(`<!doctype html><html><body>${html}</body></html>`).document.body as unknown as ParentNode;
const md = (html: string) => pastedHtmlToMarkdown(html, parse);

describe('pastedHtmlToMarkdown: the gate', () => {
  it('leaves prose-only HTML to the native paste', () => {
    expect(md('<meta charset="utf-8"><p>Just a sentence.</p><p>Another.</p>')).toBeNull();
  });

  it('leaves syntax-coloured editor code (div/span soup) to the native paste', () => {
    const vscode = '<meta charset="utf-8"><div style="color:#d4d4d4;white-space:pre;"><div><span style="color:#569cd6;">const</span><span> x = 1;</span></div><div><span>  return x;</span></div></div>';
    expect(md(vscode)).toBeNull();
  });

  it('ignores empty input and non-HTML strings', () => {
    expect(md('')).toBeNull();
    expect(md('1 < 2 and 3 > 2')).toBeNull();
  });

  it('takes over as soon as there is a list, heading, table, code block or quote', () => {
    expect(md('<ul><li>a</li></ul>')).toBe('- a');
    expect(md('<h2>Title</h2>')).toBe('## Title');
    expect(md('<blockquote><p>quoted</p></blockquote>')).toBe('> quoted');
    expect(md('<pre>x = 1</pre>')).toBe('```\nx = 1\n```');
  });
});

describe('lists: the shape a ProseMirror-style wiki editor copies', () => {
  // Each item's text is wrapped in <p>; nested lists sit after it inside the same <li>;
  // empty paragraphs and an empty trailing item pad the selection.
  const wiki = `<meta charset='utf-8'>
<p></p><p></p>
<p>AI</p>
<ol>
  <li><p>CFS - can we use CFS, the proxy routes each namespace to a different one.</p></li>
  <li><p>Why EKS over SFN</p>
    <ol>
      <li><p>My thinking is</p>
        <ol>
          <li><p>SFN is hard to test; the whole workflow runs locally as a component test.</p></li>
          <li><p>More flexible: the plugin can be an API or read from a queue.</p></li>
        </ol>
      </li>
      <li><p>The downside is EKS maintenance: OOM, observability.</p>
        <ol>
          <li><p>Mitigated: we already run on EKS, so we have the confidence.</p></li>
          <li><p>I haven't had time to</p></li>
        </ol>
      </li>
    </ol>
  </li>
  <li><p>Permission</p></li>
  <li><p>Migration and find the correct owner</p></li>
  <li><p>Estimation, and head count</p></li>
  <li><p></p></li>
</ol>
<p></p>
<p>Non goal :</p>
<ol><li><p>20h</p></li><li><p>Deprecate api is solved in separate design</p></li></ol>`;

  it('keeps numbering, nesting and drops the empty padding blocks', () => {
    expect(md(wiki)).toBe([
      'AI',
      '',
      '1. CFS - can we use CFS, the proxy routes each namespace to a different one.',
      '2. Why EKS over SFN',
      '   1. My thinking is',
      '      1. SFN is hard to test; the whole workflow runs locally as a component test.',
      '      2. More flexible: the plugin can be an API or read from a queue.',
      '   2. The downside is EKS maintenance: OOM, observability.',
      '      1. Mitigated: we already run on EKS, so we have the confidence.',
      "      2. I haven't had time to",
      '3. Permission',
      '4. Migration and find the correct owner',
      '5. Estimation, and head count',
      '',
      'Non goal :',
      '',
      '1. 20h',
      '2. Deprecate api is solved in separate design',
    ].join('\n'));
  });

  it('bullets nest under numbers with marker-width indentation', () => {
    expect(md('<ol><li>one<ul><li>sub a</li><li>sub b</li></ul></li><li>two</li></ol>'))
      .toBe('1. one\n   - sub a\n   - sub b\n2. two');
  });

  it('honours the start attribute of a list copied mid-way', () => {
    expect(md('<ol start="7"><li>seven</li><li>eight</li></ol>')).toBe('7. seven\n8. eight');
  });

  it('renders task lists with checkboxes', () => {
    expect(md('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>'))
      .toBe('- [x] done\n- [ ] todo');
  });

  it('keeps a fenced code block inside a list item indented to the item', () => {
    expect(md('<ol><li><p>Run</p><pre><code class="language-sh">npm test\nnpm run build</code></pre></li><li>Done</li></ol>'))
      .toBe('1. Run\n   ```sh\n   npm test\n   npm run build\n   ```\n2. Done');
  });

  it('renders a stray <li> without a list parent as a bullet', () => {
    expect(domToMarkdown(parse('<div><li>alone</li></div>'))).toBe('- alone');
  });
});

describe('inline formatting', () => {
  it('bold, italic, strikethrough and inline code, with the spaces kept outside the marks', () => {
    expect(md('<h3>t</h3><p>a <strong>bold </strong>word, <em>it</em>, <s>gone</s>, <code>x</code></p>'))
      .toBe('### t\n\na **bold** word, *it*, ~~gone~~, `x`');
  });

  it("ignores Google Docs' font-weight:normal <b> wrapper", () => {
    expect(md('<b style="font-weight:normal;" id="docs-internal-guid-1"><h1>Doc</h1><p>text</p></b>'))
      .toBe('# Doc\n\ntext');
  });

  it('links: labelled ones become markdown links, bare URLs stay bare, relative hrefs keep only the text', () => {
    expect(md('<ul><li><a href="https://example.com/x">Docs</a></li><li><a href="https://example.com/y">https://example.com/y</a></li><li><a href="/rel">Rel</a></li></ul>'))
      .toBe('- [Docs](https://example.com/x)\n- https://example.com/y\n- Rel');
  });

  it('drops data-URI images down to their alt text', () => {
    expect(md('<h1>H</h1><p><img alt="diagram" src="data:image/png;base64,AAAA"></p><p><img alt="" src="https://example.com/a.png"></p>'))
      .toBe('# H\n\ndiagram\n\n![](https://example.com/a.png)');
  });

  it('collapses HTML whitespace runs and nbsp like a browser would', () => {
    expect(md('<ul><li>a&nbsp;&nbsp;b\n   c</li></ul>')).toBe('- a b c');
  });
});

describe('blocks', () => {
  it('headings, horizontal rules and line breaks', () => {
    expect(md('<h1>One</h1><p>first<br>second</p><hr><h2>Two</h2>')).toBe('# One\n\nfirst\nsecond\n\n---\n\n## Two');
  });

  it('blockquotes prefix every line, keeping blank lines between their paragraphs', () => {
    expect(md('<blockquote><p>a</p><p>b</p></blockquote>')).toBe('> a\n>\n> b');
  });

  it('code blocks keep their whitespace verbatim (including blank lines) and pick up the language', () => {
    expect(md('<pre class="language-ts">a\n\n\n  b</pre>')).toBe('```ts\na\n\n\n  b\n```');
  });

  it('tables become GFM tables with a header row and escaped pipes', () => {
    expect(md('<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr><tr><td>c</td></tr></tbody></table>'))
      .toBe('| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n| c | |');
  });

  it('skips scripts, styles and hidden nodes', () => {
    expect(md('<style>p{}</style><script>x()</script><ul><li>keep</li><li style="display:none">hide</li></ul>')).toBe('- keep');
  });
});
