import { describe, it, expect, beforeEach } from 'vitest';
import {
  entityRefsToHtml,
  entityRefsToMarkdownLinks,
  renderMarkdownWithRefs,
  stripEntityRefsToText,
} from '@/utils/markdown';
import {
  registerSessionTitle,
  resetEntityLabelsForTesting,
  syncTasks,
} from '@/stores/entity-label-store';

/**
 * Pill display precedence (the fix for "pill shows the AI's paraphrase"):
 *   current title from the entity-label store  >  label attr (alias)  >  id.
 * The store is the source of truth; the AI-provided label is only a fallback
 * for unresolvable ids (deleted task, unsynced replica).
 */

const esc = (s: string) => s.replace(/"/g, '&quot;');

describe('task-ref resolves the CURRENT task title', () => {
  beforeEach(() => {
    resetEntityLabelsForTesting();
  });

  it('resolved title beats a stale label; no project prefix in the pill body', () => {
    syncTasks([{ id: 't-1234567-abcd', title: 'Real Current Title', project: 'Walnut' }]);
    const html = entityRefsToHtml('<task-ref id="t-1234567-abcd" label="Stale AI Paraphrase"/>');
    expect(html).toContain('>Real Current Title</a>');
    expect(html).not.toContain('Stale AI Paraphrase');
    expect(html).not.toContain('>Walnut / Real Current Title<');
    // Project rides the hover tooltip instead.
    expect(html).toContain('title="Walnut / Real Current Title"');
  });

  it('unlabeled + resolvable → title; unlabeled + unresolvable → id; labeled + unresolvable → label', () => {
    syncTasks([{ id: 't-known-1111', title: 'Known Task' }]);
    expect(entityRefsToHtml('<task-ref id="t-known-1111"/>')).toContain('>Known Task</a>');
    expect(entityRefsToHtml('<task-ref id="t-ghost-2222"/>')).toContain('>t-ghost-2222</a>');
    const labeled = entityRefsToHtml('<task-ref id="t-ghost-2222" label="Alias Label"/>');
    expect(labeled).toContain('>Alias Label</a>');
    // Unresolved hover carries the id, so the failed lookup is diagnosable.
    expect(labeled).toContain('title="t-ghost-2222"');
  });

  it('escapes a resolved title exactly once (& < > ")', () => {
    syncTasks([{ id: 't-esc-1111', title: 'A & "B" <C>' }]);
    const html = entityRefsToHtml('<task-ref id="t-esc-1111" label="x"/>');
    expect(html).toContain('>A &amp; &quot;B&quot; &lt;C&gt;</a>');
  });

  it('a store title containing the LITERAL &quot; is not decoded (labels are, titles are not)', () => {
    syncTasks([{ id: 't-lit-1111', title: 'say &quot;hi&quot;' }]);
    const html = entityRefsToHtml('<task-ref id="t-lit-1111"/>');
    // Raw title chars survive: & escapes to &amp; so the literal &quot; shows on screen.
    expect(html).toContain('>say &amp;quot;hi&amp;quot;</a>');
    // The label FALLBACK path still decodes taskRefTag's attribute escaping.
    const fallback = entityRefsToHtml(`<task-ref id="t-none-9999" label="${esc('Fix "A"')}"/>`);
    expect(fallback).toContain('>Fix &quot;A&quot;</a>');
  });

  it('the hover title attribute survives DOMPurify in the full pipeline', () => {
    syncTasks([{ id: 't-tip-1111', title: 'Tipped', project: 'Proj' }]);
    const html = renderMarkdownWithRefs('see <task-ref id="t-tip-1111" label="old"/>');
    expect(html).toContain('data-task-id="t-tip-1111"');
    expect(html).toContain('title="Proj / Tipped"');
    expect(html).toContain('>Tipped</a>');
  });

  it('stripEntityRefsToText and entityRefsToMarkdownLinks use the same precedence', () => {
    syncTasks([{ id: 't-str-1111', title: 'Stripped Title' }]);
    registerSessionTitle('sess-abc', 'Session Title');
    const text = 'task <task-ref id="t-str-1111" label="stale"/> sess <session-ref id="sess-abc" label="old sess"/> ghost <task-ref id="t-gh-1" label="Ghost Label"/>';
    const stripped = stripEntityRefsToText(text);
    expect(stripped).toContain('task Stripped Title');
    expect(stripped).toContain('sess Session Title');
    expect(stripped).toContain('ghost Ghost Label');
    const links = entityRefsToMarkdownLinks(text);
    expect(links).toContain('[Stripped Title](/tasks/t-str-1111)');
    expect(links).toContain('[Session Title](/sessions?id=sess-abc)');
    expect(links).toContain('[Ghost Label](/tasks/t-gh-1)');
  });

  it('legacy [id|label] pill resolves through the taskLink marked extension', () => {
    syncTasks([{ id: 'mr9i88ys-87a4', title: 'Fresh Legacy Title' }]);
    const html = renderMarkdownWithRefs('[mr9i88ys-87a4|Old Embedded Title]');
    expect(html).toContain('data-task-id="mr9i88ys-87a4"');
    expect(html).toContain('>Fresh Legacy Title</a>');
    expect(html).not.toContain('Old Embedded Title');
    // Unresolvable legacy id keeps its embedded title.
    const fallback = renderMarkdownWithRefs('[zz9i88ys-87a4|Embedded Only]');
    expect(fallback).toContain('>Embedded Only</a>');
  });

  it('session-ref resolves from registerSessionTitle, label fallback otherwise', () => {
    registerSessionTitle('sess-live-1', 'Live Session Name');
    const html = entityRefsToHtml('<session-ref id="sess-live-1" label="AI said something else"/>');
    expect(html).toContain('>Live Session Name</a>');
    const fallback = entityRefsToHtml('<session-ref id="sess-unknown" label="Fallback Name"/>');
    expect(fallback).toContain('>Fallback Name</a>');
  });

  it('CACHE COHERENCE: a store change re-renders the same text with the new title', () => {
    const text = 'pill: <task-ref id="t-cache-11" label="Stale"/>';
    // First render: store empty → label fallback (and the id becomes observed).
    expect(renderMarkdownWithRefs(text)).toContain('>Stale</a>');
    // Store learns the task → version bumps (observed id) → cache must not
    // serve the old HTML for the byte-identical input.
    syncTasks([{ id: 't-cache-11', title: 'Fresh From Store' }]);
    expect(renderMarkdownWithRefs(text)).toContain('>Fresh From Store</a>');
  });
});
