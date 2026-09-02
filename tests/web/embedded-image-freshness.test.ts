/**
 * The quiet image check behind the Files pane — the pure half.
 *
 * Why it exists: an agent regenerated `images/architecture.png`; the markdown
 * embedding it kept the old drawing until the whole app was reloaded, because a
 * byte-identical <img src> is served from the browser's memory cache with no
 * request. The check asks the server for each picture's current ETag (a
 * conditional request, 304 unless changed) and swaps ONLY a changed <img>'s src
 * to a versioned URL. These pin the decision table; the DOM wiring and the
 * "editor is not disturbed" guarantee are pinned in WebKit by
 * tests/e2e/browser/file-image-refresh.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  isProxiedImageSrc, stripImageVersion, withImageVersion, revalidateImages, READ_ONLY_TOOLS,
  type ImgLike,
} from '@/utils/embedded-image-freshness';

const ORIGIN = 'http://localhost:3456';
const PIC = `${ORIGIN}/api/local-image?path=%2Frepo%2Fimages%2Farch.png&host=devbox`;

function img(src: string, lightbox = true): ImgLike {
  return { src, dataset: lightbox ? { lightboxSrc: src } : {} };
}

/** A fetch whose answer per base url is scripted: an ETag, or a failure. */
function fakeFetch(answers: Record<string, string | 'fail' | 'no-etag' | '500'>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const a = answers[stripImageVersion(url)];
    if (a === 'fail' || a === undefined) throw new Error('network');
    if (a === '500') return { ok: false, headers: { get: () => null } };
    return {
      ok: true,
      headers: { get: (n: string) => (n.toLowerCase() === 'etag' && a !== 'no-etag' ? a : null) },
      body: { cancel: async () => {} },
    };
  };
  return { fetchImpl, calls };
}

describe('url helpers', () => {
  it('recognises our proxy in absolute and path-only form, and nothing else', () => {
    expect(isProxiedImageSrc(PIC)).toBe(true);
    expect(isProxiedImageSrc('/api/local-image?path=%2Fa.png')).toBe(true);
    expect(isProxiedImageSrc('/api/images/abc.png')).toBe(false);
    expect(isProxiedImageSrc('https://example.com/a.png')).toBe(false);
    expect(isProxiedImageSrc('data:image/png;base64,AAAA')).toBe(false);
  });

  it('strips only the r parameter, keeping path and host', () => {
    expect(stripImageVersion(`${PIC}&r=12.3`)).toBe(PIC);
    expect(stripImageVersion(PIC)).toBe(PIC);
    expect(stripImageVersion('/x/no-query')).toBe('/x/no-query');
  });

  it('withImageVersion replaces an existing token rather than stacking a second', () => {
    expect(withImageVersion(`${PIC}&r=1`, 2)).toBe(`${PIC}&r=2`);
    expect(withImageVersion(PIC, 'v')).toBe(`${PIC}&r=v`);
    expect(withImageVersion('/x/no-query', 7)).toBe('/x/no-query?r=7');
  });
});

