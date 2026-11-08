/**
 * A hint asked for one message never rides another (web/src/utils/pending-hints.ts; 2026-11-10
 * review: the doc comments' context was set before the send, a send refused before it took the
 * hint (a paste that could not be spilled) left it waiting, and the next unrelated send, a
 * /compact, carried it). And the context store never holds a send: it is capped and falls back
 * to the comments in the message.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dropPendingHint, hasPendingHint, setPendingHints, takePendingHints } from '../../web/src/utils/pending-hints';
import { HINT_CONTEXT_STORE_TIMEOUT_MS, composeForSend } from '../../web/src/utils/passage-comments';

const SID = 'sess-1';
beforeEach(() => { takePendingHints(SID); });

describe('dropPendingHint', () => {
  it('the reported case: a send that did not go takes its own hint back', () => {
    setPendingHints(SID, { 'object-context': { arg: 'hc-aaaaaaaaaaaaaaaa' } });
    dropPendingHint(SID, 'object-context', 'hc-aaaaaaaaaaaaaaaa');
    expect(hasPendingHint(SID, 'object-context')).toBe(false);
    expect(takePendingHints(SID)).toBeUndefined();
  });

  it('another surface\'s later ask of the same kind, and other kinds, stay', () => {
    setPendingHints(SID, { 'object-context': { arg: 'hc-bbbbbbbbbbbbbbbb' }, rich: {} });
    dropPendingHint(SID, 'object-context', 'hc-aaaaaaaaaaaaaaaa');
    expect(hasPendingHint(SID, 'object-context')).toBe(true);
    dropPendingHint(SID, 'object-context', 'hc-bbbbbbbbbbbbbbbb');
    expect(takePendingHints(SID)).toEqual({ rich: {} });
  });

  it('a hint the send already took is not there to drop: nothing happens', () => {
    setPendingHints(SID, { 'object-context': { arg: 'hc-aaaaaaaaaaaaaaaa' } });
    takePendingHints(SID);
    expect(() => dropPendingHint(SID, 'object-context', 'hc-aaaaaaaaaaaaaaaa')).not.toThrow();
    expect(takePendingHints(SID)).toBeUndefined();
  });
});

describe('composeForSend with a store that does not answer', () => {
  const comment = { id: 'c1', text: 'the passage', comment: 'why this?', doc: { path: '/w/a.md', commentId: 'k1' } } as never;
  it('a refused store puts the comments in the message', async () => {
    const out = await composeForSend([comment], 'typed', async () => { throw new Error('timeout'); });
    expect(out.hints).toBeUndefined();
    expect(out.text).toContain('why this?');
  });
  it('the store is capped at a few seconds', () => {
    expect(HINT_CONTEXT_STORE_TIMEOUT_MS).toBeGreaterThanOrEqual(2000);
    expect(HINT_CONTEXT_STORE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('guard: every hint asked for one message is taken back when that send fails', () => {
  const all = sources(WEB).map((p) => ({ p: path.relative(WEB, p), s: readFileSync(p, 'utf8') }));
  it('each caller of setPendingHints drops what it set on a failed send', () => {
    const callers = all.filter((f) => f.p !== 'utils/pending-hints.ts' && /\bsetPendingHints\(/.test(f.s));
    expect(callers.map((f) => f.p)).toEqual(['components/sessions/SessionPanel.tsx']);
    for (const f of callers) expect(f.s, f.p).toMatch(/if \(!ok && composed\.hints\)[^\n]*dropPendingHint\(/);
  });
  it('every send that stores its context first caps the store (the comments then go inline)', () => {
    // The composer's sends (composeForSend). The Ask drawer and the browser panel store a context
    // for a launch, not for a message already typed, and keep the client's default deadline.
    const stores = all.filter((f) => f.p !== 'utils/passage-comments.ts' && /\bcomposeForSend\(/.test(f.s));
    expect(stores.length).toBeGreaterThanOrEqual(1);
    for (const f of stores) expect(f.s, f.p).toMatch(/\/api\/v1\/hints\/context['"`],[^\n]*timeoutMs: HINT_CONTEXT_STORE_TIMEOUT_MS/);
  });
});
