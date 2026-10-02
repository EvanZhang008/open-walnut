/**
 * Pure helpers of the task Board pane (web/src/components/board/board-model.ts)
 * and the adopt picker's candidate rule (web/src/components/tasks/adopt-candidates.ts).
 * The frame runtime itself is proven in a real browser:
 * tests/e2e/browser/task-board.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  BOARD_FRAME_CSP, advanceSeen, boardWriterLabel, buildFrameRefs, frameRefsEqual, mergeBoardMessage,
  newBoardNonce, parseSeen, safeExternalHref, threadAuthorIds, wrapBoardHtml, type BoardMessage,
} from '../../web/src/components/board/board-model';
import { adoptCandidates, adoptExclusions } from '../../web/src/components/tasks/adopt-candidates';

const JS = 'window.__probe = 1;';
const CSS = '.wn-task{color:red}';
const block = `${BOARD_FRAME_CSP}<style id="wn-board-runtime-css">${CSS}</style><script>${JS}</script>`;

describe('wrapBoardHtml', () => {
  it('puts CSP, css and runtime right after an existing <head>', () => {
    const out = wrapBoardHtml('<!doctype html><html><head lang="en"><title>B</title></head><body>x</body></html>', JS, CSS);
    expect(out).toBe(`<!doctype html><html><head lang="en">${block}<title>B</title></head><body>x</body></html>`);
  });

  it('never mistakes <header> for <head>', () => {
    const out = wrapBoardHtml('<html><body><header class="top">T</header></body></html>', JS, CSS);
    expect(out).toBe(`<html><head>${block}</head><body><header class="top">T</header></body></html>`);
  });

  it('adds a head after a doctype when there is no <html> tag', () => {
    expect(wrapBoardHtml('<!DOCTYPE html><p>hi</p>', JS, CSS)).toBe(`<!DOCTYPE html><head>${block}</head><p>hi</p>`);
  });

  it('wraps a bare fragment in a standards-mode document with a base look', () => {
    const out = wrapBoardHtml('<walnut-strip></walnut-strip>', JS, CSS);
    expect(out.startsWith(`<!doctype html><html><head>${block}<style>body{`)).toBe(true);
    expect(out.endsWith('<body><walnut-strip></walnut-strip></body></html>')).toBe(true);
  });

  it('inlines a fresh nonce into the runtime, and two documents never share one', () => {
    const a = wrapBoardHtml('<html><head></head><body></body></html>', "var NONCE = '__WN_BOARD_NONCE__';", CSS);
    const b = wrapBoardHtml('<html><head></head><body></body></html>', "var NONCE = '__WN_BOARD_NONCE__';", CSS);
    const nonceOf = (html: string) => /var NONCE = '([0-9a-f]{32})';/.exec(html)?.[1];
    expect(nonceOf(a)).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    expect(a).not.toContain('__WN_BOARD_NONCE__');
    // A caller may pin it (the pane does, so the message filter and the document agree).
    expect(wrapBoardHtml('<html><head></head></html>', "'__WN_BOARD_NONCE__'", CSS, 'abc')).toContain("'abc'");
    expect(newBoardNonce()).not.toBe(newBoardNonce());
  });

  it('cannot end its own script or style early', () => {
    const out = wrapBoardHtml('<p>x</p>', 'var s = "</script><img>";', 'a::after{content:"</style>"}');
    expect(out).not.toContain('"</script>');
    expect(out).toContain('"<\\/script><img>"');
    expect(out).toContain('"<\\/style>"');
  });

  it('the CSP allows no network: no connect, no remote images, no frames', () => {
    expect(BOARD_FRAME_CSP).toContain("default-src 'none'");
    expect(BOARD_FRAME_CSP).toContain('img-src data: blob:;');
    expect(BOARD_FRAME_CSP).not.toMatch(/https?:/);
  });
});

describe('buildFrameRefs', () => {
  const payload = [
    { ref: 'abcd', id: 'abcd1234', title: 'Old title', phase: 'TODO', status: 'todo' },
    { ref: 'ffff0000', id: 'ffff0000', title: 'Server copy', phase: 'IN_PROGRESS', status: 'in_progress' },
  ];

  it('keys by the id as written and by the full id; the store row wins over the payload', () => {
    const store = new Map([['abcd1234', { id: 'abcd1234', title: 'Live title', phase: 'NEED_ACTION', status: 'in_progress' }]]);
    const refs = buildFrameRefs(payload, store);
    expect(refs.abcd).toEqual({ id: 'abcd1234', title: 'Live title', phase: 'NEED_ACTION', status: 'in_progress' });
    expect(refs.abcd1234).toBe(refs.abcd);
    expect(refs.ffff0000.title).toBe('Server copy');
  });

  it('adds extra ids (the board task, message authors) only when the store knows them', () => {
    const store = new Map([['lead', { id: 'lead', title: 'Leader', phase: 'TODO', status: 'todo' }]]);
    const refs = buildFrameRefs([], store, ['lead', 'ghost']);
    expect(Object.keys(refs)).toEqual(['lead']);
    expect(buildFrameRefs([], null, ['lead'])).toEqual({});
  });

  it('frameRefsEqual compares content, not identity', () => {
    const a = buildFrameRefs(payload, null);
    const b = buildFrameRefs(payload, null);
    expect(a).not.toBe(b);
    expect(frameRefsEqual(a, b)).toBe(true);
    const c = buildFrameRefs([{ ...payload[0], phase: 'COMPLETE' }, payload[1]], null);
    expect(frameRefsEqual(a, c)).toBe(false);
    expect(frameRefsEqual(a, {})).toBe(false);
  });
});

describe('threads', () => {
  const m = (id: string, ts: string, author: BoardMessage['author'] = 'user'): BoardMessage => ({ id, ts, author, text: id });

  it('mergeBoardMessage dedupes by id and keeps ts order', () => {
    const threads = { a: [m('1', '2026-10-01T10:00:00Z'), m('3', '2026-10-01T12:00:00Z')] };
    const next = mergeBoardMessage(threads, 'a', m('2', '2026-10-01T11:00:00Z'));
    expect(next.a.map((x) => x.id)).toEqual(['1', '2', '3']);
    expect(mergeBoardMessage(next, 'a', m('2', '2026-10-01T11:00:00Z'))).toBe(next);
    expect(mergeBoardMessage({}, 'b', m('9', 'x')).b).toHaveLength(1);
  });

  it('threadAuthorIds lists every task that wrote', () => {
    expect(threadAuthorIds({ a: [m('1', 't', 'task:w1'), m('2', 't')], b: [m('3', 't', 'task:w1'), m('4', 't', 'task:lead')] }))
      .toEqual(['w1', 'lead']);
  });
});

describe('bar, seen and links', () => {
  it('names who last wrote the board', () => {
    expect(boardWriterLabel('human', 'lead')).toBe('you');
    expect(boardWriterLabel('task:lead', 'lead')).toBe('leader');
    expect(boardWriterLabel('task:w1', 'lead')).toBe('worker');
  });

  it('parseSeen survives garbage and keeps only string timestamps', () => {
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen('not json')).toEqual({});
    expect(parseSeen('[1,2]')).toEqual({});
    expect(parseSeen('{"a":"2026-10-01T10:00:00Z","b":3}')).toEqual({ a: '2026-10-01T10:00:00Z' });
  });

  it('advanceSeen only moves forward', () => {
    const seen = { a: '2026-10-01T10:00:00Z' };
    expect(advanceSeen(seen, 'a', '2026-10-01T09:00:00Z')).toBeNull();
    expect(advanceSeen(seen, 'a', '2026-10-01T10:00:00Z')).toBeNull();
    expect(advanceSeen(seen, 'a', '2026-10-01T11:00:00Z')).toEqual({ a: '2026-10-01T11:00:00Z' });
    expect(advanceSeen(seen, '', 'x')).toBeNull();
  });

  it('only absolute http(s) links leave the frame', () => {
    expect(safeExternalHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeExternalHref('http://example.com')).toBe('http://example.com/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'file:///etc/passwd', 42, null]) {
      expect(safeExternalHref(bad)).toBeNull();
    }
  });
});

describe('adoptCandidates', () => {
  const t = (id: string, extra: Partial<Task> = {}): Task => ({
    id, title: `Task ${id}`, phase: 'TODO', status: 'todo', project: 'P',
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', ...extra,
  } as Task);

  // root → lead → child → grandchild; lead's parent named by a short prefix.
  const tasks: Task[] = [
    t('root-0001'),
    t('lead-0001', { parent_task_id: 'root' }),
    t('child-0001', { parent_task_id: 'lead-0001' }),
    t('grand-0001', { parent_task_id: 'child' }),
    t('free-0001', { updated_at: '2026-09-03T00:00:00Z' }),
    t('free-0002', { updated_at: '2026-09-05T00:00:00Z', project: 'Other' }),
    t('other-worker', { parent_task_id: 'free-0001', updated_at: '2026-09-04T00:00:00Z' }),
    t('done-0001', { phase: 'COMPLETE', status: 'done', updated_at: '2026-09-09T00:00:00Z' }),
  ];

  it('excludes the leader, its ancestors and its whole team, prefixes included', () => {
    expect([...adoptExclusions(tasks, 'lead-0001')].sort()).toEqual(['child-0001', 'grand-0001', 'lead-0001', 'root-0001']);
  });

  it('lists open tasks only, newest first, workers of other leaders included', () => {
    expect(adoptCandidates(tasks, 'lead-0001').map((x) => x.id)).toEqual(['free-0002', 'other-worker', 'free-0001']);
  });

  it('filters by title, project or id prefix', () => {
    expect(adoptCandidates(tasks, 'lead-0001', 'other').map((x) => x.id)).toEqual(['free-0002', 'other-worker']);
    expect(adoptCandidates(tasks, 'lead-0001', 'FREE-0001').map((x) => x.id)).toEqual(['free-0001']);
    expect(adoptCandidates(tasks, 'lead-0001', 'nothing like this')).toEqual([]);
  });

  it('a corrupt parent cycle still terminates', () => {
    const loop = [t('a-0001', { parent_task_id: 'b-0001' }), t('b-0001', { parent_task_id: 'a-0001' }), t('c-0001')];
    expect(adoptCandidates(loop, 'a-0001').map((x) => x.id)).toEqual(['c-0001']);
  });
});