describe('revalidateImages', () => {
  it('records on first sight and swaps nothing — a mount must not re-download every picture', async () => {
    const etags = new Map<string, string>();
    const el = img(PIC);
    const { fetchImpl, calls } = fakeFetch({ [PIC]: '"e1"' });
    const res = await revalidateImages([el], etags, 100, fetchImpl);
    expect(res).toEqual({ changed: [], recorded: [PIC] });
    expect(el.src).toBe(PIC);
    expect(etags.get(PIC)).toBe('"e1"');
    expect(calls).toHaveLength(1);
  });

  it('leaves an unchanged picture alone (same ETag)', async () => {
    const etags = new Map([[PIC, '"e1"']]);
    const el = img(PIC);
    const { fetchImpl } = fakeFetch({ [PIC]: '"e1"' });
    const res = await revalidateImages([el], etags, 100, fetchImpl);
    expect(res.changed).toEqual([]);
    expect(el.src).toBe(PIC);
  });

  it('swaps a changed picture to the versioned url, lightbox target included', async () => {
    const etags = new Map([[PIC, '"e1"']]);
    const el = img(PIC);
    const { fetchImpl } = fakeFetch({ [PIC]: '"e2"' });
    const res = await revalidateImages([el], etags, 4242, fetchImpl);
    expect(res.changed).toEqual([PIC]);
    expect(el.src).toBe(`${PIC}&r=4242`);
    expect(el.dataset.lightboxSrc).toBe(`${PIC}&r=4242`);
    expect(etags.get(PIC)).toBe('"e2"');
  });

  it('a second change gets a second new url (the token is replaced, not appended)', async () => {
    const etags = new Map([[PIC, '"e1"']]);
    const el = img(`${PIC}&r=1`);
    const { fetchImpl } = fakeFetch({ [PIC]: '"e2"' });
    await revalidateImages([el], etags, 2, fetchImpl);
    expect(el.src).toBe(`${PIC}&r=2`);
    expect(el.src.match(/&r=/g)).toHaveLength(1);
  });

  it('checks a picture embedded twice ONCE and swaps both', async () => {
    const etags = new Map([[PIC, '"e1"']]);
    const a = img(`${PIC}&r=1`);
    const b = img(`${PIC}&r=1`);
    const { fetchImpl, calls } = fakeFetch({ [PIC]: '"e2"' });
    await revalidateImages([a, b], etags, 9, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(a.src).toBe(`${PIC}&r=9`);
    expect(b.src).toBe(`${PIC}&r=9`);
  });

  it('ignores images that are not ours', async () => {
    const etags = new Map<string, string>();
    const foreign = img('https://example.com/a.png');
    const chat = img('/api/images/abc.png');
    const { fetchImpl, calls } = fakeFetch({});
    const res = await revalidateImages([foreign, chat], etags, 1, fetchImpl);
    expect(res).toEqual({ changed: [], recorded: [] });
    expect(calls).toHaveLength(0);
  });

  it('a failed or ETag-less answer keeps the old picture and forgets nothing', async () => {
    const etags = new Map([[PIC, '"e1"']]);
    for (const answer of ['fail', 'no-etag', '500'] as const) {
      const el = img(PIC);
      const { fetchImpl } = fakeFetch({ [PIC]: answer });
      const res = await revalidateImages([el], etags, 1, fetchImpl);
      expect(res.changed).toEqual([]);
      expect(el.src).toBe(PIC);
      expect(etags.get(PIC)).toBe('"e1"');
    }
  });

  it('one picture failing does not stop the others', async () => {
    const other = `${ORIGIN}/api/local-image?path=%2Frepo%2Fimages%2Fflow.png`;
    const etags = new Map([[PIC, '"e1"'], [other, '"f1"']]);
    const a = img(PIC);
    const b = img(other);
    const { fetchImpl } = fakeFetch({ [PIC]: 'fail', [other]: '"f2"' });
    const res = await revalidateImages([a, b], etags, 3, fetchImpl);
    expect(res.changed).toEqual([other]);
    expect(a.src).toBe(PIC);
    expect(b.src).toBe(`${other}&r=3`);
  });

  it('asks with no-cache and same-origin credentials — the conditional request the route is built for', async () => {
    const etags = new Map<string, string>();
    let init: unknown;
    const fetchImpl = async (_url: string, i: unknown) => {
      init = i;
      return { ok: true, headers: { get: () => '"e"' } };
    };
    await revalidateImages([img(PIC)], etags, 1, fetchImpl);
    expect(init).toEqual({ cache: 'no-cache', credentials: 'same-origin' });
  });
});

describe('READ_ONLY_TOOLS', () => {
  it('excludes only tools that cannot write a file; writers and scripts count as "might have"', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'TodoWrite']) expect(READ_ONLY_TOOLS.has(t)).toBe(true);
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'mcp__x__render']) {
      expect(READ_ONLY_TOOLS.has(t)).toBe(false);
    }
  });
});
