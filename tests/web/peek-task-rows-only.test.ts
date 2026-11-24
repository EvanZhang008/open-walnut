/**
 * In a peek zone (Home's task panel) only a task's own title row widens on hover; every other cut
 * text there (a project or folder head, an ask card, a plain control) keeps its place and shows a
 * native tooltip, as it does outside a zone (2026-11-24, the user: "please dont enlarge this
 * automtaiclLY, ANYTHING can easily show all by cusotmer shoudln't auto enarge it is so bad, the task
 * titide in sesion page in task pannel is fine, other debateable"). web/src/utils/truncation-peek-find.ts
 * peekAllowed.
 */
import { parseHTML } from 'linkedom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const html = `<!doctype html><html><body>
  <div data-peek-zone="">
    <div data-peek-row="" data-task-id="t1" id="task-row"><span id="task-title">A long task title</span></div>
    <div class="todo-group-project-header" id="project-head"><span id="project-name">A long project name</span></div>
    <div data-peek-row="" id="plain-row"><span id="plain-text">A list row that is no task</span></div>
    <div data-peek-row="" data-task-id="t2" data-peek-grow="down" id="ask-card"><span id="ask-text">A question</span></div>
    <div data-peek-row="" data-task-id="t3" id="typed"><span id="typed-text">Reply</span><textarea></textarea></div>
    <button id="control"><span id="control-text">A cut button label</span></button>
    <div data-peek-row="" data-fold-task-id="t6"><span id="worker">A worker under its lead</span></div>
    <div data-peek-row="" data-task-id="t7"><div data-peek-row="" id="nested-card"><span id="nested-text">A card inside a task row</span><textarea></textarea></div></div>
  </div>
  <div data-peek-row="" data-task-id="t5"><span id="outside">A task row outside any zone</span></div>
</body></html>`;

let peekAllowed: (el: Element) => boolean;
const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeAll(async () => {
  const { window, document } = parseHTML(html);
  for (const k of ['window', 'document', 'Element', 'HTMLElement']) { saved[k] = g[k]; g[k] = k === 'document' ? document : (window as unknown as Record<string, unknown>)[k] ?? window; }
  ({ peekAllowed } = await import('../../web/src/utils/truncation-peek-find'));
});
afterAll(() => { for (const [k, v] of Object.entries(saved)) g[k] = v; });

describe('the peek widens only a task title row in its zone', () => {
  const doc = () => g.document as Document;
  it('a task row in the zone widens', () => {
    expect(peekAllowed(doc().getElementById('task-title')!)).toBe(true);
    expect(peekAllowed(doc().getElementById('task-row')!)).toBe(true);
    expect(peekAllowed(doc().getElementById('worker')!)).toBe(true);
  });
  it('nothing else in the zone does', () => {
    for (const id of ['project-name', 'project-head', 'plain-text', 'ask-text', 'typed-text', 'control-text', 'nested-text']) {
      expect(peekAllowed(doc().getElementById(id)!), id).toBe(false);
    }
  });
  it('and a task row outside a zone does not', () => {
    expect(peekAllowed(doc().getElementById('outside')!)).toBe(false);
  });
});
