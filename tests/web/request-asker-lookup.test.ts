/**
 * fetchRequestAsker (web/src/api/sessions.ts): who asked a request, for a reply
 * card whose tool output no longer names it. One GET per id; a 404 is an answer
 * and is kept, a failed fetch is forgotten so the next card may try again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearRequestAskers, fetchRequestAsker } from '../../web/src/api/sessions';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _clearRequestAskers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

describe('fetchRequestAsker', () => {
  it('names the asking session, with one request for every card that asks', async () => {
    fetchMock.mockResolvedValue(json({ request: { id: 'rq-023db702061f', fromSessionId: 'sess-asker', status: 'replied' } }));
    const [a, b] = await Promise.all([fetchRequestAsker('rq-023db702061f'), fetchRequestAsker('rq-023db702061f')]);
    expect(a).toBe('sess-asker');
    expect(b).toBe('sess-asker');
    expect(await fetchRequestAsker('rq-023db702061f')).toBe('sess-asker');
    expect(urls()).toEqual(['/api/v1/requests/rq-023db702061f']);
  });

  it('keeps a 404 as "nobody to name" and does not ask again', async () => {
    fetchMock.mockResolvedValue(json({ error: 'not_found' }, 404));
    expect(await fetchRequestAsker('rq-0000000000aa')).toBeNull();
    expect(await fetchRequestAsker('rq-0000000000aa')).toBeNull();
    expect(urls()).toHaveLength(1);
  });

  it('forgets a failed fetch, so a later card can still name the asker', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchRequestAsker('rq-0000000000bb')).toBeNull();
    fetchMock.mockResolvedValue(json({ request: { fromSessionId: 'sess-later' } }));
    expect(await fetchRequestAsker('rq-0000000000bb')).toBe('sess-later');
    expect(urls()).toHaveLength(2);
  });

  it('treats a row without an asker as nobody to name', async () => {
    fetchMock.mockResolvedValue(json({ request: { fromSessionId: '' } }));
    expect(await fetchRequestAsker('rq-0000000000cc')).toBeNull();
  });
});
