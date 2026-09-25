/**
 * A partial directory listing in the folder picker. The server answers
 * list-dirs with `incomplete: { unanswered, message }` when some entries (a
 * link into a hung mount) did not answer in time; the picker shows that text as
 * one muted line under the list, and the client cache never keeps such an
 * answer, because the next ask may find the mount awake again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from '../../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../../web/node_modules/react-dom/server.node.js';

const apiGet = vi.fn();
vi.mock('../../../web/src/api/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiGet: (...args: unknown[]) => apiGet(...args),
}));

const { listDirs, listDirsCached, invalidateLiveDirCache, parseDirListingIncomplete } = await import('../../../web/src/api/sessions');
const { PathList } = await import('../../../web/src/components/sessions/path-selector/PathList');
type HostLiveState = import('../../../web/src/components/sessions/path-selector/useLiveDirs').HostLiveState;

const MESSAGE = 'listing incomplete: 2 entries did not answer';
const PARTIAL = { dirs: ['/home/dev/src'], parent: '/home/dev/', exists: true, incomplete: { unanswered: 2, message: MESSAGE } };

beforeEach(() => {
  apiGet.mockReset();
  invalidateLiveDirCache();
});

describe('list-dirs `incomplete` on the client', () => {
  it('passes the server note through, and drops a malformed one', async () => {
    apiGet.mockResolvedValueOnce(PARTIAL);
    expect((await listDirs('~/', 'devbox')).incomplete).toEqual({ unanswered: 2, message: MESSAGE });
    apiGet.mockResolvedValueOnce({ ...PARTIAL, incomplete: { unanswered: 2 } });
    expect('incomplete' in (await listDirs('~/', 'devbox'))).toBe(false);
    expect(parseDirListingIncomplete(null)).toBeUndefined();
    expect(parseDirListingIncomplete({ message: '' })).toBeUndefined();
    expect(parseDirListingIncomplete({ message: MESSAGE })).toEqual({ unanswered: 0, message: MESSAGE });
  });

  it('never caches a partial listing, and still caches a complete one', async () => {
    apiGet.mockResolvedValue(PARTIAL);
    await listDirsCached('~/', 'devbox');
    await listDirsCached('~/', 'devbox');
    expect(apiGet).toHaveBeenCalledTimes(2);
    apiGet.mockReset();
    apiGet.mockResolvedValue({ dirs: ['/home/dev/src'], parent: '/home/dev/', exists: true });
    await listDirsCached('~/', 'devbox');
    await listDirsCached('~/', 'devbox');
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

const done = (over: Partial<HostLiveState> = {}): HostLiveState =>
  ({ status: 'done', parent: '/home/dev/', exists: true, dirs: ['/home/dev/src'], ...over });

function render(hostStates: Map<string, HostLiveState>, pathMode = true) {
  return renderToStaticMarkup(createElement(PathList, {
    sections: [], selectedIdx: -1, expandSelected: false, loading: false, loadError: null,
    hostStates, hostLabels: new Map([['devbox', 'Big dev box'], ['builder', 'Builder']]), pathMode,
    activeHostLabel: 'Big dev box', createOption: null, emptyHint: 'No paths match your search.',
    onItemClick: () => {}, onItemHover: () => {}, onCreate: () => {},
  }));
}
const lines = (html: string) => [...html.matchAll(/<div class="sps-list-incomplete"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]);

describe('PathList: the "listing incomplete" line', () => {
  it('one muted line with the server text exactly, last in the list', () => {
    const html = render(new Map([['devbox', done({ incomplete: { unanswered: 2, message: MESSAGE } })]]));
    expect(lines(html)).toEqual([MESSAGE]);
    expect(html).toContain('data-host="devbox"');
    expect(html.trimEnd().endsWith(`${MESSAGE}</div></div>`)).toBe(true);
  });

  it('two partial hosts: one line each, named', () => {
    const html = render(new Map([
      ['devbox', done({ incomplete: { unanswered: 2, message: MESSAGE } })],
      ['builder', done({ incomplete: { unanswered: 1, message: 'listing incomplete: 1 entry did not answer' } })],
      ['__local__', done()],
    ]));
    expect(lines(html)).toEqual([`Big dev box: ${MESSAGE}`, 'Builder: listing incomplete: 1 entry did not answer']);
  });

  it('nothing for a complete listing, a host still loading, or outside path mode', () => {
    expect(lines(render(new Map([['devbox', done()]])))).toEqual([]);
    expect(lines(render(new Map([['devbox', { ...done({ incomplete: { unanswered: 2, message: MESSAGE } }), status: 'loading' }]])))).toEqual([]);
    expect(lines(render(new Map([['devbox', done({ incomplete: { unanswered: 2, message: MESSAGE } })]]), false))).toEqual([]);
  });

  it('an empty partial listing keeps "No subdirectories" and adds the line under it', () => {
    const html = render(new Map([['devbox', done({ dirs: [], incomplete: { unanswered: 3, message: 'listing incomplete: 3 entries did not answer' } })]]));
    expect(html).toContain('No subdirectories on Big dev box');
    expect(lines(html)).toEqual(['listing incomplete: 3 entries did not answer']);
    expect(html.indexOf('No subdirectories')).toBeLessThan(html.indexOf('sps-list-incomplete'));
  });
});
