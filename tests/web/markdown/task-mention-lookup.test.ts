import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { entityRefsToHtml, renderMarkdownWithRefs } from '@/utils/markdown';
import {
  getEntityLabelsVersion,
  isTaskTokenMissing,
  resetEntityLabelsForTesting,
  resolveTaskToken,
  setTaskLabelFetcher,
  syncTasks,
  type TaskLookupAnswer,
} from '@/stores/entity-label-store';
import { isTaskLookupToken, isTaskPrefixToken, taskTokensIn } from '@/utils/task-id-shape';

/**
 * Every task a chat message names reads as the task's name (2026-10-31, the
 * user: "make all the task if it is reference in the chat output all name so
 * that user can click"). The reported Org chat cited tasks three ways the old
 * renderer left as raw text or as an id pill: a full id beside its title, an
 * id's first segment ("Ask here is being changed by mvkghc5v"), and a synced
 * task's UUID prefix ("the Chat order task (2ac88910)"). Ids are invented in
 * the real shapes; CJK test data is escaped.
 */

const SHORT = 'mvkghc5v-278c';
const UUID = '2ac88910-c19a-566b-a690-10048f4e1d02';
const T_SHORT = 'Ask here thread layout';
const T_UUID = 'Chat order';

const pills = (html: string, id: string) =>
  html.match(new RegExp(`<a [^>]*data-task-id="${id}"[^>]*>[^<]*</a>`, 'g')) ?? [];

describe('task id shapes', () => {
  it('a prefix needs 7+ characters and a letter; only one with a digit is ever looked up', () => {
    expect(isTaskPrefixToken('mvkghc5v')).toBe(true);
    expect(isTaskPrefixToken('2ac88910')).toBe(true);
    // An all-letter time segment is a real id shape (about one in fourteen): matched against the list only.
    expect(isTaskPrefixToken('mpwidref')).toBe(true);
    expect(isTaskLookupToken('mpwidref')).toBe(false);
    expect(isTaskLookupToken('because')).toBe(false);
    expect(isTaskLookupToken('mvkghc5v')).toBe(true);
    expect(isTaskPrefixToken('20261031')).toBe(false);
    expect(isTaskPrefixToken('ab12')).toBe(false);
  });

  it('finds tokens standing alone, never inside paths, files, addresses or longer ids', () => {
    expect(taskTokensIn(`by mvkghc5v, see ${UUID} and \u4EFB\u52A1\uFF082ac88910\uFF09`)).toEqual(['mvkghc5v', UUID, '2ac88910']);
    expect(taskTokensIn('/tmp/mvkghc5v/x mvkghc5v.json a@mvkghc5v mvkghc5v_x')).toEqual([]);
  });
});

