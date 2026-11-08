import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { escapedTagAttrRanges, linkBareTaskIds, type BareTaskIdRenderer } from '@/utils/bare-task-ids';
import {
  markdownToRichHtml,
  renderMarkdownWithRefs,
  renderToolResultWithRefs,
} from '@/utils/markdown';
import {
  getEntityLabelsVersion,
  resetEntityLabelsForTesting,
  syncTasks,
} from '@/stores/entity-label-store';

/**
 * A bare task id in a session's output renders as a task pill.
 *
 * Reported 2026-09-29 with a screenshot of a Chinese reply: a session opened a
 * sentence with one task id in backticks ("<id> confirmed it") and later cited
 * another bare inside the prose ("written into task <id>'s report"). Both showed
 * as dead text, so the user could not tell which task either one was, or open
 * it. Ids here are invented, in the real `<base36>-<hex4>` shape; the CJK test
 * data below is the reply's shape, as escapes.
 */

const A = 'mpwidref-7c2e';
const B = 'mpwidrf2-9b10';
const TITLE_A = 'Quarterly invoice reconciliation';
const TITLE_B = 'Rotate the staging API keys';

const pills = (html: string, id: string) =>
  html.match(new RegExp(`<a [^>]*data-task-id="${id}"[^>]*>[^<]*</a>`, 'g')) ?? [];

