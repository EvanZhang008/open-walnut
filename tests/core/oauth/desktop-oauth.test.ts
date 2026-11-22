/**
 * The shared OAuth token getter (core/oauth/desktop-oauth.ts) racing the sign-in it refreshes:
 * a sign-in removed while its refresh was in flight stays removed, and a newer sign-in made
 * meanwhile is never overwritten with the older one's tokens.
 */
import { describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  deleteTokenFile, makeAccessTokenGetter, readTokenFile, updateTokenFile, writeTokenFile, type OAuthProvider, type OAuthTokens,
} from '../../../src/core/oauth/desktop-oauth.js';

const PROVIDER: OAuthProvider = {
  name: 'Example',
  what: 'your example calendar',
  again: 'Sign in again.',
  endpoints: () => ({ auth: 'http://127.0.0.1:9/auth', token: 'http://127.0.0.1:9/token' }),
  scopes: ['calendar'],
};

const OLD: OAuthTokens = { refresh_token: 'rt-old', access_token: 'at-old', expires_at: 0, client_id: 'client-1', scope: 'calendar', connected_at: '2026-08-01T00:00:00.000Z' };
const NEW: OAuthTokens = { refresh_token: 'rt-new', access_token: 'at-new', expires_at: Date.now() + 3_600_000, client_id: 'client-1', scope: 'calendar', connected_at: '2026-08-02T00:00:00.000Z' };

/** A token endpoint that answers each refresh only when `release()` is called; it names the refresh token it was given. */
function gatedTokenEndpoint() {
  const waiting: Array<() => void> = [];
  const seen: string[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    seen.push(form.get('refresh_token') ?? '');
    await new Promise<void>((r) => waiting.push(r));
    return new Response(JSON.stringify({ access_token: `at-from-${form.get('refresh_token')}`, expires_in: 3600, scope: 'calendar' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  /** Answer the next refresh, once it has been asked. */
  const release = async () => {
    await vi.waitFor(() => { if (!waiting.length) throw new Error('no refresh asked yet'); });
    waiting.shift()!();
  };
  /** Wait until `n` refreshes have been asked. */
  const asked = (n: number) => vi.waitFor(() => { if (seen.length < n) throw new Error('refresh not asked yet'); });
  return { fetchImpl, release, asked, seen };
}

function getterOver(file: { t: OAuthTokens | null; writes: OAuthTokens[] }, fetchImpl: typeof fetch) {
  return makeAccessTokenGetter({
    provider: PROVIDER,
    read: async () => (file.t ? { ...file.t } : null),
    update: async (change) => {
      const before = file.t ? { ...file.t } : null;
      const after = change(before);
      if (after) { file.writes.push(after); file.t = after; }
      return { before, after };
    },
    client: () => ({ clientId: 'client-1', source: 'custom' }),
    notConnected: () => new Error('not connected'),
    revoked: () => new Error('revoked'),
    fetchImpl,
  });
}

describe('a token refresh racing its sign-in', () => {
  it('a sign-in removed while its refresh was in flight stays removed', async () => {
    const file = { t: { ...OLD } as OAuthTokens | null, writes: [] as OAuthTokens[] };
    const endpoint = gatedTokenEndpoint();
    const pending = getterOver(file, endpoint.fetchImpl)().then(() => 'answered', (e: Error) => e.message);
    await endpoint.asked(1);
    file.t = null; // Remove: the token file is deleted
    await endpoint.release();
    expect(await pending).toBe('not connected');
    expect(file.t).toBeNull();
    expect(file.writes).toEqual([]);
  });

  it('a newer sign-in made meanwhile is kept, and its own token is answered', async () => {
    const file = { t: { ...OLD } as OAuthTokens | null, writes: [] as OAuthTokens[] };
    const endpoint = gatedTokenEndpoint();
    const pending = getterOver(file, endpoint.fetchImpl)();
    await endpoint.asked(1);
    file.t = { ...NEW }; // signed in again
    await endpoint.release();
    expect(await pending).toBe('at-new');
    expect(file.t).toEqual(NEW);
    expect(file.writes).toEqual([]);
  });

  it('a newer sign-in whose own token is spent is refreshed with its own refresh token', async () => {
    const file = { t: { ...OLD } as OAuthTokens | null, writes: [] as OAuthTokens[] };
    const endpoint = gatedTokenEndpoint();
    const pending = getterOver(file, endpoint.fetchImpl)();
    await endpoint.asked(1);
    file.t = { ...NEW, expires_at: 0 };
    await endpoint.release();
    await endpoint.release();
    expect(await pending).toBe('at-from-rt-new');
    expect(endpoint.seen).toEqual(['rt-old', 'rt-new']);
    expect(file.t).toMatchObject({ refresh_token: 'rt-new', connected_at: NEW.connected_at, access_token: 'at-from-rt-new' });
  });

  it('with nothing racing, the refreshed token is written back keeping the file\'s other fields', async () => {
    const file = { t: { ...OLD, email: 'pat@example.com' } as OAuthTokens | null, writes: [] as OAuthTokens[] };
    const endpoint = gatedTokenEndpoint();
    const pending = getterOver(file, endpoint.fetchImpl)();
    await endpoint.release();
    expect(await pending).toBe('at-from-rt-old');
    expect(file.t).toMatchObject({ refresh_token: 'rt-old', access_token: 'at-from-rt-old', email: 'pat@example.com', connected_at: OLD.connected_at });
  });
});

describe('one queue per token file', () => {
  it('a write-back asked after a removal finds no file and writes nothing; one asked before is removed after', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-oauth-queue-'));
    const file = path.join(dir, 'sign-in.json');
    try {
      await writeTokenFile(file, OLD);
      const refreshed = (cur: OAuthTokens | null) => (cur ? { ...cur, access_token: 'at-refreshed' } : null);
      // Both asked in the same tick: the removal first, then the write-back.
      const [, late] = await Promise.all([deleteTokenFile(file), updateTokenFile(file, refreshed)]);
      expect(late).toEqual({ before: null, after: null });
      expect(await readTokenFile(file)).toBeNull();
      // The write-back first, then the removal: the file is gone at the end either way.
      await writeTokenFile(file, OLD);
      const [early] = await Promise.all([updateTokenFile(file, refreshed), deleteTokenFile(file)]);
      expect(early.after).toMatchObject({ access_token: 'at-refreshed' });
      expect(await readTokenFile(file)).toBeNull();
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
