/**
 * The session panel's Inbox TAB: the per-session lens on the one letter store,
 * and the deep link that lands on it.
 *
 * Two contracts are pinned here:
 *   1. The list/badge derivation. The tab shows the letters THIS session wrote —
 *      an exact `sender.sessionId` match, archived rows excluded, pinned first
 *      then newest — and the badge counts unread among exactly those. The badge
 *      is what tells a human a letter is waiting, so the rule is a function, not
 *      inline JSX.
 *   2. The deep-link mailbox. A letter's "Open session" is followed BEFORE the
 *      panel that must react exists, so the request is parked and claimed once:
 *      wrong session never claims it, a claim consumes it, and a stale one expires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isDecisionWithoutOptions, type LetterEnvelope } from '../../web/src/api/human-inbox';
import {
  attentionLetterCount, inboxChipTitle, lettersForSession, letterSessionMatch,
  unreadLetterCount, decisionLetterCount,
} from '../../web/src/components/inbox/session-letters';
import {
  armSessionInboxLink, clearSessionInboxLink, consumeSessionInboxLink,
  DEEP_LINK_SETTLE_MS, deepLinkFullscreenReassert, parseSessionInboxTarget,
  ROUTE_EXIT_WINDOW_MS, sessionInboxLetterHref, SESSION_INBOX_LINK_EVENT,
  SESSION_INBOX_LINK_TTL_MS, SESSION_SURFACE_PATH,
} from '../../web/src/components/inbox/session-inbox-link';
import { navigateToTarget } from '../../web/src/utils/open-session';

function letter(over: Partial<LetterEnvelope> & { id: string }): LetterEnvelope {
  return {
    subject: `Subject ${over.id}`,
    type: 'info',
    bodyFormat: 'markdown',
    textPreview: 'preview',
    sender: { sessionId: 'sess-a', host: 'local' },
    createdAt: 1_000,
    read: true,
    pinned: false,
    archived: false,
    ...over,
  } as LetterEnvelope;
}

describe('lettersForSession', () => {
  it('keeps only the letters this session sent', () => {
    const all = [
      letter({ id: 'lt-1', sender: { sessionId: 'sess-a', host: 'local' } }),
      letter({ id: 'lt-2', sender: { sessionId: 'sess-b', host: 'local' } }),
      letter({ id: 'lt-3', sender: { sessionId: 'sess-a', host: 'devbox' } }),
    ];
    expect(lettersForSession(all, 'sess-a').map(l => l.id)).toEqual(['lt-1', 'lt-3']);
  });

  it('leaves an external (hand-started) sender out of every session tab', () => {
    const all = [letter({ id: 'lt-1', sender: { sessionId: 'external', host: 'local' } })];
    expect(lettersForSession(all, 'external')).toHaveLength(1); // only if asked for it
    expect(lettersForSession(all, 'sess-a')).toEqual([]);
  });

  it('excludes archived letters (the archive shelf lives in the rail)', () => {
    const all = [
      letter({ id: 'lt-1' }),
      letter({ id: 'lt-2', archived: true }),
    ];
    expect(lettersForSession(all, 'sess-a').map(l => l.id)).toEqual(['lt-1']);
  });

  it('sorts pinned first, then newest', () => {
    const all = [
      letter({ id: 'lt-old', createdAt: 10 }),
      letter({ id: 'lt-new', createdAt: 90 }),
      letter({ id: 'lt-pin', createdAt: 20, pinned: true }),
    ];
    expect(lettersForSession(all, 'sess-a').map(l => l.id)).toEqual(['lt-pin', 'lt-new', 'lt-old']);
  });

  it('never mutates the caller list, and answers empty for no session', () => {
    const all = [letter({ id: 'lt-2', createdAt: 5 }), letter({ id: 'lt-1', createdAt: 9 })];
    const before = all.map(l => l.id);
    expect(lettersForSession(all, '')).toEqual([]);
    expect(all.map(l => l.id)).toEqual(before);
  });

  it('tolerates a record with no sender object', () => {
    const all = [{ ...letter({ id: 'lt-1' }), sender: undefined } as unknown as LetterEnvelope];
    expect(lettersForSession(all, 'sess-a')).toEqual([]);
  });
});

describe('a decision letter with no options', () => {
  // The store now refuses to accept one, so these are letters ALREADY on disk.
  // The reader gated its whole decision block on having buttons, so such a letter
  // rendered an "Action needed" badge over a document with nothing to answer it
  // with — the human could not tell whether the options were lost or never sent.
  it('is recognised, so the reader can say so instead of showing nothing', () => {
    expect(isDecisionWithoutOptions(letter({ id: 'a', type: 'action_required' }))).toBe(true);
    expect(isDecisionWithoutOptions(letter({ id: 'b', type: 'action_required', actions: [] }))).toBe(true);
  });

  it('is not confused with a healthy decision, a plain letter, or an answered one', () => {
    expect(isDecisionWithoutOptions(
      letter({ id: 'c', type: 'action_required', actions: [{ id: 'go', label: 'Go' }] }),
    )).toBe(false);
    expect(isDecisionWithoutOptions(letter({ id: 'd', type: 'info' }))).toBe(false);
    expect(isDecisionWithoutOptions(letter({ id: 'e', type: 'review' }))).toBe(false);
    expect(isDecisionWithoutOptions(letter({
      id: 'f',
      type: 'action_required',
      answered: { actionId: 'go', label: 'Go', at: 5 },
    }))).toBe(false);
  });
});

describe('the tab badge', () => {
  it('counts unread letters', () => {
    const rows = [letter({ id: 'a', read: false }), letter({ id: 'b' }), letter({ id: 'c', read: false })];
    expect(unreadLetterCount(rows)).toBe(2);
    expect(unreadLetterCount([])).toBe(0);
  });

  it('counts UNANSWERED decisions separately (work is blocked on those)', () => {
    const rows = [
      letter({ id: 'a', type: 'action_required' }),
      letter({
        id: 'b',
        type: 'action_required',
        answered: { actionId: 'go', label: 'Go', at: 5 },
      }),
      letter({ id: 'c', type: 'completion', read: false }),
    ];
    expect(decisionLetterCount(rows)).toBe(1);
  });

  // The badge used to be gated on unread ALONE, which hid the single case the
  // warning colour exists for: reading an action_required letter and deciding
  // later (the point of an async ask) left unread at 0, so the chip went bare
  // while the agent was still blocked on the answer.
  it('counts a READ but unanswered decision — the ask must not go bare', () => {
    const rows = [letter({ id: 'a', type: 'action_required', read: true })];
    expect(unreadLetterCount(rows)).toBe(0);
    expect(decisionLetterCount(rows)).toBe(1);
    expect(attentionLetterCount(rows)).toBe(1);
  });

  it('counts each letter ONCE (unread and undecided is one letter, not two)', () => {
    const rows = [
      letter({ id: 'a', type: 'action_required', read: false }), // both reasons
      letter({ id: 'b', type: 'info', read: false }),            // unread only
      letter({ id: 'c', type: 'action_required', read: true }),  // decision only
      letter({
        id: 'd',
        type: 'action_required',
        read: true,
        answered: { actionId: 'go', label: 'Go', at: 5 },
      }),                                                        // neither
    ];
    expect(attentionLetterCount(rows)).toBe(3);
    expect(attentionLetterCount([])).toBe(0);
    expect(attentionLetterCount([letter({ id: 'z' })])).toBe(0);
  });

  it('names both reasons in the tooltip, so one number is never ambiguous', () => {
    expect(inboxChipTitle(0, 0, 0)).toContain('full-screen alongside the chat');
    expect(inboxChipTitle(2, 2, 0)).toContain('2 unread');
    expect(inboxChipTitle(2, 2, 0)).not.toContain('decision');
    // Read-but-unanswered: the count is 1 and the hover says WHY.
    expect(inboxChipTitle(1, 0, 1)).toContain('1 waiting on a decision');
    expect(inboxChipTitle(1, 0, 1)).not.toContain('unread');
    expect(inboxChipTitle(3, 2, 1)).toBe(
      'Letters this session wrote you — 1 waiting on a decision, 2 unread',
    );
  });
});

describe('letterSessionMatch (a deep-linked letter id is untrusted input)', () => {
  const all = [
    letter({ id: 'lt-mine', sender: { sessionId: 'sess-a', host: 'local' } }),
    letter({ id: 'lt-theirs', sender: { sessionId: 'sess-b', host: 'devbox' } }),
    letter({ id: 'lt-external', sender: { sessionId: 'external', host: 'local' } }),
  ];

  it('accepts this session own letter', () => {
    expect(letterSessionMatch(all, 'lt-mine', 'sess-a')).toBe('match');
  });

  // Rendering it would mark ANOTHER session's letter read, point "← Letters" at a
  // list it isn't in, and route its file paths at this session's host.
  it('refuses another session letter and an external one', () => {
    expect(letterSessionMatch(all, 'lt-theirs', 'sess-a')).toBe('foreign');
    expect(letterSessionMatch(all, 'lt-external', 'sess-a')).toBe('foreign');
  });

  // Not a refusal: the live index has no archived rows, and it is empty while the
  // first GET is in flight — a deep link must still open in both cases.
  it('answers unknown for a letter the live index does not hold', () => {
    expect(letterSessionMatch(all, 'lt-archived', 'sess-a')).toBe('unknown');
    expect(letterSessionMatch([], 'lt-mine', 'sess-a')).toBe('unknown');
  });

  it('tolerates a record with no sender object', () => {
    const rows = [{ ...letter({ id: 'lt-x' }), sender: undefined } as unknown as LetterEnvelope];
    expect(letterSessionMatch(rows, 'lt-x', 'sess-a')).toBe('foreign');
  });
});

describe('parseSessionInboxTarget', () => {
  it('answers null for a plain session link (behaviour must not change)', () => {
    expect(parseSessionInboxTarget('?id=sess-a')).toBeNull();
    expect(parseSessionInboxTarget('id=sess-a&tab=changed')).toBeNull();
  });

  it('reads the tab with and without a letter', () => {
    expect(parseSessionInboxTarget('?id=sess-a&tab=inbox')).toEqual({});
    expect(parseSessionInboxTarget('?id=sess-a&tab=INBOX&letter=lt-1')).toEqual({ letterId: 'lt-1' });
  });

  it('round-trips its own href', () => {
    const href = sessionInboxLetterHref('sess a/b', 'lt-1');
    expect(href).toBe('/sessions?id=sess%20a%2Fb&tab=inbox&letter=lt-1');
    expect(parseSessionInboxTarget(href.slice(href.indexOf('?')))).toEqual({ letterId: 'lt-1' });
  });
});

describe('the deep-link mailbox', () => {
  const dispatched: Array<{ type: string; detail: unknown }> = [];

  beforeEach(() => {
    dispatched.length = 0;
    clearSessionInboxLink();
    vi.stubGlobal('window', {
      innerWidth: 1440,
      dispatchEvent: (e: CustomEvent) => { dispatched.push({ type: e.type, detail: e.detail }); return true; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); clearSessionInboxLink(); });

  it('parks the request AND notifies a panel that is already mounted', () => {
    armSessionInboxLink('sess-a', 'lt-1', 1_000);
    expect(dispatched).toEqual([
      { type: SESSION_INBOX_LINK_EVENT, detail: { sessionId: 'sess-a', letterId: 'lt-1' } },
    ]);
    expect(consumeSessionInboxLink('sess-a', 1_500)).toEqual({ letterId: 'lt-1' });
  });

  it('is claimed ONCE — a second panel for the same session must not re-pop it', () => {
    armSessionInboxLink('sess-a', 'lt-1', 1_000);
    expect(consumeSessionInboxLink('sess-a', 1_000)).toEqual({ letterId: 'lt-1' });
    expect(consumeSessionInboxLink('sess-a', 1_000)).toBeNull();
  });

  it('never leaks into another session', () => {
    armSessionInboxLink('sess-a', 'lt-1', 1_000);
    expect(consumeSessionInboxLink('sess-b', 1_000)).toBeNull();
    // …and stays available for the session it was meant for.
    expect(consumeSessionInboxLink('sess-a', 1_000)).toEqual({ letterId: 'lt-1' });
  });

  it('expires, so a remount minutes later does not yank the user into a letter', () => {
    armSessionInboxLink('sess-a', 'lt-1', 1_000);
    expect(consumeSessionInboxLink('sess-a', 1_000 + SESSION_INBOX_LINK_TTL_MS + 1)).toBeNull();
  });

  it('treats a backwards clock as fresh rather than swallowing the request', () => {
    armSessionInboxLink('sess-a', 'lt-1', 10_000);
    expect(consumeSessionInboxLink('sess-a', 9_000)).toEqual({ letterId: 'lt-1' });
  });

  it('carries a tab-only request (no letter)', () => {
    armSessionInboxLink('sess-a', undefined, 1_000);
    expect(consumeSessionInboxLink('sess-a', 1_000)).toEqual({});
  });
});

describe('navigateToTarget', () => {
  const dispatched: Array<{ type: string; detail: unknown }> = [];
  let navigated: string[] = [];

  beforeEach(() => {
    dispatched.length = 0;
    navigated = [];
    clearSessionInboxLink();
    vi.stubGlobal('window', {
      dispatchEvent: (e: CustomEvent) => { dispatched.push({ type: e.type, detail: e.detail }); return true; },
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); clearSessionInboxLink(); });

  it('reroutes a plain session link to the home columns, arming nothing', () => {
    navigateToTarget('/sessions?id=sess-a', (to) => navigated.push(to));
    expect(navigated).toEqual(['/']);
    expect(dispatched.map(d => d.type)).toEqual(['main:open-session']);
    expect(consumeSessionInboxLink('sess-a')).toBeNull();
  });

  it('arms the Inbox tab + letter when the link asks for them', () => {
    navigateToTarget('/sessions?id=sess-a&tab=inbox&letter=lt-1', (to) => navigated.push(to));
    expect(navigated).toEqual(['/']);
    expect(dispatched.map(d => d.type))
      .toEqual([SESSION_INBOX_LINK_EVENT, 'main:open-session']);
    expect(consumeSessionInboxLink('sess-a')).toEqual({ letterId: 'lt-1' });
  });

  it('leaves a non-session target alone', () => {
    navigateToTarget('/tasks/mt-1', (to) => navigated.push(to));
    expect(navigated).toEqual(['/tasks/mt-1']);
    expect(dispatched).toEqual([]);
  });
});

/**
 * The fullscreen re-assert. Both failure directions have shipped: without it a
 * cross-route deep link loses its view a frame after opening it; with it
 * unconditional, ANY exit inside the window puts useFullscreen's body-portalled
 * backdrop back — a fixed, blurred, click-blocking sheet over whatever page the
 * user navigated to, with the panel it belongs to hidden.
 */
