/**
 * Pure helpers of the task Board pane (web/src/components/board/board-model.ts)
 * and the adopt picker's candidate rule (web/src/components/tasks/adopt-candidates.ts).
 * The frame runtime itself is proven in a real browser:
 * tests/e2e/browser/task-board.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  BOARD_FRAME_CSP, advanceSeen, boardFileSource, boardHostChoices, boardPathSource, boardReferenceSources, boardChoiceFileSource, boardMentionTokens, boardWriterLabel, buildFrameRefs, frameRefsEqual, mentionFrameRefs, mergeBoardMessage,
  newBoardNonce, parseSeen, safeExternalHref, threadAuthorIds, wrapBoardHtml, type BoardMessage,
} from '../../web/src/components/board/board-model';
import { adoptCandidates, adoptExclusions } from '../../web/src/components/tasks/adopt-candidates';
import { AUTOMATION_SILENCE_JS } from '../../web/src/utils/automation-silence';
import { boardSummaryRange, boardSummaryTexts } from '../../src/lib/board-summary-text';
import type { BoardHtmlSource } from '../../src/core/boards/board-html-source';

const JS = 'window.__probe = 1;';
const CSS = '.wn-task{color:red}';
// The silencer runs first: a board's scripts never reach a test machine's speakers.
const block = `${BOARD_FRAME_CSP}<style id="wn-board-runtime-css">${CSS}</style><script>${AUTOMATION_SILENCE_JS}${JS}</script>`;

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

  it('puts the runtime before comments or quoted attributes imitating a head', () => {
    for (const html of ['<!-- <head> --><p>x</p>', '<p title="<head>">x</p>', '<!-- <header> --><html><head></head><body>x</body></html>', '<!doctype html PUBLIC "x > <head>"><p>x</p>']) {
      const out = wrapBoardHtml(html, JS, CSS);
      expect(out).toContain(html);
      expect(out.indexOf(BOARD_FRAME_CSP)).toBeLessThan(out.indexOf(html));
    }
    const quoted = wrapBoardHtml('<html title="x > <head>"><head><title>T</title></head><body>x</body></html>', JS, CSS);
    expect(quoted).toContain('<html title="x > <head>"><head>' + block);
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

describe('the stored text and source span of a folded Board summary', () => {
  it.each([
    ['summary="See /tmp/report.html"', 'See /tmp/report.html'],
    ["SUMMARY='See &#47;tmp&#47;report.html'", 'See /tmp/report.html'],
    ['summary=/tmp/report.html', '/tmp/report.html'],
    ['summary="a &quot;quote&quot; &amp; b"', 'a "quote" & b'],
    ['summary="first" summary="second"', 'first'],
    ['summary="a\r\nb"', 'a\nb'],
  ])('reads %s with the original provenance span', (attributes, expected) => {
    const html = `<p>Before</p><walnut-choice id="output" ${attributes}></walnut-choice>`;
    const [summary] = boardSummaryTexts(html);
    expect(summary?.text).toBe(expected);
    expect(html.slice(summary!.start, summary!.end)).toMatch(/^(?:"[\s\S]*"|'[\s\S]*'|\/tmp\/report\.html)$/);
    const html_sources: BoardHtmlSource[] = [
      { start: 0, end: summary!.start, by: 'human' },
      { start: summary!.start, end: summary!.end, by: 'task:writer', sessionId: 'written-there' },
      { start: summary!.end, end: html.length, by: 'human' },
    ];
    const source = { html, updated_by: 'task:lead', updated_session_id: 'written-here', html_sources };
    expect(boardReferenceSources('lead', source, summary!.start, summary!.end))
      .toEqual([{ taskId: 'writer', sessionId: 'written-there' }]);
  });

  it.each(['See /tmp/report.html', 'See &#47;tmp&#47;report.html', 'See &amp; &#47;tmp&#47;report.html'])('only the path writer counts in %s', (text) => {
    const html = `<walnut-choice summary="${text}"></walnut-choice>`;
    const summary = boardSummaryTexts(html)[0]!;
    const offset = summary.text.indexOf('/tmp/report.html');
    const range = boardSummaryRange(summary, offset, offset + '/tmp/report.html'.length)!;
    const html_sources: BoardHtmlSource[] = [
      { start: 0, end: range.start, by: 'human' },
      { start: range.start, end: range.end, by: 'task:writer', sessionId: 'written-there' },
      { start: range.end, end: html.length, by: 'human' },
    ];
    expect(boardReferenceSources('lead', { html, updated_by: 'human', html_sources }, range.start, range.end))
      .toEqual([{ taskId: 'writer', sessionId: 'written-there' }]);
    expect(html.slice(range.start, range.end)).toMatch(/^(?:\/tmp\/report\.html|&#47;tmp&#47;report\.html)$/);
  });

  it('maps line endings, named multi-codepoint entities and supplementary characters without losing offsets', () => {
    const summary = boardSummaryTexts('<walnut-choice summary="a\r\n&NotEqualTilde;&#x1f600; /tmp/a.txt"></walnut-choice>')[0]!;
    const start = summary.text.indexOf('/tmp/a.txt');
    const range = boardSummaryRange(summary, start, start + '/tmp/a.txt'.length)!;
    expect(summary.raw.slice(range.start - summary.textStart, range.end - summary.textStart)).toBe('/tmp/a.txt');
    expect(boardSummaryRange(summary, summary.text.length, summary.text.length + 1)).toBeNull();
  });

  it('ignores markup inside scripts, comments, templates and text-only elements', () => {
    const fake = '<walnut-choice summary="/tmp/fake.txt"></walnut-choice>';
    for (const hidden of [`<!-- ${fake} -->`, `<script>const x='${fake}';</script>`, `<template>${fake}</template>`, `<textarea>${fake}</textarea>`, `<noscript>${fake}</noscript>`]) {
      expect(boardSummaryTexts(`${hidden}<walnut-choice summary="/tmp/real.txt"></walnut-choice>`).map((s) => s.text)).toEqual(['/tmp/real.txt']);
    }
  });

  it('keeps long paths and escaped Unicode whole without taking an attribute from another tag', () => {
    const text = `/tmp/${'directory/'.repeat(1000)}report.html`;
    expect(boardSummaryTexts(`<p summary="wrong"></p><walnut-choice summary="${text}"></walnut-choice>`)[0]?.text).toBe(text);
    expect(boardSummaryTexts('<walnut-choice summary="&#x67e5;&#x770b; /tmp/report.html"></walnut-choice>')[0]?.text)
      .toBe(`${String.fromCodePoint(0x67e5, 0x770b)} /tmp/report.html`);
    expect(boardSummaryTexts('<walnut-choice summary></walnut-choice>')).toEqual([]);
  });
});

describe('task mentions in the Board text and messages', () => {
  const msg = (text: string): BoardMessage => ({ id: 'm1', author: 'task:lead', text, ts: '2026-10-31T00:00:00Z' } as BoardMessage);

  it('collects tokens from text and messages, never from tag attributes', () => {
    const tokens = boardMentionTokens(
      '<p class="mvclass12">Worker mvu0ubnq-a02d is on it</p><walnut-task id="mvchip99-0001"></walnut-task>',
      { t1: [msg('see mvkghc5v and <task-ref id="mvref123-00aa"/>')] },
      { c1: { option: '', at: '', text: 'pick mvchoic3' } },
    );
    expect(tokens.sort()).toEqual(['mvchoic3', 'mvkghc5v', 'mvref123-00aa', 'mvu0ubnq-a02d'].sort());
  });

  it('registers task references in a stored folded summary, but not ordinary attributes', () => {
    expect(boardMentionTokens('<p title="mvhidden-0001"></p><walnut-choice summary="See mvsummary-0001"></walnut-choice>', {}))
      .toEqual(['mvsummary-0001']);
  });

  it('keys each resolved token as written, the store row first, never replacing a payload ref', () => {
    const store = new Map([['mvkghc5v-278c', { id: 'mvkghc5v-278c', title: 'Live', phase: 'IN_PROGRESS', status: 'in_progress' }]]);
    const resolve = (t: string) => (t === 'mvkghc5v' ? { id: 'mvkghc5v-278c', label: { title: 'Label' } }
      : t === 'mvfetch1-0001' ? { id: 'mvfetch1-0001', label: { title: 'Fetched' } } : undefined);
    const base = { 'mvfetch1-0001': { id: 'mvfetch1-0001', title: 'Payload', phase: 'TODO', status: 'todo' } };
    const refs = mentionFrameRefs(base, ['mvkghc5v', 'mvfetch1-0001', 'mvghost1'], resolve, store);
    expect(refs.mvkghc5v).toEqual({ id: 'mvkghc5v-278c', title: 'Live', phase: 'IN_PROGRESS', status: 'in_progress' });
    expect(refs['mvfetch1-0001'].title).toBe('Payload');
    expect(refs.mvghost1).toBeUndefined();
    // Nothing resolved: the same object, so the frame is not re-posted.
    expect(mentionFrameRefs(base, ['mvghost1'], resolve, store)).toBe(base);
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

describe('boardFileSource (whose machine a clicked path opens on)', () => {
  const m = (id: string, author: BoardMessage['author'], sessionId?: string): BoardMessage =>
    ({ id, ts: 't', author, text: id, ...(sessionId ? { sessionId } : {}) });
  const threads = {
    t1: [m('m1', 'task:worker1', 'sid-remote'), m('m2', 'user'), m('m3', 'agent'), m('m4', 'task:'), m('m6', 'task:old1')],
    t2: [m('m5', 'task:lead', 'sid-lead')],
  };
  const owner = { taskId: 'owner' };
  // A person's text: saved on the primary, so it never borrows a session.
  const primary = { taskId: 'owner', primary: true };

  it('the stored session of that exact message comes first, with its task author', () => {
    expect(boardFileSource('owner', threads, 't1', 'm1')).toEqual({ taskId: 'worker1', sessionId: 'sid-remote' });
    expect(boardFileSource('owner', threads, 't2', 'm5')).toEqual({ taskId: 'lead', sessionId: 'sid-lead' });
  });

  it('a message from before the session field keeps its task author but names no machine', () => {
    // The task's session now may run on another machine than the one that wrote the message.
    expect(boardFileSource('owner', threads, 't1', 'm6')).toEqual({ taskId: 'old1', sourceFailure: true });
  });

  it('a Walnut message with a stored session opens by that session, for the owner task', () => {
    expect(boardFileSource('owner', { t: [m('a', 'agent', 'sid-agent')] }, 't', 'a')).toEqual({ taskId: 'owner', sessionId: 'sid-agent' });
  });

  it('a link outside any message is the page writer\'s: its stored session, else its task, else the owner', () => {
    const remotePage = { updated_by: 'task:worker1', updated_session_id: 'sid-remote' };
    expect(boardFileSource('owner', threads, '', '', remotePage)).toEqual({ taskId: 'worker1', sessionId: 'sid-remote' });
    expect(boardFileSource('owner', threads, undefined, undefined, remotePage)).toEqual({ taskId: 'worker1', sessionId: 'sid-remote' });
    // An older version: no session stored, so its task author names no machine.
    expect(boardFileSource('owner', threads, '', '', { updated_by: 'task:worker1' })).toEqual({ taskId: 'worker1', sourceFailure: true });
    // A person's version was saved on the primary: it opens there, never as the owner's agent.
    expect(boardFileSource('owner', threads, '', '', { updated_by: 'human' })).toEqual(primary);
    expect(boardFileSource('owner', threads, '', '', { updated_by: 'human', updated_session_id: 'sid-pane' })).toEqual(primary);
    expect(boardFileSource('owner', threads, '', '', null)).toEqual(owner);
    // A bad stored session or writer id never reaches a lookup.
    expect(boardFileSource('owner', threads, '', '', { updated_by: 'task:a/b', updated_session_id: '../x' })).toEqual({ ...owner, sourceFailure: true });
  });

  it('a path modified across different writers reads no guessed machine', () => {
    const html = '/repo/changed.ts';
    const page = { html, updated_by: 'task:worker1', updated_session_id: 'sid-remote', html_sources: [
      { start: 0, end: 6, by: 'human' as const },
      { start: 6, end: html.length, by: 'task:worker1' as const, sessionId: 'sid-remote' },
    ] };
    expect(boardFileSource('owner', threads, '', '', page, 0, html.length)).toEqual({ taskId: 'owner', sourceFailure: true });
    expect(boardFileSource('owner', threads, 't1', 'm1', page, 0, html.length)).toEqual({ taskId: 'worker1', sessionId: 'sid-remote' });
  });

  it('a stored message never takes the page writer\'s session, and an unknown row never falls back to the page', () => {
    const remotePage = { updated_by: 'task:worker1', updated_session_id: 'sid-remote' };
    expect(boardFileSource('owner', threads, 't1', 'm2', remotePage)).toEqual(primary);
    expect(boardFileSource('owner', threads, 't1', 'm6', remotePage)).toEqual({ taskId: 'old1', sourceFailure: true });
    expect(boardFileSource('owner', threads, 't1', '', remotePage)).toEqual(owner);
    expect(boardFileSource('owner', threads, 't2', 'm5', remotePage)).toEqual({ taskId: 'lead', sessionId: 'sid-lead' });
    expect(boardFileSource('owner', threads, 't1', 'gone', remotePage)).toEqual(owner);
    expect(boardFileSource('owner', threads, 'nosuch', 'm1', remotePage)).toEqual(owner);
    expect(boardFileSource('owner', threads, { t: 1 }, 'm1', remotePage)).toEqual(owner);
    expect(boardFileSource('owner', threads, 't1', '', remotePage)).toEqual(owner);
  });

  it('the user is the primary; Walnut with no session, an empty task author and no page are the owner', () => {
    expect(boardFileSource('owner', threads, '', '')).toEqual(owner);
    expect(boardFileSource('owner', threads, undefined, undefined)).toEqual(owner);
    expect(boardFileSource('owner', threads, 't1', 'm2')).toEqual(primary);
    // A user message with a session field still opens on the primary, never by that session.
    expect(boardFileSource('owner', { t: [m('u', 'user', 'sid-pane')] }, 't', 'u')).toEqual(primary);
    expect(boardFileSource('owner', threads, 't1', 'm3')).toEqual({ ...owner, sourceFailure: true });
    expect(boardFileSource('owner', threads, 't1', 'm4')).toEqual({ ...owner, sourceFailure: true });
    expect(boardFileSource('owner', null, 't1', 'm1')).toEqual(owner);
  });

  it('a reader cannot name a task, a session or a host: only what the record holds counts', () => {
    // The message id must be in the thread the frame names, not any thread.
    expect(boardFileSource('owner', threads, 't2', 'm1')).toEqual(owner);
    // A task id, a session id or a host passed as the message or thread is just an unknown id.
    expect(boardFileSource('owner', threads, 't1', 'task:evil')).toEqual(owner);
    expect(boardFileSource('owner', threads, 't1', 'sid-remote')).toEqual(owner);
    expect(boardFileSource('owner', threads, 'fixture-remote', 'm1')).toEqual(owner);
    expect(boardFileSource('owner', threads, { host: 'x', sessionId: 'sid-remote' }, 'm1')).toEqual(owner);
    expect(boardFileSource('owner', threads, 't1', ['m1'])).toEqual(owner);
    // Inherited keys are not threads.
    expect(boardFileSource('owner', threads, '__proto__', 'm1')).toEqual(owner);
    expect(boardFileSource('owner', threads, 'constructor', 'm1')).toEqual(owner);
    // A stored id that is not an id shape never reaches a lookup.
    expect(boardFileSource('owner', { t: [m('x', 'task:../a' as BoardMessage['author'])] }, 't', 'x')).toEqual({ ...owner, sourceFailure: true });
    expect(boardFileSource('owner', { t: [m('x', 'task:w1', '../s')] }, 't', 'x')).toEqual({ taskId: 'w1', sourceFailure: true });
    expect(boardFileSource('owner', { t: [m('x', 'task:w1', 'external')] }, 't', 'x')).toEqual({ taskId: 'w1', sourceFailure: true });
  });

  it('a deleted message falls back to the owner, never to another author', () => {
    const after = { t1: threads.t1.filter((x) => x.id !== 'm1'), t2: threads.t2 };
    expect(boardFileSource('owner', after, 't1', 'm1')).toEqual(owner);
  });

  describe('a link offset picks the writer of the text it sits in', () => {
    // The lead wrote the page; a worker later added a second line naming the same path.
    const html = '<p>src/a.ts</p><p>src/a.ts</p>';
    const page = {
      html,
      updated_by: 'task:worker1',
      updated_session_id: 'sid-worker',
      html_sources: [
        { start: 0, end: 15, by: 'task:lead' as const, sessionId: 'sid-lead' },
        { start: 15, end: html.length, by: 'task:worker1' as const, sessionId: 'sid-worker' },
      ],
    };
    const first = html.indexOf('src/a.ts');
    const second = html.indexOf('src/a.ts', first + 1);

    it('two same-name paths open for their own writers, not the last one', () => {
      expect(boardFileSource('owner', threads, '', '', page, first)).toEqual({ taskId: 'lead', sessionId: 'sid-lead' });
      expect(boardFileSource('owner', threads, '', '', page, second)).toEqual({ taskId: 'worker1', sessionId: 'sid-worker' });
      // A span edge belongs to the span it starts.
      expect(boardFileSource('owner', threads, '', '', page, 15)).toEqual({ taskId: 'worker1', sessionId: 'sid-worker' });
      expect(boardFileSource('owner', threads, '', '', page, 14)).toEqual({ taskId: 'lead', sessionId: 'sid-lead' });
    });

    it('no offset keeps the page writer; a person\'s span is the primary, a task span with no session names no machine', () => {
      expect(boardFileSource('owner', threads, '', '', page)).toEqual({ taskId: 'worker1', sessionId: 'sid-worker' });
      const mixed = { ...page, html_sources: [
        { start: 0, end: 15, by: 'human' as const },
        { start: 15, end: html.length, by: 'task:worker1' as const },
      ] };
      expect(boardFileSource('owner', threads, '', '', mixed, first)).toEqual(primary);
      expect(boardFileSource('owner', threads, '', '', mixed, second)).toEqual({ taskId: 'worker1', sourceFailure: true });
    });

    it('an offset that is not inside the page is the owner, never the page writer', () => {
      for (const off of [-1, html.length, html.length + 5, 1.5, NaN, '3', null, { at: 3 }, [3]]) {
        expect(boardFileSource('owner', threads, '', '', page, off), String(off)).toEqual(owner);
      }
      // A page with no html to measure the offset against.
      expect(boardFileSource('owner', threads, '', '', { updated_by: 'task:worker1', html_sources: page.html_sources }, first)).toEqual(owner);
    });

    it('spans that are not an exact cover of the page are not trusted: the owner', () => {
      const bad = [
        [{ start: 0, end: 10, by: 'task:lead' }],
        [{ start: 0, end: 15, by: 'task:lead' }, { start: 16, end: html.length, by: 'task:w' }],
        [{ start: 0, end: html.length, by: 'task:../x' }],
        [{ start: 0, end: html.length, by: 'task:lead', sessionId: '../s' }],
        'nope',
        null,
      ];
      for (const html_sources of bad) {
        expect(boardFileSource('owner', threads, '', '', { ...page, html_sources } as never, first), JSON.stringify(html_sources)).toEqual(owner);
      }
    });

    it('an older server sends no spans: the page writer, as before', () => {
      const { html_sources: _drop, ...older } = page;
      expect(boardFileSource('owner', threads, '', '', older, first)).toEqual({ taskId: 'worker1', sessionId: 'sid-worker' });
    });

    it('offsets are UTF-16 units of the page html', () => {
      // CJK text and a surrogate pair before each path.
      const cjk = '<p>\u4e2d\u6587 src/a.ts</p><p>\ud83d\ude00 src/a.ts</p>';
      const cut = cjk.indexOf('<p>', 1);
      const cjkPage = { html: cjk, updated_by: 'task:worker1', html_sources: [
        { start: 0, end: cut, by: 'task:lead' as const },
        { start: cut, end: cjk.length, by: 'task:worker1' as const, sessionId: 'sid-worker' },
      ] };
      expect(boardFileSource('owner', threads, '', '', cjkPage, cjk.indexOf('src/a.ts'))).toEqual({ taskId: 'lead', sourceFailure: true });
      expect(boardFileSource('owner', threads, '', '', cjkPage, cjk.lastIndexOf('src/a.ts'))).toEqual({ taskId: 'worker1', sessionId: 'sid-worker' });
    });

    it('a thread message keeps its own writer whatever the offset says', () => {
      expect(boardFileSource('owner', threads, 't2', 'm5', page, first)).toEqual({ taskId: 'lead', sessionId: 'sid-lead' });
      expect(boardFileSource('owner', threads, 't1', 'm2', page, second)).toEqual(primary);
      expect(boardFileSource('owner', threads, 't1', 'gone', page, second)).toEqual(owner);
      // A forged half row with an offset is still the owner.
      expect(boardFileSource('owner', threads, 't1', '', page, second)).toEqual(owner);
    });
  });
});

describe('choice text path sources', () => {
  it('an untracked agent without a writing session never borrows the board owner\'s machine', () => {
    expect(boardChoiceFileSource('owner', { option: '', at: 't', text: '/repo/a.ts', text_by: 'agent' }))
      .toEqual({ taskId: 'owner', sourceFailure: true });
  });

  it('a person\'s answer names the primary, and an agent\'s answer keeps its stored writing session', () => {
    expect(boardChoiceFileSource('owner', { option: '', at: 't', text: '/repo/a.ts' })).toEqual({ taskId: 'owner', primary: true });
    expect(boardChoiceFileSource('owner', { option: '', at: 't', text: '/repo/a.ts', text_by: 'task:writer', text_session_id: 'sid-writer' }))
      .toEqual({ taskId: 'writer', sessionId: 'sid-writer' });
  });
});

describe('page references use stored writers, not a frame offset', () => {
  const html = '/repo/a.ts /repo/a.ts';
  const page = { html, updated_by: 'agent', html_sources: [
    { start: 0, end: 11, by: 'human' as const },
    { start: 11, end: html.length, by: 'agent' as const, sessionId: 'remote-session' },
  ] };
  const references = new Map([
    [0, { path: '/repo/a.ts', end: 10 }],
    [11, { path: '/repo/a.ts', end: html.length }],
  ]);
  const unknown = { taskId: 'owner', sourceFailure: true };

  it('rejects identical paths from different writers instead of trusting a copied offset', () => {
    expect(boardPathSource('owner', references, '/repo/a.ts', page)).toEqual(unknown);
  });

  it('opens repeated paths when all stored references have one writer', () => {
    expect(boardPathSource('owner', references, '/repo/a.ts', { ...page, html_sources: [
      { start: 0, end: html.length, by: 'agent', sessionId: 'remote-session' },
    ] })).toEqual({ taskId: 'owner', sessionId: 'remote-session' });
  });

  it('rejects a path absent from the stored page and malformed spans', () => {
    expect(boardPathSource('owner', references, '/repo/forged.ts', page)).toEqual(unknown);
    expect(boardPathSource('owner', references, '/repo/a.ts', { ...page, html_sources: [] })).toEqual(unknown);
  });

  it('rejects a single reference assembled by more than one writer', () => {
    expect(boardPathSource('owner', new Map([[0, { path: '/repo/a.ts', end: 12 }]]), '/repo/a.ts', page)).toEqual(unknown);
  });

  it('keeps an older page with no spans on its recorded writer', () => {
    expect(boardPathSource('owner', references, '/repo/a.ts', { html, updated_by: 'agent' })).toEqual({ taskId: 'owner', sourceFailure: true });
    expect(boardPathSource('owner', references, '/repo/a.ts', { html, updated_by: 'human' })).toEqual({ taskId: 'owner', primary: true });
  });

  it('a person\'s copy opens on the primary and never merges with the owner\'s agent copy', () => {
    // Both name the owner task and no session: only `primary` tells them apart.
    const ownerAgent = { html, updated_by: 'agent', html_sources: [
      { start: 0, end: 11, by: 'human' as const },
      { start: 11, end: html.length, by: 'agent' as const },
    ] };
    expect(boardPathSource('owner', references, '/repo/a.ts', ownerAgent)).toEqual(unknown);
    expect(boardPathSource('owner', new Map([[0, { path: '/repo/a.ts', end: 10 }]]), '/repo/a.ts', ownerAgent))
      .toEqual({ taskId: 'owner', primary: true });
    expect(boardPathSource('owner', new Map([[11, { path: '/repo/a.ts', end: html.length }]]), '/repo/a.ts', ownerAgent))
      .toEqual({ taskId: 'owner', sourceFailure: true });
    // All of it the person's: the primary, whatever session the page stored.
    expect(boardPathSource('owner', references, '/repo/a.ts', { html, updated_by: 'human', updated_session_id: 'sid-pane', html_sources: [
      { start: 0, end: html.length, by: 'human' },
    ] })).toEqual({ taskId: 'owner', primary: true });
  });
});

describe('boardReferenceSources: every writer of one stored reference', () => {
  // A person wrote the path, a remote session retyped one letter of it, the person's text follows.
  const path = '/repo/notes.txt';
  const html = `<p>${path}</p>`;
  const start = html.indexOf(path);
  const end = start + path.length;
  const letter = start + '/repo/n'.length;
  const aba = { html, updated_by: 'human', html_sources: [
    { start: 0, end: letter, by: 'human' as const },
    { start: letter, end: letter + 1, by: 'agent' as const, sessionId: 'remote-session' },
    { start: letter + 1, end: html.length, by: 'human' as const },
  ] };
  const primary = { taskId: 'owner', primary: true };
  const remote = { taskId: 'owner', sessionId: 'remote-session' };

  it('a reference typed by A, then B, then A names A and B once each, in page order', () => {
    expect(boardReferenceSources('owner', aba, start, end)).toEqual([primary, remote]);
    // Saved again with the same spans: the same answer, never a permanent failure.
    expect(boardReferenceSources('owner', JSON.parse(JSON.stringify(aba)), start, end)).toEqual([primary, remote]);
  });

  it('counts only the spans the range covers', () => {
    expect(boardReferenceSources('owner', aba, start, letter)).toEqual([primary]);
    expect(boardReferenceSources('owner', aba, letter, letter + 1)).toEqual([remote]);
    expect(boardReferenceSources('owner', aba, letter + 1, end)).toEqual([primary]);
  });

  it('two sessions of one writer stay two sources; one task in two spans is one', () => {
    const twoSessions = { ...aba, html_sources: [
      { start: 0, end: letter, by: 'task:w1' as const, sessionId: 's1' },
      { start: letter, end: html.length, by: 'task:w1' as const, sessionId: 's2' },
    ] };
    expect(boardReferenceSources('owner', twoSessions, start, end)).toEqual([{ taskId: 'w1', sessionId: 's1' }, { taskId: 'w1', sessionId: 's2' }]);
    const sameTask = { ...aba, html_sources: [
      { start: 0, end: letter, by: 'task:w1' as const, sessionId: 's1' },
      { start: letter, end: letter + 1, by: 'human' as const },
      { start: letter + 1, end: html.length, by: 'task:w1' as const, sessionId: 's1' },
    ] };
    expect(boardReferenceSources('owner', sameTask, start, end)).toEqual([{ taskId: 'w1', sessionId: 's1' }, primary]);
  });

  it('an older task span with no saved session fails the reference, never borrowing the task\'s session now', () => {
    const oldTask = { ...aba, html_sources: [
      { start: 0, end: letter, by: 'human' as const },
      { start: letter, end: html.length, by: 'task:remote-worker' as const },
    ] };
    expect(boardReferenceSources('owner', oldTask, start, end)).toBeNull();
    expect(boardReferenceSources('owner', oldTask, letter, end)).toBeNull();
    expect(boardReferenceSources('owner', { html, updated_by: 'task:remote-worker' }, start, end)).toBeNull();
    expect(boardPathSource('owner', new Map([[start, { path, end }]]), path, { html, updated_by: 'task:remote-worker' }))
      .toEqual({ taskId: 'owner', sourceFailure: true });
    expect(boardChoiceFileSource('owner', { option: '', at: 't', text: path, text_by: 'task:remote-worker' }))
      .toEqual({ taskId: 'remote-worker', sourceFailure: true });
  });

  it('a writer that cannot name a machine fails the whole reference', () => {
    const untracked = { ...aba, html_sources: [
      { start: 0, end: letter, by: 'human' as const },
      { start: letter, end: html.length, by: 'agent' as const },
    ] };
    expect(boardReferenceSources('owner', untracked, start, end)).toBeNull();
    expect(boardReferenceSources('owner', untracked, start, letter)).toEqual([primary]);
  });

  it('a range outside the page, or spans that are not an exact cover, are not trusted', () => {
    for (const [s, e] of [[-1, end], [start, html.length + 1], [end, start], [start, start], [1.5, end], [start, NaN]] as Array<[number, number]>) {
      expect(boardReferenceSources('owner', aba, s, e), `${s}-${e}`).toBeNull();
    }
    for (const html_sources of [[], [{ start: 0, end: 3, by: 'human' }], 'nope', null]) {
      expect(boardReferenceSources('owner', { ...aba, html_sources } as never, start, end), JSON.stringify(html_sources)).toBeNull();
    }
    expect(boardReferenceSources('owner', null, start, end)).toBeNull();
    expect(boardReferenceSources('owner', { updated_by: 'human', html_sources: aba.html_sources }, start, end)).toBeNull();
  });

  it('an older page with no spans is its last writer', () => {
    expect(boardReferenceSources('owner', { html, updated_by: 'task:w1', updated_session_id: 's1' }, start, end)).toEqual([{ taskId: 'w1', sessionId: 's1' }]);
    expect(boardReferenceSources('owner', { html, updated_by: 'human' }, start, end)).toEqual([primary]);
    expect(boardReferenceSources('owner', { html, updated_by: 'agent' }, start, end)).toBeNull();
  });

  it('boardPathSource still names one writer only when every reference has exactly one', () => {
    expect(boardPathSource('owner', new Map([[start, { path, end }]]), path, aba)).toEqual({ taskId: 'owner', sourceFailure: true });
  });
});

describe('boardHostChoices: copies on one machine are one choice', () => {
  it('merges every spelling of this machine and every copy on one remote host', () => {
    expect(boardHostChoices([
      { host: '', label: 'Board page' },
      { host: '__local__', label: 'Reply by You in notes' },
      { host: 'local', label: 'Board page' },
    ])).toEqual([{ host: '', details: ['Board page', 'Reply by You in notes'] }]);
    expect(boardHostChoices([
      { host: 'devbox', label: 'Board page', title: 'Worker one' },
      { host: 'devbox', label: 'Board page', title: 'Worker two' },
      { host: 'devbox', label: 'Board page', title: 'Worker one' },
    ])).toEqual([{ host: 'devbox', details: ['Board page (Worker one)', 'Board page (Worker two)'] }]);
  });

  it('keeps machines apart even when the titles are the same, in first-seen order', () => {
    expect(boardHostChoices([
      { host: 'devbox', label: 'Board page', title: 'Same title' },
      { label: 'Board page', title: 'Same title' },
      { host: 'other', label: 'Answer in source' },
    ])).toEqual([
      { host: 'devbox', details: ['Board page (Same title)'] },
      { host: '', details: ['Board page (Same title)'] },
      { host: 'other', details: ['Answer in source'] },
    ]);
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

  it('finds renamed task titles and projects while keeping stored candidates intact', () => {
    const ask = t('ask', { title: 'Ask Walnut', project: 'Ask Walnut' });
    const ceo = t('ceo', { title: 'Main', org_role: 'main' });
    const vp = t('vp', { title: 'Garden lead', org_role: 'lead', org_name: 'Design' });
    const rows = [t('leader'), ask, ceo, vp];
    for (const [query, id] of [['Quick question', ask.id], ['Ask Walnut', ask.id], ['CEO', ceo.id], ['Main', ceo.id], ['Design VP', vp.id]]) {
      expect(adoptCandidates(rows, 'leader', query).map(t => t.id)).toEqual([id]);
    }
    expect(ask).toMatchObject({ title: 'Ask Walnut', project: 'Ask Walnut' });
    expect(ceo.title).toBe('Main');
  });

  it('a corrupt parent cycle still terminates', () => {
    const loop = [t('a-0001', { parent_task_id: 'b-0001' }), t('b-0001', { parent_task_id: 'a-0001' }), t('c-0001')];
    expect(adoptCandidates(loop, 'a-0001').map((x) => x.id)).toEqual(['c-0001']);
  });
});
