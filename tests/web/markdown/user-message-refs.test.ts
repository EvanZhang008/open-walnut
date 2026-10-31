import { describe, it, expect, beforeEach } from 'vitest';
import { renderUserMessage } from '@/utils/markdown';
import { resetEntityLabelsForTesting, syncTasks } from '@/stores/entity-label-store';

/**
 * The Personal AI chat's user bubble keeps the typed text verbatim and names the
 * tasks in it (bare ids and task-refs) like every other chat surface. A task-ref
 * that names no task is its words, escaped exactly once (review 2026-10-31: the
 * bubble showed `&amp;quot;`).
 */
describe('renderUserMessage names tasks and escapes once', () => {
  beforeEach(() => {
    resetEntityLabelsForTesting();
    syncTasks([{ id: 'mpwidref-7c2e', title: 'Quarterly invoice reconciliation' }]);
  });
  it('a bare id the user typed is a pill; typed markup stays text', () => {
    const html = renderUserMessage('check mpwidref-7c2e\n<b>not bold</b> & co');
    expect(html).toContain('>Quarterly invoice reconciliation</a>');
    expect(html).toContain('&lt;b&gt;not bold&lt;/b&gt; &amp; co');
  });
  it('a task-ref that names nothing is its label, escaped once', () => {
    // The emitter escapes only `"` in a label (taskRefTag).
    const html = renderUserMessage('<task-ref id="TBD" label="Fix &quot;x&quot; & y > z"/> later');
    expect(html).toContain('Fix &quot;x&quot; &amp; y &gt; z later');
    expect(html).not.toContain('&amp;quot;');
    expect(html).not.toContain('<a');
  });
  it('a source picked from "@" is its pill, not escaped tag text', () => {
    const html = renderUserMessage('ask <source-ref id="slack:user:U1" label="Dana Lee"/> about mpwidref-7c2e');
    expect(html).toContain('<span class="source-link" data-source="slack"');
    expect(html).toContain('>Dana Lee</span>');
    expect(html).not.toContain('&lt;source-ref');
    expect(html).toContain('>Quarterly invoice reconciliation</a>');
  });
});
