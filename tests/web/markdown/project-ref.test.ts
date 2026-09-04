import { describe, it, expect, beforeEach } from 'vitest';
import {
  entityRefsToHtml,
  entityRefsToMarkdownLinks,
  extractFirstRefIds,
  renderMarkdownWithRefs,
  stripEntityRefsToText,
} from '@/utils/markdown';
import { resetEntityLabelsForTesting, syncTasks } from '@/stores/entity-label-store';

/**
 * `<project-ref/>` is the third pill kind, and the one with no identifier of its
 * own: a project IS its name, so `id` carries the name and there is no store to
 * resolve it against. Two consequences these cases pin:
 *   - display is label-or-id, never a lookup (a renamed project is a different
 *     project as far as the ref is concerned);
 *   - every project pill lands on /tasks, because no per-project route exists.
 */

const esc = (s: string) => s.replace(/"/g, '&quot;');

describe('project-ref renders a pill that lands on /tasks', () => {
  beforeEach(() => {
    resetEntityLabelsForTesting();
  });

  it('labeled ref shows the label and carries the name in data-project', () => {
    const html = entityRefsToHtml('<project-ref id="Marina" label="Marina Rebuild"/>');
    expect(html).toBe(
      '<a href="/tasks" class="project-link" data-project="Marina" title="Project: Marina">Marina Rebuild</a>',
    );
  });

  it('unlabeled ref falls back to the name for display AND hover', () => {
    const html = entityRefsToHtml('<project-ref id="Marina"/>');
    expect(html).toContain('>Marina</a>');
    expect(html).toContain('data-project="Marina"');
    expect(html).toContain('title="Project: Marina"');
  });

  it('a `"` in the label round-trips: decoded once, then HTML-escaped once', () => {
    const html = entityRefsToHtml(`<project-ref id="Acme" label="${esc('The "Big" Push')}"/>`);
    expect(html).toContain('>The &quot;Big&quot; Push</a>');
    // Decode-then-escape, not double-escape: no literal `&amp;quot;` on screen.
    expect(html).not.toContain('&amp;quot;');
  });

  it('escapes a name containing & < > in the attribute, the hover, and the body', () => {
    // The tag builder escapes `"` only, so those chars arrive raw in the attribute.
    const html = entityRefsToHtml('<project-ref id="A & <B>"/>');
    expect(html).toContain('data-project="A &amp; &lt;B&gt;"');
    expect(html).toContain('title="Project: A &amp; &lt;B&gt;"');
    expect(html).toContain('>A &amp; &lt;B&gt;</a>');
  });

  it('no task/session store lookup can hijack the display', () => {
    // A project named like a task id must still render as itself: the project
    // path deliberately skips the entity-label store.
    syncTasks([{ id: 't-1234567-abcd', title: 'A Task Title' }]);
    const html = entityRefsToHtml('<project-ref id="t-1234567-abcd"/>');
    expect(html).toContain('>t-1234567-abcd</a>');
    expect(html).not.toContain('A Task Title');
  });

  it('stripEntityRefsToText yields the name (or the label when present)', () => {
    expect(stripEntityRefsToText('in <project-ref id="Marina"/> now')).toBe('in Marina now');
    expect(stripEntityRefsToText('in <project-ref id="Marina" label="Marina Rebuild"/>')).toBe(
      'in Marina Rebuild',
    );
    expect(stripEntityRefsToText(`<project-ref id="Acme" label="${esc('X "Y"')}"/>`)).toBe('X "Y"');
  });

  it('entityRefsToMarkdownLinks yields [name](/tasks)', () => {
    expect(entityRefsToMarkdownLinks('see <project-ref id="Marina"/>')).toBe('see [Marina](/tasks)');
    expect(entityRefsToMarkdownLinks('<project-ref id="Marina" label="Marina Rebuild"/>')).toBe(
      '[Marina Rebuild](/tasks)',
    );
    // Brackets in a label are escaped so the link text can't break the markdown.
    expect(entityRefsToMarkdownLinks('<project-ref id="a[b]"/>')).toBe('[a\\[b\\]](/tasks)');
  });

  it('all three kinds coexist in one text, each with its own target', () => {
    const text =
      'task <task-ref id="t-9999999-aaaa" label="T"/> sess <session-ref id="s-1" label="S"/> proj <project-ref id="P"/>';
    expect(entityRefsToMarkdownLinks(text)).toBe(
      'task [T](/tasks/t-9999999-aaaa) sess [S](/sessions?id=s-1) proj [P](/tasks)',
    );
    expect(stripEntityRefsToText(text)).toBe('task T sess S proj P');
  });

  it('a project ref is NOT a deep-link target (extractFirstRefIds unchanged)', () => {
    expect(extractFirstRefIds('<project-ref id="Marina"/>')).toEqual({});
    expect(extractFirstRefIds('<project-ref id="Marina"/> <task-ref id="t-1" label="T"/>')).toEqual({
      taskId: 't-1',
    });
  });

  it('data-project and the hover survive DOMPurify in the full render pipeline', () => {
    const html = renderMarkdownWithRefs('filed under <project-ref id="Marina" label="Marina Rebuild"/>');
    expect(html).toContain('class="project-link"');
    expect(html).toContain('data-project="Marina"');
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('title="Project: Marina"');
    expect(html).toContain('>Marina Rebuild</a>');
    // In-app href, so no new-tab attributes from the external-anchor hook.
    expect(html).not.toContain('target="_blank"');
  });
});