describe('bare task ids become task pills', () => {
  beforeEach(() => {
    resetEntityLabelsForTesting();
    syncTasks([
      { id: A, title: TITLE_A, project: 'Walnut' },
      { id: B, title: TITLE_B, project: 'Ops' },
    ]);
  });

  it('the reported shapes: an id in backticks and a bare id in CJK prose', () => {
    const html = renderMarkdownWithRefs(
      `\`${A}\` \u786E\u8BA4\u4E86\u3002\n\n\u8FD9\u4E9B\u5DF2\u7ECF\u5199\u8FDB\u4EFB\u52A1 ${B} \u7684\u62A5\u544A\u3002`,
    );
    // Backticked id: the code span IS the citation, so the pill replaces it.
    expect(pills(html, A)).toEqual([
      `<a href="/tasks/${A}" class="task-link" data-task-id="${A}" title="Walnut / ${TITLE_A}">${TITLE_A}</a>`,
    ]);
    expect(html).not.toContain(`<code>${A}</code>`);
    expect(pills(html, B)).toEqual([
      `<a href="/tasks/${B}" class="task-link" data-task-id="${B}" title="Ops / ${TITLE_B}">${TITLE_B}</a>`,
    ]);
  });

  it('an id glued to CJK characters still links (CJK is not a word char here)', () => {
    const html = renderMarkdownWithRefs(`\u4EFB\u52A1${B}\u7684\u62A5\u544A`);
    expect(pills(html, B)).toHaveLength(1);
  });

  it('an id inside longer code is linked in place and keeps its text', () => {
    const html = renderMarkdownWithRefs(
      `Run \`walnut task show ${A}\` to read it.\n\n\`\`\`\nwalnut tools call task_send '{"task_id":"${B}"}'\n\`\`\``,
    );
    expect(html).toContain(
      `<code>walnut task show <a href="/tasks/${A}" class="task-link task-link-code" data-task-id="${A}" title="Walnut / ${TITLE_A}">${A}</a></code>`,
    );
    const inBlock = pills(html, B);
    expect(inBlock).toHaveLength(1);
    expect(inBlock[0]).toContain('task-link-code');
    expect(inBlock[0]).toContain(`>${B}</a>`);
  });

  it('shows the title even when the title is already written beside the id, and only once', () => {
    // 2026-10-31, the user: a lead wrote `"<title>" (<id>)` and the pill showed
    // only the id, so he could not tell which task it was ("all name").
    const after = renderMarkdownWithRefs(`From task ${B} (${TITLE_B.toLowerCase()}) a reply came back.`);
    expect(pills(after, B)).toEqual([expect.stringContaining(`>${TITLE_B}</a>`)]);
    const before = renderMarkdownWithRefs(`**${TITLE_A}** (\`${A}\`) is done.`);
    expect(pills(before, A)).toEqual([expect.stringContaining(`>${TITLE_A}</a>`)]);
    // The reported shape: a quoted title, then the id in full-width parentheses.
    const cjk = renderMarkdownWithRefs(`\u662F "${TITLE_A}"\uFF08 \`${A}\` \uFF09\u3002`);
    expect(pills(cjk, A)).toEqual([expect.stringContaining(`>${TITLE_A}</a>`)]);
    // The pill absorbs the written title (task-title-absorb.ts): each reads once.
    const once = (html: string, title: string) => html.replace(/<[^>]+>/g, '').toLowerCase().split(title.toLowerCase()).length - 1;
    expect(once(after, TITLE_B)).toBe(1);
    expect(once(before, TITLE_A)).toBe(1);
    expect(once(cjk, TITLE_A)).toBe(1);
  });

  it('an unknown id stays text; a known id links only in the rendered output', () => {
    const html = renderMarkdownWithRefs('Unknown mzzzzzzz-0000 and `mzzzzzzz-0001` stay text.');
    expect(html).not.toContain('<a ');
    expect(html).toContain('<code>mzzzzzzz-0001</code>');
  });

  it('never links an id-shaped piece of a longer token', () => {
    syncTasks([
      { id: A, title: TITLE_A },
      { id: '550e8400-e29b', title: 'Collides with a UUID prefix' },
    ]);
    const cases = [
      `trace 550e8400-e29b-41d4-a716-446655440000 failed`,
      `x-${A} is a suffix`,
      `${A}x is a prefix`,
      `see ${A}.json and ${A}-old`,
      `the dir /tmp/${A}/log holds it`,
      `branch feature/${A} landed`,
      `mail ${A}@example.com`,
    ];
    for (const text of cases) {
      const html = renderMarkdownWithRefs(text);
      expect(html, text).not.toContain('class="task-link');
    }
    // A sentence period and an apostrophe are prose, not part of the token.
    expect(pills(renderMarkdownWithRefs(`Done in ${A}.`), A)).toHaveLength(1);
    expect(pills(renderMarkdownWithRefs(`${A}'s report`), A)).toHaveLength(1);
  });

  it('never nests an anchor: links, task-ref pills, legacy pills, raw anchors', () => {
    const texts = [
      `[${A}](https://example.com/x)`,
      `[see \`${A}\`](https://example.com/x)`,
      `<task-ref id="${A}" label="x"/>`,
      `[${A}|Old Title]`,
      `<a href="https://example.com">${A}</a>`,
      `https://example.com/tasks/${A}`,
    ];
    for (const text of texts) {
      const html = renderMarkdownWithRefs(text);
      expect(html, text).not.toMatch(/<a [^>]*>[^<]*<a /);
      expect((html.match(/<a /g) ?? []).length, text).toBe(1);
    }
    // An anchor still streaming in (no </a> yet) holds the rest of the text.
    const open = renderMarkdownWithRefs(`<a href="https://example.com">see ${A}`);
    expect((open.match(/<a /g) ?? []).length).toBe(1);
    // A self-closing <a/> or a stray </a> does not switch linking off after it.
    const stray = renderMarkdownWithRefs(`<a/> x </a>\n\nthen ${A} here`);
    expect(pills(stray, A)).toHaveLength(1);
  });

  it('model HTML: links in a table cell, never inside svg, button or textarea', () => {
    const html = renderMarkdownWithRefs(
      `<table><tr><td>${A}</td></tr></table>\n\n<svg><text>${B}</text></svg>\n\n<button>${B}</button>\n\n<textarea>${B}</textarea>`,
    );
    expect(pills(html, A)).toHaveLength(1);
    expect(pills(html, B)).toHaveLength(0);
  });

  it('headings, lists and table cells in markdown link too', () => {
    const html = renderMarkdownWithRefs(`## ${A}\n\n- ${B}\n\n| task | state |\n|---|---|\n| \`${A}\` | open |`);
    expect(pills(html, A)).toHaveLength(2);
    expect(pills(html, B)).toHaveLength(1);
  });

  it('escapes a title with markup characters exactly once', () => {
    syncTasks([{ id: A, title: 'A & "B" <C>' }]);
    const html = renderMarkdownWithRefs(`see ${A}`);
    expect(html).toContain('>A &amp; &quot;B&quot; &lt;C&gt;</a>');
    expect(html).not.toContain('<C>');
  });

  it('renders before the task list arrives, then links once it does', () => {
    resetEntityLabelsForTesting();
    const text = `later ${A} arrives`;
    expect(renderMarkdownWithRefs(text)).not.toContain('task-link');
    const v = getEntityLabelsVersion();
    // The render observed the id, so the sync that brings it bumps the version
    // (that is what re-renders the message) and the cache is not reused.
    syncTasks([{ id: A, title: TITLE_A }]);
    expect(getEntityLabelsVersion()).toBeGreaterThan(v);
    expect(pills(renderMarkdownWithRefs(text), A)).toHaveLength(1);
  });

  it('file surfaces opt out; copy-as-rich-text never carries an in-app pill', () => {
    const text = `see ${A} and \`${B}\``;
    const off = renderMarkdownWithRefs(text, undefined, undefined, { taskIds: 'off' });
    expect(off).not.toContain('task-link');
    expect(off).toContain(`<code>${B}</code>`);
    // The opt-out must not poison the cache for the default render.
    expect(pills(renderMarkdownWithRefs(text), A)).toHaveLength(1);
    expect(markdownToRichHtml(text)).not.toContain('task-link');
  });

  it('data surfaces keep every id as its own text: tool output, context', () => {
    // Unfenced JSON renders as prose; a title there would be data the tool never returned.
    const json = `{"depends_on": ["${A}"], "note": "see ${B}"}`;
    const viaTool = renderToolResultWithRefs(json);
    expect(pills(viaTool, A)).toHaveLength(1);
    expect(pills(viaTool, A)[0]).toContain(`>${A}</a>`);
    expect(pills(viaTool, B)[0]).toContain(`>${B}</a>`);
    // The title rides only the hover, never the visible text.
    expect(viaTool).not.toContain(`>${TITLE_A}<`);
    const links = renderMarkdownWithRefs(`\`${A}\` and ${B}`, undefined, undefined, { taskIds: 'links' });
    expect(links).not.toContain(`>${TITLE_A}<`);
    expect(links).not.toContain(`>${TITLE_B}<`);
    // The backticked id stays code, linked inside.
    expect(links).toContain(`<code><a href="/tasks/${A}" class="task-link task-link-code"`);
    expect(pills(links, B)[0]).toContain(`>${B}</a>`);
    // Different modes never share a cache slot.
    expect(pills(renderMarkdownWithRefs(`\`${A}\` and ${B}`), B)[0]).toContain(`>${TITLE_B}</a>`);
  });

  it('a > inside a model-written attribute value does not end the tag', () => {
    const html = renderMarkdownWithRefs(`<span title="a > ${A}">x</span> then ${B}`);
    expect(html).toContain(`title="a > ${A}"`);
    expect(pills(html, A)).toHaveLength(0);
    expect(pills(html, B)).toHaveLength(1);
  });

  it('tool results link ids in their code without double-wrapping JSON id pills', () => {
    const html = renderToolResultWithRefs(`\`\`\`\n{"task_id": "${A}", "parent": "${B}"}\n\`\`\``);
    expect(pills(html, A)).toHaveLength(1);
    expect(pills(html, B)).toHaveLength(1);
    expect(html).not.toMatch(/<a [^>]*>[^<]*<a /);
  });

  it('stays linear on a large message full of id-shaped tokens', () => {
    const big = Array.from({ length: 4000 }, (_, i) => `row ${i} m${String(i).padStart(7, '0')}-abcd and ${A}`).join('\n');
    const t0 = performance.now();
    const html = renderMarkdownWithRefs(big);
    const ms = performance.now() - t0;
    expect(pills(html, A)).toHaveLength(4000);
    expect(ms).toBeLessThan(3000);
  });
});