describe('deepLinkFullscreenReassert', () => {
  const NOW = 10_000_000;
  const base = {
    claim: { sid: 'sess-a', at: NOW - 100 },
    sessionId: 'sess-a',
    settledKey: '',
    routeChangedAt: NOW - 40,
    path: SESSION_SURFACE_PATH,
    now: NOW,
  };

  it('re-asserts once when the ROUTE settling dropped fullscreen', () => {
    expect(deepLinkFullscreenReassert(base)).toBe(`sess-a:${NOW - 100}`);
  });

  it('refuses a second time for the same claim — the router settles once, so the next exit is the user', () => {
    const key = deepLinkFullscreenReassert(base)!;
    expect(deepLinkFullscreenReassert({ ...base, settledKey: key })).toBeNull();
  });

  // The major bug: a route change to ANOTHER page also drops fullscreen, and
  // re-entering there strands the backdrop over that page.
  it('never re-asserts on a page that is not the session surface', () => {
    expect(deepLinkFullscreenReassert({ ...base, path: '/notes' })).toBeNull();
    expect(deepLinkFullscreenReassert({ ...base, path: '/tasks' })).toBeNull();
  });

  // Escape / backdrop click: no pathname change, so nothing to undo.
  it('never re-asserts an exit that no route change explains', () => {
    expect(deepLinkFullscreenReassert({ ...base, routeChangedAt: 0 })).toBeNull();
    expect(deepLinkFullscreenReassert({
      ...base,
      routeChangedAt: NOW - ROUTE_EXIT_WINDOW_MS - 1,
    })).toBeNull();
  });

  it('ignores a stale or foreign claim', () => {
    expect(deepLinkFullscreenReassert({ ...base, claim: null })).toBeNull();
    expect(deepLinkFullscreenReassert({ ...base, sessionId: 'sess-b' })).toBeNull();
    expect(deepLinkFullscreenReassert({
      ...base,
      claim: { sid: 'sess-a', at: NOW - DEEP_LINK_SETTLE_MS },
    })).toBeNull();
  });

  it('treats a re-armed link as a NEW claim (the user followed a second letter)', () => {
    const first = deepLinkFullscreenReassert(base)!;
    const again = deepLinkFullscreenReassert({
      ...base,
      claim: { sid: 'sess-a', at: NOW - 10 },
      settledKey: first,
    });
    expect(again).toBe(`sess-a:${NOW - 10}`);
  });
});
