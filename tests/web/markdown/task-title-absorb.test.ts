import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { absorbWrittenTaskTitles, renderMarkdownWithRefs } from '@/utils/markdown';
import { resetEntityLabelsForTesting, syncTasks } from '@/stores/entity-label-store';

/**
 * A title the model wrote beside a task mention is dropped, so the pill (which
 * shows the title) names the task once. The cases are shared with the Board
 * frame and the phone (tests/fixtures/task-title-absorb.json).
 */
const FIXTURE = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../fixtures/task-title-absorb.json', import.meta.url)), 'utf-8')) as {
  tasks: Record<string, string>;
  cases: { name: string; in: string; out: string }[];
};

beforeEach(() => {
  resetEntityLabelsForTesting();
  syncTasks(Object.entries(FIXTURE.tasks).map(([id, title]) => ({ id, title })));
});

describe('the shared cases', () => {
  for (const c of FIXTURE.cases) {
    it(c.name, () => {
      expect(absorbWrittenTaskTitles(c.in)).toBe(c.out);
    });
  }
});

const visible = (html: string) => html
  .replace(/<a [^>]*class="task-link"[^>]*>([^<]*)<\/a>/g, '[[$1]]')
  .replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .trim();

describe('the rendered reply names the task once', () => {
  it('a real reply: bold quoted title before the id', () => {
    const html = renderMarkdownWithRefs(FIXTURE.cases[0]!.in);
    expect(visible(html)).toBe('\u662f [[Home task panel: Flat layout and status sections]]\u3002\u9996\u9875');
  });
  it('a data surface keeps what was written', () => {
    const src = 'mvu0ubnq (Home task panel: Flat layout and status sections)';
    expect(visible(renderMarkdownWithRefs(src, undefined, undefined, { taskIds: 'links' }))).toBe('[[mvu0ubnq]] (Home task panel: Flat layout and status sections)');
  });
  it('a lead shown as its VP still absorbs the stored title', () => {
    syncTasks([{ id: 'mvm0n3bu-6910', title: 'Walnut lead', org_role: 'lead' }]);
    expect(absorbWrittenTaskTitles('Ask "Walnut lead" (mvm0n3bu) first')).toBe('Ask mvm0n3bu first');
  });
  it('an id the list does not know yet keeps the title until it resolves', () => {
    resetEntityLabelsForTesting();
    syncTasks([{ id: 'mpwidref-7c2e', title: 'Quarterly invoice reconciliation' }]);
    const src = 'Home task panel: Flat layout and status sections (mvu0ubnq-a02d)';
    expect(absorbWrittenTaskTitles(src)).toBe(src);
  });
});