describe('prefixes and UUIDs resolve against the task list', () => {
  beforeEach(() => {
    resetEntityLabelsForTesting();
    syncTasks([
      { id: SHORT, title: T_SHORT, project: 'Walnut' },
      { id: UUID, title: T_UUID, project: 'Walnut' },
      { id: 'mvaaaaa1-0001', title: 'Twin one' },
      { id: 'mvaaaaa1-0002', title: 'Twin two' },
    ]);
  });

  it('the reported Org chat lines read as names', () => {
    const html = renderMarkdownWithRefs(
      '\u8FD9\u4E2A\u95EE\u9898\u4EA4\u7ED9 Chat order \u4EFB\u52A1\uFF082ac88910\uFF09\u3002Ask here \u6B63\u7531 mvkghc5v \u5728\u6539\u3002',
    );
    expect(pills(html, UUID)).toEqual([`<a href="/tasks/${UUID}" class="task-link" data-task-id="${UUID}" title="Walnut / ${T_UUID}">${T_UUID}</a>`]);
    expect(pills(html, SHORT)).toEqual([expect.stringContaining(`>${T_SHORT}</a>`)]);
  });

  it('a full UUID and a two-segment prefix link too; an ambiguous prefix stays text', () => {
    const html = renderMarkdownWithRefs(`${UUID} and 2ac88910-c19a, but mvaaaaa1 is two tasks`);
    expect(pills(html, UUID)).toHaveLength(2);
    expect(html).toContain('but mvaaaaa1 is two tasks');
  });

  it('a prefix that is not a whole segment, or a code dump, keeps its text', () => {
    // Not a segment boundary: a hash that happens to start the same way.
    expect(renderMarkdownWithRefs('commit 2ac8891 landed')).not.toContain('<a ');
    // Inside longer code the token stays as written, linked in place.
    const code = renderMarkdownWithRefs('`walnut task show mvkghc5v`');
    expect(code).toContain(`<code>walnut task show <a href="/tasks/${SHORT}" class="task-link task-link-code"`);
    expect(code).toContain('>mvkghc5v</a></code>');
  });

  it('task-ref: empty id is plain text, a prefix id names the full task', () => {
    expect(entityRefsToHtml('<task-ref id="" label="Some task"/>')).toBe('Some task');
    expect(entityRefsToHtml('<task-ref id=""/>')).toBe('');
    expect(entityRefsToHtml('<task-ref id="mvkghc5v" label="old words"/>')).toContain(`data-task-id="${SHORT}"`);
    expect(entityRefsToHtml('<task-ref id="TBD" label="later"/>')).toBe('later');
    // Letters only and not in the list: no lookup will ever name it, so it is text now.
    expect(entityRefsToHtml('<task-ref id="mvnothere" label="Words"/>')).toBe('Words');
    // An all-letter first segment the list holds names its task.
    syncTasks([{ id: 'mpwidref-7c2e', title: 'Letters only' }]);
    expect(renderMarkdownWithRefs('changed by mpwidref; ok')).toContain('>Letters only</a>');
  });
});