describe('ids in escaped markup attributes stay source', () => {
  const r: BareTaskIdRenderer = {
    resolve: (t) => (t === A || t === B ? { id: t, title: `Title ${t}` } : undefined),
    anchor: (id, label, inCode) => `<a data-task-id="${id}"${inCode ? ' data-code' : ''}>${label}</a>`,
  };
  const link = (html: string) => linkBareTaskIds(html, r, 'pills');

  beforeEach(() => {
    resetEntityLabelsForTesting();
    syncTasks([{ id: A, title: TITLE_A }, { id: B, title: TITLE_B }]);
  });

  it('every quote form, unquoted values, a &gt; inside a value, several tags', () => {
    const unchanged = [
      `<code>send &lt;task-ref id=&quot;${A}&quot; label=&quot;Old title&quot;/&gt;</code>`,
      `<code>&lt;task-ref id=&#39;${A}&#39;/&gt;</code>`,
      `<code>&lt;task-ref id=&#34;${A}&#34;/&gt;</code>`,
      `<code>&lt;task-ref id=&#x27;${A}&#x27;/&gt;</code>`,
      `<code>&lt;task-ref id="${A}"/&gt;</code>`,
      `<code>&lt;task-ref id=${A} /&gt;</code>`,
      `<code>&lt;span title=&quot;a &gt; b&quot; data-id=&quot;${A}&quot;&gt;x&lt;/span&gt;</code>`,
      `<code>&lt;a href=&quot;/tasks/${A}&quot;&gt;x&lt;/a&gt; and &lt;task-ref id=&quot;${B}&quot;/&gt;</code>`,
      `<pre><code>&lt;a\n  href=&quot;/tasks/${A}&quot;\n  class=&quot;task-link&quot;&gt;Old&lt;/a&gt;\n</code></pre>`,
    ];
    for (const html of unchanged) expect(link(html), html).toBe(html);
    // Offsets run from after the tag name to past its `&gt;`.
    expect(escapedTagAttrRanges('x &lt;a id=&quot;q&quot;&gt; y')).toEqual([[7, 28]]);
  });

  it('a real bare id beside a sample, text between tags, and prose comparisons still link', () => {
    expect(link(`<code>send &lt;task-ref id=&quot;${A}&quot;/&gt; then ${B}</code>`)).toBe(
      `<code>send &lt;task-ref id=&quot;${A}&quot;/&gt; then <a data-task-id="${B}" data-code>${B}</a></code>`,
    );
    expect(link(`<code>&lt;b&gt;${A}&lt;/b&gt;</code>`)).toContain(`<a data-task-id="${A}" data-code>${A}</a>`);
    // `&lt;` followed by a space is a comparison, not a tag.
    expect(link(`<p>x &lt; ${A} &gt; y</p>`)).toContain(`<a data-task-id="${A}">Title ${A}</a>`);
    // An id written as the tag name itself is not an attribute.
    expect(link(`<p>&lt;${A}&gt;</p>`)).toContain(`data-task-id="${A}"`);
  });

  it('long and boolean attributes, and a tag cut off inside an assignment, stay source', () => {
    const kept = [
      `<code>&lt;a title=&quot;${'x'.repeat(5000)}&quot; href=&quot;/tasks/${A}&quot;&gt;x&lt;/a&gt;</code>`,
      `<code>&lt;input disabled data-id=&quot;${A}&quot; hidden&gt;</code>`,
      `<code>&lt;task-ref id=&quot;${A}</code>`,
      `<code>&lt;task-ref id=${A}</code>`,
      `<pre><code>&lt;task-ref label=&quot;x&quot; id=${A}\n</code></pre>`,
      `<code>&lt;a title=&#39;it ${A} &gt; x</code>`,
    ];
    for (const html of kept) expect(link(html), html).toBe(html);
    // No attribute value confirmed: an open tag with only bare words is not a sample.
    expect(link(`<code>&lt;a hidden ${A}</code>`)).toContain(`<a data-task-id="${A}" data-code>`);
  });

  it('comparisons and heredocs are not tags: their ids still link', () => {
    for (const html of [
      `<code>if a&lt;b then cat src/core/a.ts ${A}</code>`,
      `<code>a&lt;b &amp;&amp; c&gt;d ${A}</code>`,
      `<pre><code>python3 - &lt;&lt;EOF\nimport json\nprint(json.dumps({&quot;task_id&quot;: &quot;${A}&quot;}))\nEOF\n</code></pre>`,
      `<pre><code>cat &lt;&lt;&#39;EOF&#39; &gt; out.txt\nsee ${A}\nEOF\n</code></pre>`,
      `<pre><code>cat &lt;&lt;EOF\nx = {&quot;id&quot;: &quot;${A}&quot;}\nEOF\n</code></pre>`,
    ]) {
      expect(link(html), html).toContain(`<a data-task-id="${A}" data-code>${A}</a>`);
    }
  });

  it('one pass over the input: many tags and quotes stay fast', () => {
    const big = Array.from({ length: 20000 }, () => `&lt;a t=&quot;x &#39; ${A}&quot;&gt; ${B} &lt;b &quot;`).join('');
    const t0 = performance.now();
    const html = link(`<code>${big}</code>`);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(html).not.toContain(`data-task-id="${A}"`);
    // Failed candidates with long attribute runs and quotes over later tags do not rescan the rest.
    for (const text of [
      '&lt;a x '.repeat(160000) + '/ nope',
      '&lt;a title=&quot;'.repeat(160000) + '&quot; / nope',
      '&lt;a ' + 'b c=&quot;&lt;d e &#39;f&quot; g=&#39;&lt;h&#39; '.repeat(40000) + '/ nope',
    ]) {
      const t1 = performance.now();
      escapedTagAttrRanges(text);
      expect(performance.now() - t1).toBeLessThan(3000);
    }
  });

  it('shared fixture: samples in longer code, fences and indented blocks keep their source; whole citations are pills', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/task-anchor-refs.json', import.meta.url), 'utf8')) as {
      tasks: Record<string, string>;
      cases: { name: string; expect: string; id?: string; in: string }[];
    };
    syncTasks(Object.entries(fixture.tasks).map(([id, title]) => ({ id, title })));
    const samples = fixture.cases.filter((c) => c.expect === 'source' && /sample/.test(c.name));
    expect(samples.length).toBeGreaterThanOrEqual(4);
    for (const c of samples) {
      const { document } = parseHTML(`<html><body>${renderMarkdownWithRefs(c.in)}</body></html>`);
      expect(document.querySelectorAll('a.task-link').length, c.name).toBe(0);
      const code = document.querySelector('code')?.textContent ?? '';
      expect(code, c.name).toContain(c.in.includes('<a ') ? '<a ' : '<task-ref ');
      if (c.in.includes('class="task-link"')) expect(code, c.name).toContain('class="task-link"');
    }
    const whole = fixture.cases.filter((c) => c.expect === 'pill' && /backticks/.test(c.name));
    expect(whole.length).toBeGreaterThanOrEqual(3);
    for (const c of whole) expect(renderMarkdownWithRefs(c.in), c.name).toContain(`>${fixture.tasks[c.id!]}</a>`);
  });
});
