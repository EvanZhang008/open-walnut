import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import * as refTags from '@/utils/entity-ref-tags';
import { entityRefsToHtml, filePathsToHtml, linkTaskMentions, renderMarkdownWithRefs, renderToolResultWithRefs } from '@/utils/markdown';
import { resetEntityLabelsForTesting, setTaskLabelFetcher, syncTasks } from '@/stores/entity-label-store';

const id = 'mpwidref-7c2e';
const title = 'Quarterly invoice reconciliation';
const ref = `<task-ref id="${id}" label="Old title"/>`;
const anchor = `<a href="/tasks/${id}" class="task-link" data-task-id="${id}">Old title</a>`;

describe('task references never inject escaped anchors', () => {
  beforeEach(() => {
    resetEntityLabelsForTesting();
    syncTasks([{ id, title }]);
  });

  const emittedRefs = Object.entries(refTags).filter(([name]) => name.endsWith('RefTag'))
    .map(([, build]) => (build as (id: string, label: string, alias: string) => string)(id, 'Review', 'Alias'));
  it.each(emittedRefs)('leaves every emitted reference inside code untouched before markdown parses it', (tag) => {
    for (const source of [`\`${tag}\``, `\`\`\`xml\n${tag}\n\`\`\``, `~~~xml\n${tag}\n~~~`, `Example:\n\n    ${tag}`]) {
      expect(entityRefsToHtml(source)).toBe(source);
    }
  });

  it('the shared input matrix agrees with the phone', async () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/task-anchor-refs.json', import.meta.url), 'utf8')) as {
      tasks: Record<string, string>;
      cases: { name: string; expect: string; id?: string; label?: string; in: string }[];
    };
    vi.useFakeTimers();
    try {
      syncTasks(Object.entries(fixture.tasks).map(([id, title]) => ({ id, title })));
      setTaskLabelFetcher(async (tokens) => tokens.map((token) => ({ token })));
      for (const c of fixture.cases) renderMarkdownWithRefs(c.in);
      await vi.advanceTimersByTimeAsync(100);
      for (const c of fixture.cases) {
        const html = renderMarkdownWithRefs(c.in);
        const { document } = parseHTML(`<html><body>${html}</body></html>`);
        const pills = document.querySelectorAll('a.task-link');
        if (c.expect === 'pill') {
          expect(html, c.name).toContain(`>${fixture.tasks[c.id!]}</a>`);
          expect(html, c.name).not.toContain('&lt;a ');
        } else {
          expect(pills.length, c.name).toBe(0);
          if (c.expect === 'label') {
            expect(document.body.textContent, c.name).toContain(c.label);
            expect(document.body.textContent, c.name).not.toContain('<a ');
          } else if (c.name === 'ordinary link is not a task anchor') {
            expect(document.querySelector('a')?.getAttribute('href'), c.name).toBe('https://example.com/docs');
          } else if (c.name === 'other escaped markup stays') {
            expect(document.body.textContent, c.name).toContain('<b>literal</b>');
          } else {
            expect(document.querySelector('code')?.textContent, c.name).toContain(c.in.includes('<a ') ? '<a ' : '<task-ref');
          }
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['Release a/b/c status', 'Review src/core/check.ts', 'Inspect /var/log/app/check.ts', 'Inspect /var/log/app'])('a task title with a path never grows a file link inside the task anchor: %s', (currentTitle) => {
    syncTasks([{ id, title: currentTitle, project: 'Operations a/b/c' }]);
    const injected = entityRefsToHtml(`Assigned to ${ref}.`);
    expect(filePathsToHtml(injected, '/home/user/repo')).toBe(injected);
    const html = renderMarkdownWithRefs(`Assigned to ${ref}.`, '/home/user/repo');
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    expect(document.querySelector('a.task-link')?.textContent).toBe(currentTitle);
    expect(document.querySelectorAll('a.task-link')).toHaveLength(1);
    expect(document.querySelectorAll('a.file-link')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('<a ');
  });

  it('paths in attributes stay attributes; prose after markup still links', () => {
    const source = '<div title="src/core/check.ts > /var/log/app">src/core/check.ts</div> then src/core/other.ts';
    const html = filePathsToHtml(source, '/home/user/repo');
    expect(html).toContain('<div title="src/core/check.ts > /var/log/app">');
    expect((html.match(/class="file-link"/g) ?? []).length).toBe(2);
    for (const path of ['src/core/check.ts', 'src/core/config', '/var/log/app/check.ts', '/var/log/app']) {
      const wrapped = `<div title="${path}">${path}</div>`;
      const { document } = parseHTML(`<html><body>${filePathsToHtml(wrapped, '/home/user/repo')}</body></html>`);
      expect(document.querySelector('div')?.getAttribute('title'), path).toBe(path);
      expect(document.querySelectorAll('a.file-link'), path).toHaveLength(1);
      expect(document.querySelector('a.file-link')?.textContent, path).toBe(path);
    }
    for (const name of ['task', 'session', 'project', 'source']) {
      const refSource = `<${name}-ref id="${id}" label="src/core/check.ts"/> after src/core/other.ts`;
      const linked = filePathsToHtml(refSource, '/home/user/repo');
      expect(linked).toContain(`<${name}-ref id="${id}" label="src/core/check.ts"/>`);
      expect((linked.match(/class="file-link"/g) ?? []).length).toBe(1);
    }
    for (const [name, build] of Object.entries(refTags).filter(([name]) => name.endsWith('RefTag'))) {
      const source = (build as (id: string, label: string, alias: string) => string)(id, 'src/core/check.ts', 'src/core/check.ts');
      const injected = entityRefsToHtml(source);
      expect(filePathsToHtml(injected, '/home/user/repo'), name).toBe(injected);
    }
  });

  it('an anchor still arriving never grows a nested file link, and a comparison is not a tag', () => {
    const unfinished = '<a href="/tasks/' + id + '" class="task-link">Owner src/app/main.ts';
    expect(filePathsToHtml(unfinished, '/home/user/repo')).toBe(unfinished);
    for (const comparison of [
      'if a < b then edit /var/log/app/check.ts -> done',
      'if n<max then src/core/loop.ts -> done',
      'Compare a<b first.\n\nThen open src/core/b.ts\n\n> note',
      'Vec<u8 bytes come from src/core/c.ts, see Map<K,V>',
    ]) expect(filePathsToHtml(comparison, '/home/user/repo'), comparison).toContain('class="file-link"');
  });

  it('renders a reference next to CJK punctuation without escaping the injected anchor', () => {
    const punctuation = String.fromCodePoint(0xff1a);
    const html = renderMarkdownWithRefs(`${ref}${punctuation}separate issues.`);
    expect(html).toContain(`>${title}</a>`);
    expect(html).not.toContain('&lt;a ');
  });

  it('a task citation in backticks is a pill, never literal generated HTML', () => {
    const html = renderMarkdownWithRefs(`Assigned to \`${ref}\` for review.`);
    expect(html).toContain(`>${title}</a>`);
    expect(html).not.toContain('&lt;a ');
    expect(html).not.toContain('&lt;task-ref');
  });

  it.each([anchor, `<a data-task-id='${id}' class='task-link' href='/tasks/${id}'><b>Old title</b></a>`])('canonicalizes model-written anchors and whole inline-code citations', (tag) => {
    for (const source of [`Assigned to ${tag}.`, `Assigned to \`${tag}\`.`]) {
      const html = renderMarkdownWithRefs(source);
      expect(html).toContain(`>${title}</a>`);
      expect(html).not.toContain('&lt;a ');
      expect(html).not.toContain('Old title');
    }
  });

  it('repairs an escaped task anchor in prose without interpreting arbitrary escaped HTML', () => {
    const escaped = anchor.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = renderMarkdownWithRefs(`Assigned to ${escaped}. &lt;b&gt;literal&lt;/b&gt;`);
    expect(html).toContain(`>${title}</a>`);
    expect(html).not.toContain('&lt;a ');
    expect(html).toContain('&lt;b&gt;literal&lt;/b&gt;');
  });

  it('HTML samples in fenced blocks remain source, not renderer-generated anchors', () => {
    // A code block is syntax highlighted, so its markup is judged by the text it shows, not by escaped bytes.
    const shown = (html: string) => {
      const { document } = parseHTML(`<html><body>${html}</body></html>`);
      return { text: document.querySelector('pre code')?.textContent ?? '', anchors: document.querySelectorAll('a').length };
    };
    for (const render of [renderMarkdownWithRefs, renderToolResultWithRefs]) {
      const { text, anchors } = shown(render(`\`\`\`xml\n${ref}\n\`\`\``));
      expect(text).toContain('<task-ref');
      expect(text).not.toContain('<a ');
      expect(anchors).toBe(0);
    }
    const fenced = shown(renderMarkdownWithRefs(`\`\`\`html\n${anchor}\n\`\`\``));
    expect(fenced.text).toContain('<a ');
    expect(fenced.anchors).toBe(0);
  });

  it('a missing task stays a label and conflicting anchors never open a task', () => {
    const conflict = renderMarkdownWithRefs(`<a href="/tasks/${id}" data-task-id="mvu0ubnq-a02d">Conflict</a>`);
    expect(conflict).toContain('Conflict');
    expect(conflict).not.toContain('<a ');
    const external = renderMarkdownWithRefs(`<a href="https://example.com/tasks/${id}" class="task-link">External</a>`);
    expect(external).toContain('External');
    expect(external).not.toContain('<a ');
  });

  it('keeps longer code as data rather than replacing references with generated HTML', () => {
    const html = renderMarkdownWithRefs(`\`send ${ref}\``);
    expect(html).toContain('send &lt;task-ref');
    expect(html).not.toContain('&lt;a ');
  });

  it('code comparisons and heredocs never hide ordinary paths or bare task IDs', () => {
    for (const source of [
      `\`if a<b then cat src/core/a.ts; see ${id}\``,
      `\`if n<max then cat src/core/a.ts; see ${id}\``,
      `\`\`\`sh\npython3 - <<EOF\nprint(1)\nEOF\ncat src/core/a.ts /var/log/app/run.log\nsee ${id}\n\`\`\``,
    ]) {
      const html = renderMarkdownWithRefs(source, '/home/user/repo');
      const { document } = parseHTML(`<html><body>${html}</body></html>`);
      expect(document.querySelector('a.file-link[data-rel-path="src/core/a.ts"]'), source).not.toBeNull();
      expect(document.querySelector(`a.task-link[data-task-id="${id}"]`)?.textContent, source).toBe(id);
    }
  });

  it('paths and URLs in code sample attributes do not inject anchors before task normalization', () => {
    for (const path of ['src/core/check.ts', '/var/log/app/check.ts', '/var/log/app', 'https://example.com/docs']) {
      const sample = `<a href="/tasks/${id}" class="task-link" title="${path}">Old</a>`;
      for (const source of [`\`send ${sample}\``, `\`\`\`html\n${sample}\n\`\`\``]) {
        const html = renderMarkdownWithRefs(source, '/home/user/repo');
        const { document } = parseHTML(`<html><body>${html}</body></html>`);
        expect(document.querySelector('code')?.textContent, source).toContain(sample);
        expect(document.querySelectorAll('code a'), source).toHaveLength(0);
      }
      const html = renderMarkdownWithRefs(`Assigned to \`${sample}\`.`, '/home/user/repo');
      expect(html, path).toContain(`>${title}</a>`);
      expect(html, path).not.toContain('&lt;a ');
    }
  });

  it('stays linear on a dense reply with incomplete anchors', () => {
    for (const source of [
      `<a class="task-link" href="/tasks/${id}">`.repeat(3000),
      `&lt;a class=&quot;task-link&quot; href=&quot;/tasks/${id}&quot;&gt;`.repeat(3000) + '&lt;/a&gt;',
    ]) {
      const started = performance.now();
      linkTaskMentions(source);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it('an unclosed task anchor never consumes a later link or paragraph', () => {
    for (const suffix of [' then read [docs](https://example.com/docs).', '\n\nOther paragraph.']) {
      const html = renderMarkdownWithRefs(`<a class="task-link" href="/tasks/${id}">Old title${suffix}`);
      expect(html).toContain('Old title');
      expect(html).not.toContain(`>${title}</a>`);
      if (suffix.includes('docs')) expect(html).toContain('href="https://example.com/docs"');
      else expect(html).toContain('Other paragraph.');
    }
  });

  it('duplicate attributes use the first value, as the browser does', () => {
    const html = renderMarkdownWithRefs(`<a href="/tasks/${id}" href="/tasks/mvu0ubnq-a02d" class="task-link">Old</a>`);
    expect(html).toContain(`>${title}</a>`);
    expect(html).not.toContain('data-task-id="mvu0ubnq-a02d"');
  });

  it('keeps a known legacy task ID clickable', () => {
    syncTasks([{ id: 'pw-task-001', title: 'Legacy task' }]);
    expect(renderMarkdownWithRefs('<a href="/tasks/pw-task-001">Old</a>')).toContain('>Legacy task</a>');
  });

  it('rejects mismatched IDs and external destinations when reconstructing a pill', () => {
    const html = linkTaskMentions(`<a href="https://example.com/tasks/${id}" class="task-link" data-task-id="${id}">External</a>`);
    expect(html).not.toContain(`>${title}</a>`);
    const conflict = renderMarkdownWithRefs(`<a href="/tasks/${id}" class="task-link" data-task-id="mpwidrf2-9b10" onclick="bad()">Conflict</a>`);
    expect(conflict).not.toContain('data-task-id="mpwidrf2-9b10"');
  });
});
