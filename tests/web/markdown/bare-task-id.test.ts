import { describe, it, expect, beforeEach } from 'vitest';
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

  it('keeps the id as the label when the title is already written beside it', () => {
    const after = renderMarkdownWithRefs(`From task ${B} (${TITLE_B.toLowerCase()}) a reply came back.`);
    expect(pills(after, B)).toHaveLength(1);
    expect(pills(after, B)[0]).toContain(`>${B}</a>`);
    const before = renderMarkdownWithRefs(`**${TITLE_A}** (\`${A}\`) is done.`);
    expect(pills(before, A)).toHaveLength(1);
    expect(pills(before, A)[0]).toContain(`>${A}</a>`);
    // A title mentioned far away does not count.
    const far = renderMarkdownWithRefs(`${TITLE_A} came up earlier in a long unrelated sentence. Later, ${A} finished.`);
    expect(pills(far, A)[0]).toContain(`>${TITLE_A}</a>`);
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