describe('ids the list does not hold are looked up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEntityLabelsForTesting();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetEntityLabelsForTesting();
  });

  const GHOST = 'mvzzzzzz-9999';
  const OUTSIDE = 'mvout5id-0042';

  it('one batched call after the list loads; the answer re-renders; a miss is asked once', async () => {
    const calls: string[][] = [];
    setTaskLabelFetcher(async (tokens): Promise<TaskLookupAnswer[]> => {
      calls.push(tokens);
      return tokens.map((token) => (token === OUTSIDE || token === 'mvout5id'
        ? { token, task: { id: OUTSIDE, title: 'Outside the list', project: 'Ops' } }
        : { token }));
    });
    const text = `See ${OUTSIDE}, mvout5id, ${GHOST} and <task-ref id="${GHOST}" label="Gone task"/> because words never ask`;
    // Before the list loads: nothing is asked (the list will settle most ids).
    renderMarkdownWithRefs(text);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([]);

    syncTasks([{ id: 'other-1234567', title: 'Other' }]);
    const v0 = getEntityLabelsVersion();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sort()).toEqual([GHOST, OUTSIDE, 'mvout5id'].sort());
    expect(getEntityLabelsVersion()).toBeGreaterThan(v0);

    const html = renderMarkdownWithRefs(`${text} again`);
    expect(pills(html, OUTSIDE)).toHaveLength(2);
    expect(pills(html, OUTSIDE)[0]).toContain('>Outside the list</a>');
    // The task-ref whose id names no task is plain text, never a dead pill.
    expect(pills(html, GHOST)).toHaveLength(0);
    expect(html).toContain('Gone task');
    expect(isTaskTokenMissing(GHOST)).toBe(true);

    // Rendered again: nothing new to ask.
    renderMarkdownWithRefs(`${text} once more`);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
  });

  it('a page with no task list still looks up, after a short wait', async () => {
    const calls: string[][] = [];
    setTaskLabelFetcher(async (tokens) => { calls.push(tokens); return []; });
    expect(resolveTaskToken(OUTSIDE)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls).toEqual([[OUTSIDE]]);
  });

  it('a failed lookup leaves the id undecided and is asked again only after a pause', async () => {
    let n = 0;
    setTaskLabelFetcher(async () => { n += 1; throw new Error('offline'); });
    syncTasks([{ id: 'other-1234567', title: 'Other' }]);
    resolveTaskToken(OUTSIDE);
    await vi.advanceTimersByTimeAsync(100);
    expect(n).toBe(1);
    expect(isTaskTokenMissing(OUTSIDE)).toBe(false);
    // Every render while streaming re-reads it: no request storm.
    for (let i = 0; i < 5; i++) { resolveTaskToken(OUTSIDE); await vi.advanceTimersByTimeAsync(100); }
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(31_000);
    resolveTaskToken(OUTSIDE);
    await vi.advanceTimersByTimeAsync(100);
    expect(n).toBe(2);
  });

  it('a batch where nothing names a task re-renders nothing, unless a task-ref pill waited on it', async () => {
    setTaskLabelFetcher(async (tokens) => tokens.map((token) => ({ token })));
    syncTasks([{ id: 'other-1234567', title: 'Other' }]);
    // git log output: hashes that only look like ids.
    renderMarkdownWithRefs('23000e08f ed22cd96e 0ec7ea3d8');
    const v0 = getEntityLabelsVersion();
    await vi.advanceTimersByTimeAsync(100);
    expect(getEntityLabelsVersion()).toBe(v0);
    renderMarkdownWithRefs('<task-ref id="mvgone12-0000" label="Gone"/>');
    await vi.advanceTimersByTimeAsync(100);
    expect(getEntityLabelsVersion()).toBeGreaterThan(v0);
  });

  it('a prefix the partial list settles is confirmed once; the server knowing two tasks unlinks it', async () => {
    const calls: string[][] = [];
    setTaskLabelFetcher(async (tokens) => { calls.push(tokens); return tokens.map((token) => ({ token })); });
    syncTasks([{ id: 'mvtwin12-0001', title: 'Loaded twin' }]);
    expect(resolveTaskToken('mvtwin12')?.id).toBe('mvtwin12-0001');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([['mvtwin12']]);
    // The other twin is completed long ago and outside the list: no pill, never the wrong one.
    expect(resolveTaskToken('mvtwin12')).toBeUndefined();
    expect(renderMarkdownWithRefs('see mvtwin12 now')).not.toContain('<a ');
  });

  it('a confirmed prefix keeps its pill and is not asked again', async () => {
    const calls: string[][] = [];
    setTaskLabelFetcher(async (tokens) => { calls.push(tokens); return tokens.map((token) => ({ token, task: { id: 'mvsolo12-0001', title: 'Solo' } })); });
    syncTasks([{ id: 'mvsolo12-0001', title: 'Solo' }]);
    resolveTaskToken('mvsolo12');
    await vi.advanceTimersByTimeAsync(100);
    resolveTaskToken('mvsolo12');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([['mvsolo12']]);
    expect(resolveTaskToken('mvsolo12')?.id).toBe('mvsolo12-0001');
  });

  it('a server prefix match that is not a segment boundary is not taken', async () => {
    setTaskLabelFetcher(async (tokens) => tokens.map((token) => ({ token, task: { id: `${token}9-0001`, title: 'Wrong' } })));
    syncTasks([{ id: 'other-1234567', title: 'Other' }]);
    resolveTaskToken('ab12cd34');
    await vi.advanceTimersByTimeAsync(100);
    expect(resolveTaskToken('ab12cd34')).toBeUndefined();
    expect(isTaskTokenMissing('ab12cd34')).toBe(true);
  });

  it('a task created later settles a prefix rendered before it existed', () => {
    syncTasks([{ id: 'other-1234567', title: 'Other' }]);
    expect(resolveTaskToken('mvnew123')).toBeUndefined();
    const v0 = getEntityLabelsVersion();
    syncTasks([{ id: 'other-1234567', title: 'Other' }, { id: 'mvnew123-abcd', title: 'New one' }]);
    expect(getEntityLabelsVersion()).toBeGreaterThan(v0);
    expect(resolveTaskToken('mvnew123')?.id).toBe('mvnew123-abcd');
  });
});
