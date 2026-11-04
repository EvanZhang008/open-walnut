/**
 * Ratchet: a browser spec that answers the task list itself keeps other workers' tasks out.
 *
 * 2026-11-04 (CI run 41770441217): home-navigation.spec.ts's sticky headings case answered
 * `/api/tasks` with its own board, yet a pinned row another worker's spec had just created
 * (kebab-menu-viewport-fit.spec.ts) reached its Satellite tier through a live `task:updated`
 * frame, and every row under it moved 69px mid-measure. The browser fixture server is shared
 * by every parallel worker and the web task store upserts a task from such a frame, so the
 * class is every spec that stubs the task list without filtering those frames.
 *
 * Every file under tests/e2e/browser that fulfills a task list route, or calls answerTaskList,
 * is found here from the source. It must answer through `answerTaskList`
 * (tests/e2e/browser/task-list-stub.ts) or route the socket itself (`routeWebSocket`). PREDATES
 * lists the files that did neither when this rule came in; it may only shrink: an entry that
 * now follows the rule, or is gone, fails.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { foreignTaskFrame } from '../e2e/browser/task-list-stub';

const DIR = join(__dirname, '../e2e/browser');

const PREDATES = new Set([
  'ask-chat-earlier-helpers.ts',
  'bare-task-id-pills.spec.ts',
  'board-kanban.spec.ts',
  'completed-archive-lazy-load.spec.ts',
  'filter-bar-board.spec.ts',
  'home-navigation-density.spec.ts',
  'org-alert-answer.spec.ts',
  'phone-home-r4.spec.ts',
  'phone-pages.spec.ts',
  'show-earlier-scroll-anchor.spec.ts',
  'system-attention.spec.ts',
  'task-url-restoration.spec.ts',
]);

/** A route on the task list: the globs `**\/api/tasks?*`, `?**` and `*`, or the regex
 *  `/\/api\/tasks(\?|$)/`. */
const TASK_LIST_GLOB = /\.route\(\s*['"`]\*\*\/api\/tasks(?:\?\*\*?|\*)['"`]/;
const TASK_LIST_REGEX = 'route(/\\/api\\/tasks(\\?|$)/';
const routesTaskList = (src: string) => TASK_LIST_GLOB.test(src) || src.includes(TASK_LIST_REGEX);

function members(): Array<{ file: string; isolated: boolean }> {
  return readdirSync(DIR)
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) => {
      const src = readFileSync(join(DIR, file), 'utf8');
      const answers = /\banswerTaskList\(/.test(src) || (routesTaskList(src) && src.includes('fulfill('));
      if (!answers) return [];
      return [{ file, isolated: /\banswerTaskList\(|\.routeWebSocket\(/.test(src) }];
    });
}

describe('specs that answer the task list', () => {
  it('finds the class (the scan still matches the source)', () => {
    expect(members().map((m) => m.file)).toContain('home-navigation.spec.ts');
  });

  it('keep other workers\' task frames out, or are listed as predating the rule', () => {
    const open = members().filter((m) => !m.isolated && !PREDATES.has(m.file)).map((m) => m.file);
    expect(open, 'answer the task list with answerTaskList (tests/e2e/browser/task-list-stub.ts)').toEqual([]);
  });

  it('PREDATES only shrinks: every entry still answers the list without the filter', () => {
    const stillOpen = new Set(members().filter((m) => !m.isolated).map((m) => m.file));
    expect([...PREDATES].filter((file) => !stillOpen.has(file)), 'remove these from PREDATES').toEqual([]);
  });
});

describe('foreignTaskFrame', () => {
  const ours = new Set(['so1']);
  const frame = (name: string, data: unknown) => JSON.stringify({ type: 'event', name, data, seq: 1 });

  it('drops an event about a task the stub never answered', () => {
    expect(foreignTaskFrame(frame('task:updated', { task: { id: 'other-worker-task' } }), ours)).toBe(true);
    expect(foreignTaskFrame(frame('task:created', { task: { id: 'other-worker-task' } }), ours)).toBe(true);
  });

  it('passes the stub\'s own tasks, events without a task, replies and anything unparsable', () => {
    expect(foreignTaskFrame(frame('task:updated', { task: { id: 'so1' } }), ours)).toBe(false);
    expect(foreignTaskFrame(frame('task:updated', {}), ours)).toBe(false);
    expect(foreignTaskFrame(frame('task:deleted', { id: 'other-worker-task' }), ours)).toBe(false);
    expect(foreignTaskFrame(JSON.stringify({ type: 'res', id: 'r1', ok: true, payload: { task: { id: 'x' } } }), ours)).toBe(false);
    expect(foreignTaskFrame('not json', ours)).toBe(false);
  });
});
