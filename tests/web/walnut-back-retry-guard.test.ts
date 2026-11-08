/**
 * A view that failed to load while Walnut itself was not answering asks again by itself
 * (D13: the Demo server was stopped and brought back; the Files tree kept "Load failed",
 * WebKit's word for a fetch that never reached the server, until Refresh was pressed).
 *
 * The class: every view that already asks again on a clock while a HOST comes back
 * (`host_reconnecting`) must treat Walnut not answering the same way, and ask again the
 * moment the socket reconnects. The guard lists those views from the source, so a new one
 * that only knows the host case fails here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DirListError, FileReadError, WALNUT_UNREACHABLE_CODE, WALNUT_UNREACHABLE_MESSAGE, fetchDirList, fetchFileContentConditional,
  isComingBackCode, isWalnutUnreachable,
} from '../../web/src/api/files';

const WEB = join(__dirname, '../../web/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('reads that fail only because Walnut is not answering', () => {
  it('a listing whose request never reached Walnut is a coming-back failure in plain words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Load failed'); }));
    const err = await fetchDirList('/work').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DirListError);
    expect((err as DirListError).code).toBe(WALNUT_UNREACHABLE_CODE);
    expect((err as DirListError).message).toBe(WALNUT_UNREACHABLE_MESSAGE);
    expect(isWalnutUnreachable(err)).toBe(true);
  });

  it('a gateway status with no word of Walnut is the same; a Walnut answer keeps its own words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })));
    expect(isWalnutUnreachable(await fetchDirList('/work').catch((e: unknown) => e))).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'devbox is unreachable' }, { status: 503 })));
    const answered = await fetchDirList('/work', 'devbox').catch((e: unknown) => e) as DirListError;
    expect(answered.message).toBe('devbox is unreachable');
    expect(isWalnutUnreachable(answered)).toBe(false);
  });

  it('a file read that never reached Walnut, or met a gateway page, is one too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await fetchFileContentConditional('/work/a.md').catch((e: unknown) => e);
    expect(isWalnutUnreachable(err)).toBe(true);
    expect((err as Error).message).toBe(WALNUT_UNREACHABLE_MESSAGE);
    for (const status of [502, 503, 504]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status })));
      expect(isWalnutUnreachable(await fetchFileContentConditional('/work/a.md').catch((e: unknown) => e)), String(status)).toBe(true);
    }
  });

  it('a file read Walnut itself refused with a gateway status shows Walnut\'s words and code, as a listing does', async () => {
    // 2026-11-10 review: any 502/503/504 read "Can't reach Walnut" even with Walnut's own error body.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Demo is stopping; no new work is accepted' }, { status: 503 })));
    const stopping = await fetchFileContentConditional('/work/a.md').catch((e: unknown) => e) as FileReadError;
    expect(stopping).toBeInstanceOf(FileReadError);
    expect(stopping.message).toBe('Demo is stopping; no new work is accepted');
    expect(isWalnutUnreachable(stopping)).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'devbox is reconnecting', code: 'host_reconnecting' }, { status: 503 })));
    const host = await fetchFileContentConditional('/work/a.md', 'devbox').catch((e: unknown) => e) as FileReadError;
    expect(host.code).toBe('host_reconnecting');
    expect(isComingBackCode(host.code)).toBe(true);
  });

  it('guard: every read in api/files.ts decides "Walnut did not answer" by the one rule', () => {
    const src = readFileSync(join(WEB, 'api/files.ts'), 'utf8');
    // The gateway statuses are named once, inside walnutDidNotAnswer.
    expect(src.match(/=== 50[234]\b/g)?.length).toBe(3);
    expect(src).toMatch(/export function walnutDidNotAnswer\(status: number, said: \{ error\?: string \}\): boolean \{\n\s+return \(status === 502 \|\| status === 503 \|\| status === 504\) && !said\.error;/);
    // Every unreachable error made from a status goes through it.
    for (const m of src.matchAll(/^.*(new WalnutUnreachableError\(|WALNUT_UNREACHABLE_MESSAGE, res\.status).*$/gm)) {
      expect(m[0], m[0]).toMatch(/walnutDidNotAnswer\(|instanceof TypeError/);
    }
  });

  it('an abort the caller asked for stays an abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError'); }));
    const err = await fetchDirList('/work').catch((e: unknown) => e);
    expect(isWalnutUnreachable(err)).toBe(false);
  });

  it('both codes ask again on the clock', () => {
    expect(isComingBackCode('host_reconnecting')).toBe(true);
    expect(isComingBackCode(WALNUT_UNREACHABLE_CODE)).toBe(true);
    expect(isComingBackCode(undefined)).toBe(false);
    expect(isComingBackCode('not_found')).toBe(false);
  });
});

describe('guard: every view that waits for a host to come back also waits for Walnut', () => {
  // A view keeping a retry clock for a host that reconnects: it names the host code (or the
  // shared predicate) and asks again with visibleInterval.
  const HOST_WAIT = /HOST_RECONNECTING_CODE|isHostReconnectingListing|'host_reconnecting'|isComingBackCode/;
  const views = sources(WEB)
    .map((path) => ({ rel: relative(WEB, path), text: readFileSync(path, 'utf8') }))
    .filter(({ rel, text }) => rel !== 'api/files.ts' && HOST_WAIT.test(text) && /visibleInterval\(/.test(text));

  it('finds the views it guards', () => {
    expect(views.map((v) => v.rel).sort()).toEqual([
      'components/common/FileContentView.tsx',
      'components/sessions/SessionFileExplorer.tsx',
    ]);
  });

  it.each(views.map((v) => [v.rel, v.text] as const))('%s counts Walnut not answering as coming back and asks again on reconnect', (_rel, text) => {
    expect(text).toMatch(/isComingBackCode|isWalnutUnreachable/);
    expect(text).toMatch(/useEvent\('_ws:reconnected'/);
  });
});
