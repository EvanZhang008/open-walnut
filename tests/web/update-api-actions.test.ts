/**
 * installUpdateNow / restartIntoUpdate (web/src/api/update.ts): the POST they send,
 * the status a 202 answers, and a refusal read into UpdateActionError (code, the
 * command that fixes it, the status sent with it), also when the body is not JSON.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installUpdateNow, restartIntoUpdate, UpdateActionError } from '@/api/update';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answer(status: number, body: unknown, raw = false) {
  const fn = vi.fn(async () => new Response(raw ? String(body) : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('update actions', () => {
  it('install POSTs {} to /api/system/update/install and returns the 202 status', async () => {
    const fn = answer(202, { current: '0.5.1', live: { state: 'downloading' } });
    const s = await installUpdateNow();
    expect(s.live?.state).toBe('downloading');
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/system/update/install');
    expect(init).toMatchObject({ method: 'POST', body: '{}' });
  });

  it('a 409 cannot_install carries the fix command and the status the server sent', async () => {
    answer(409, { error: 'cannot_install', fix: 'sudo npm install -g open-walnut@latest', status: { current: '0.5.1' } });
    const err = await installUpdateNow().catch((e: unknown) => e) as UpdateActionError;
    expect(err).toBeInstanceOf(UpdateActionError);
    expect(err).toMatchObject({ code: 'cannot_install', fix: 'sudo npm install -g open-walnut@latest' });
    expect(err.status?.current).toBe('0.5.1');
    expect(err.message).toBe('This copy of Walnut cannot install updates by itself.');
  });

  it('restart: a 409 no_restart reads as words a person can act on; a non-JSON 500 still throws', async () => {
    answer(409, { error: 'no_restart' });
    const err = await restartIntoUpdate().catch((e: unknown) => e) as UpdateActionError;
    expect(err).toMatchObject({ code: 'no_restart', fix: null, status: null });
    expect(err.message).toContain('cannot restart itself');
    answer(500, 'boom', true);
    const err2 = await restartIntoUpdate().catch((e: unknown) => e) as UpdateActionError;
    expect(err2).toMatchObject({ code: null, message: 'HTTP 500' });
  });
});
