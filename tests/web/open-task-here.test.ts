/**
 * openTaskHere (web/src/utils/open-session.ts), the one task open: a page that opens tasks in its own
 * columns (the Org page) takes the open and nothing goes to Home; every other page goes to Home.
 *
 * 2026-11-15, the user: "if we click in te org seciton the taks need ot open in org that is only
 * difference, all other page go to home. right now in org I clcik task it go to home this is not right".
 * Real window events on a stand-in window; stubbed only the pop-out check and the inbox link mailbox.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/popout/openPopout', () => ({ isPopoutPath: (p: string) => p.startsWith('/popout'), openTaskInApp: vi.fn() }));
vi.mock('@/components/inbox/session-inbox-link', () => ({ armSessionInboxLink: vi.fn(), parseSessionInboxTarget: () => null }));

type Win = EventTarget & { location: { pathname: string } };
const g = globalThis as unknown as { window?: Win };
let saved: Win | undefined;

beforeEach(() => {
  saved = g.window;
  g.window = Object.assign(new EventTarget(), { location: { pathname: '/org' } });
});
afterEach(() => { g.window = saved; });

const mod = await import('../../web/src/utils/open-session');

function recordEvents() {
  const seen: string[] = [];
  for (const name of [mod.TASK_OPEN_EVENT, 'main:locate-task']) g.window!.addEventListener(name, () => seen.push(name));
  return seen;
}

describe('openTaskHere: the page the click was made on decides', () => {
  it('with a page opener (the Org page), the page opens it and Home is never told', () => {
    const navigate = vi.fn();
    const opened: Array<[string, unknown]> = [];
    const off = mod.onOpenTaskOnPage((id, opts) => opened.push([id, opts]));
    const seen = recordEvents();
    mod.openTaskHere('t-1', navigate, { sessionId: 's-9' });
    expect(opened).toEqual([['t-1', { sessionId: 's-9' }]]);
    expect(navigate).not.toHaveBeenCalled();
    expect(seen, 'layers yield, Home does not locate').toEqual([mod.TASK_OPEN_EVENT]);
    off();
  });

  it('a link path (a notice, a toast) on the Org page opens there too', () => {
    const navigate = vi.fn();
    const opened: string[] = [];
    const off = mod.onOpenTaskOnPage((id) => opened.push(id));
    mod.navigateToTarget('/tasks/t-2', navigate);
    expect(opened).toEqual(['t-2']);
    expect(navigate).not.toHaveBeenCalled();
    off();
  });

  it('with no page opener (every other page), the task opens on Home', () => {
    g.window!.location.pathname = '/calendar';
    const navigate = vi.fn();
    const seen = recordEvents();
    mod.openTaskHere('t-3', navigate);
    expect(navigate).toHaveBeenCalledWith('/');
    expect(seen).toEqual([mod.TASK_OPEN_EVENT, 'main:locate-task']);
  });

  it('after the page opener unsubscribes (the Org page left), the next open goes to Home', () => {
    const navigate = vi.fn();
    const opened: string[] = [];
    const off = mod.onOpenTaskOnPage((id) => opened.push(id));
    off();
    mod.openTaskHere('t-4', navigate);
    expect(opened).toEqual([]);
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
