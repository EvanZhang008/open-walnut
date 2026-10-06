/**
 * The walnut-time task page's addresses: the paths the task detail slot and the
 * session header chip link to, and how the App reads them back. A round trip has
 * to survive ids with characters a URL treats specially, and a subpath the page
 * does not own must fall through to the App's own tabs.
 */

import { describe, it, expect } from 'vitest';
import { formatLane, rawSubpath, timePageFromRoute, timePaths } from '../../examples/plugins/walnut-time/src/web/task-routes';

const BASE = '/apps/walnut-time~main';

/** What the App's root hands the page: the part after its base, and the query string. */
function route(path: string): [string, string] {
  const [pathname, search = ''] = path.split('?');
  return [pathname!.slice(BASE.length), search ? `?${search}` : ''];
}

describe('task page addresses', () => {
  it('round-trips a task, a task narrowed to one session, and a session with no task', () => {
    const paths = timePaths(`${BASE}/`);
    expect(paths.task('t_1')).toBe(`${BASE}/task/t_1`);
    expect(timePageFromRoute(...route(paths.task('t_1')))).toEqual({ kind: 'task', id: 't_1', session: null });
    expect(timePageFromRoute(...route(paths.task('t_1', 's-9')))).toEqual({ kind: 'task', id: 't_1', session: 's-9' });
    expect(timePageFromRoute(...route(paths.session('s-9')))).toEqual({ kind: 'session', id: 's-9' });
  });

  it('keeps an id with URL characters in it whole', () => {
    const paths = timePaths(BASE);
    const id = 'a/b?c#d&e f';
    expect(timePageFromRoute(...route(paths.task(id, id)))).toEqual({ kind: 'task', id, session: id });
    expect(timePageFromRoute(...route(paths.session(id)))).toEqual({ kind: 'session', id });
  });

  it('leaves the App\'s own tabs and a bare /task alone', () => {
    for (const sub of ['', '/', '/agents', '/timeline', '/task', '/task/', '/session/', '/elsewhere/t_1']) {
      expect(timePageFromRoute(sub, ''), sub).toBeNull();
    }
  });

  it('reads an empty session as the whole task, and a malformed escape as the text it is', () => {
    expect(timePageFromRoute('/task/t_1', '?session=')).toEqual({ kind: 'task', id: 't_1', session: null });
    expect(timePageFromRoute('/task/100%', '')).toEqual({ kind: 'task', id: '100%', session: null });
  });
});

describe('rawSubpath', () => {
  it('reads the subpath from the address, still encoded, so an id is decoded exactly once', () => {
    const id = 'a%41'; // the router would hand the App 'a%41' already decoded; decoding again gives 'aA'
    const address = timePaths(BASE).task(id);
    const props = { basePath: BASE, subpath: `/task/${id}` };
    expect(rawSubpath(props, address)).toBe(`/task/${encodeURIComponent(id)}`);
    expect(timePageFromRoute(rawSubpath(props, address), '')).toEqual({ kind: 'task', id, session: null });
  });

  it('falls back to the router\'s subpath off the App\'s own address', () => {
    expect(rawSubpath({ basePath: BASE, subpath: '/agents' }, '/elsewhere')).toBe('/agents');
    expect(rawSubpath({ basePath: BASE, subpath: '' }, BASE)).toBe('');
  });
});

describe('formatLane', () => {
  it('reads an empty lane as 0m, not as a stopwatch', () => {
    expect(formatLane(0)).toBe('0m');
    expect(formatLane(-5)).toBe('0m');
    expect(formatLane(25 * 60_000)).not.toBe('0m');
  });
});
