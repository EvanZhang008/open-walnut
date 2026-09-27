/**
 * How a question-meta write's response is adopted (web/src/hooks/useSessionThreadMeta.ts).
 *
 * Two races the old wholesale adoption lost:
 *  (a) the drawer's lazy naming PATCHes run beside the actions' write chain, so a
 *      response written BEFORE a Done can arrive after it and put the question
 *      back to open until the next GET;
 *  (b) a response for the previous session, arriving after the panel switched
 *      session in place, was adopted into the new one.
 * The merge is pure and pinned directly; the session guard runs through a real
 * React mount (linkedom document, react from web/node_modules like the other
 * hook tiers).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement, act } from '../../web/node_modules/react/index.js';
import { createRoot } from '../../web/node_modules/react-dom/client.js';
import { mergeConfirmedMeta, useSessionThreadMeta } from '../../web/src/hooks/useSessionThreadMeta';
import type { ThreadMetaStore } from '../../web/src/components/sessions/thread-ui-contract';
import type { SessionThreadMeta } from '../../web/src/types/session';

const T1 = '2026-09-27T10:00:00.000Z';
const T2 = '2026-09-27T10:00:05.000Z';
const T3 = '2026-09-27T10:00:09.000Z';
const entry = (headId: string, status: SessionThreadMeta['status'], updatedAt: string, extra: Partial<SessionThreadMeta> = {}): SessionThreadMeta =>
  ({ headId, status, updatedAt, ...extra }) as SessionThreadMeta;

describe('mergeConfirmedMeta: per entry, newer updatedAt wins', () => {
  it('a stale response (written before a Done) never reverts the Done', () => {
    const local = [entry('h1', 'resolved', T2)];
    const stale = [entry('h1', 'open', T1, { title: 'Cache order' })];
    expect(mergeConfirmedMeta(local, stale)).toEqual([entry('h1', 'resolved', T2)]);
  });

  it('a newer response entry wins; a tie goes to the response', () => {
    const local = [entry('h1', 'open', T1), entry('h2', 'open', T2)];
    const incoming = [entry('h1', 'resolved', T2), entry('h2', 'resolved', T2)];
    expect(mergeConfirmedMeta(local, incoming)).toEqual(incoming);
  });

  it('an entry the response lacks stays only when it is newer than the whole response', () => {
    const local = [entry('kept', 'open', T3), entry('pruned', 'open', T1)];
    const incoming = [entry('h1', 'open', T2)];
    expect(mergeConfirmedMeta(local, incoming).map((m) => m.headId)).toEqual(['h1', 'kept']);
  });
});

describe('useSessionThreadMeta settles per entry and per session', () => {
  let doc: Document;
  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>');
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = dom.window;
    g.document = dom.document;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    doc = dom.document as unknown as Document;
  });

  function mount(initial: { sessionId: string; meta: SessionThreadMeta[] }) {
    const box: { store: ThreadMetaStore | null } = { store: null };
    function Probe(p: { sessionId: string; meta: SessionThreadMeta[] }) {
      box.store = useSessionThreadMeta(p.sessionId, p.meta);
      return null;
    }
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const root = createRoot(host as unknown as HTMLElement);
    const render = (p: { sessionId: string; meta: SessionThreadMeta[] }) => act(() => { root.render(createElement(Probe, p)); });
    return { box, render, unmount: () => act(() => { root.unmount(); }) };
  }

  it('(a) a lazy-naming response that lands after the Done keeps the Done', async () => {
    const m = mount({ sessionId: 's1', meta: [entry('h1', 'open', T1)] });
    await m.render({ sessionId: 's1', meta: [entry('h1', 'open', T1)] });
    let naming!: ReturnType<ThreadMetaStore['stage']>;
    let done!: ReturnType<ThreadMetaStore['stage']>;
    await act(() => {
      naming = m.box.store!.stage([{ headId: 'h1', titleState: 'pending' }]);
      done = m.box.store!.stage([{ headId: 'h1', status: 'resolved' }]);
    });
    // The Done's response first, then the naming one the server wrote before it.
    await act(() => { done.confirm({ threadMeta: [entry('h1', 'resolved', T3, { titleState: 'pending' })] }); });
    await act(() => { naming.confirm({ threadMeta: [entry('h1', 'open', T2, { titleState: 'pending' })] }); });
    expect(m.box.store!.index.get('h1')?.status).toBe('resolved');
    await m.unmount();
  });

  it('(b) a response for the previous session is never adopted into the new one', async () => {
    const m = mount({ sessionId: 's1', meta: [entry('a1', 'open', T1)] });
    await m.render({ sessionId: 's1', meta: [entry('a1', 'open', T1)] });
    let old!: ReturnType<ThreadMetaStore['stage']>;
    await act(() => { old = m.box.store!.stage([{ headId: 'a1', status: 'resolved' }]); });
    // The panel switches session in place while that write is in flight.
    await m.render({ sessionId: 's2', meta: [entry('b1', 'open', T1)] });
    await act(() => { old.confirm({ threadMeta: [entry('a1', 'resolved', T2)] }); });
    expect(m.box.store!.list.map((e) => e.headId)).toEqual(['b1']);
    // And the new session's own writes still settle.
    let mine!: ReturnType<ThreadMetaStore['stage']>;
    await act(() => { mine = m.box.store!.stage([{ headId: 'b1', status: 'resolved' }]); });
    await act(() => { mine.confirm({ threadMeta: [entry('b1', 'resolved', T3)] }); });
    expect(m.box.store!.index.get('b1')?.status).toBe('resolved');
    await m.unmount();
  });
});
