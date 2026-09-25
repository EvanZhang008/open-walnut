/**
 * Reminder notices, their buttons, and quiet mode on the web side.
 *
 *   - `reminder` is persistent, toasts, and stays up for two minutes.
 *   - a record's `actions` list is authoritative over the single `action`, is
 *     validated (unknown kinds and malformed entries drop out) and capped at three.
 *   - an `op` button POSTs its args to the plugin-runtime route, and the BODY
 *     decides success: the route answers 200 `{ ok: false }` when the op failed.
 *   - quiet silences every toast but a permission ask (while allowed), and a hold
 *     past its `until` no longer counts even before the server says so.
 */
import { describe, it, expect, vi } from 'vitest';
import { SHOULD_TOAST, IS_PERSISTENT, TOAST_DURATION_MS } from '../../web/src/contexts/notifications/types';
import { actionOf, sectionOf } from '../../web/src/contexts/notifications/notification-model';
import {
  displayActionsOf, opActionPath, runOpAction, wireActionsOf,
} from '../../web/src/contexts/notifications/notification-actions';
import {
  NOT_QUIET, effectiveQuiet, normalizeQuiet, quietAllowsToast, quietLabel,
} from '../../web/src/contexts/notifications/quiet-model';
import { playChime } from '../../web/src/utils/chime';
import type { Notification } from '../../web/src/contexts/notifications/types';

const opButton = { kind: 'op', label: 'Done', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_done', args: { minutes: 2 } };

describe('reminder policy', () => {
  it('is persistent, toasts, and waits two minutes', () => {
    expect(IS_PERSISTENT.reminder).toBe(true);
    expect(SHOULD_TOAST({ kind: 'reminder', severity: 'info' })).toBe(true);
    expect(TOAST_DURATION_MS.reminder).toBe(120_000);
  });

  it('lands in the All section', () => {
    const n = { id: 'r', kind: 'reminder', severity: 'info', title: 't', timestamp: 1, persistent: true, dedupKey: 'k' } as Notification;
    expect(sectionOf(n)).toBe('all');
  });
});

describe('actions', () => {
  it('actionOf prefers the first entry of `actions` over the single action', () => {
    expect(actionOf({ actions: [opButton], action: { label: 'Sign in', to: '/settings' } }))
      .toEqual({ label: 'Done', kind: 'op', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_done', args: { minutes: 2 } });
  });

  it('actionOf falls back to `action` (then the session link) when `actions` is absent or all invalid', () => {
    expect(actionOf({ actions: [{ kind: 'op', label: 'x' }], action: { label: 'Sign in', to: '/settings' } }))
      .toEqual({ label: 'Sign in', kind: 'navigate', to: '/settings' });
    expect(actionOf({ sessionId: 's1' })).toEqual({ label: 'Go to Session', kind: 'navigate', to: '/sessions?id=s1' });
  });

  it('wireActionsOf drops unknown kinds and malformed entries, and caps at three', () => {
    const list = wireActionsOf([
      opButton,
      { kind: 'teleport', label: 'Beam me' },
      { kind: 'navigate', label: 'Open', to: '/tasks' },
      { label: 'Legacy link', to: '/skills' },
      { kind: 'op', label: 'Snooze', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_snooze' },
      { kind: 'op', label: 'Fourth', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_x' },
    ]);
    expect(list.map(a => a.label)).toEqual(['Done', 'Open', 'Legacy link']);
    expect(wireActionsOf('nope')).toEqual([]);
    expect(wireActionsOf(null)).toEqual([]);
  });

  it('displayActionsOf renders the list when present, else the single action', () => {
    const one = { label: 'Go', kind: 'navigate' as const, to: '/x' };
    expect(displayActionsOf({ action: one })).toEqual([one]);
    expect(displayActionsOf({ action: one, actions: wireActionsOf([opButton]) }).map(a => a.label)).toEqual(['Done']);
    expect(displayActionsOf({})).toEqual([]);
  });

  it('an op button POSTs its args to the plugin-runtime route', async () => {
    const [a] = wireActionsOf([opButton]);
    expect(opActionPath(a)).toBe('/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_break_done');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    expect(await runOpAction(a, fetchImpl as unknown as typeof fetch)).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/plugin-runtime/walnut-rhythm/ops/walnut_rhythm_break_done');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ minutes: 2 });
  });

  it('the body decides: 200 { ok: false } is a failure with the op\'s message', async () => {
    const [a] = wireActionsOf([opButton]);
    const failing = vi.fn(async () => new Response(JSON.stringify({ ok: false, message: 'No break running' }), { status: 200 }));
    expect(await runOpAction(a, failing as unknown as typeof fetch)).toEqual({ ok: false, message: 'No break running' });
    const missing = vi.fn(async () => new Response(JSON.stringify({ error: 'Active Plugin "walnut-rhythm" was not found' }), { status: 404 }));
    expect(await runOpAction(a, missing as unknown as typeof fetch))
      .toEqual({ ok: false, message: 'Active Plugin "walnut-rhythm" was not found' });
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await runOpAction(a, offline as unknown as typeof fetch)).toEqual({ ok: false, message: 'Walnut is unreachable' });
  });

  it('a non-op action is never POSTed', async () => {
    const fetchImpl = vi.fn();
    const out = await runOpAction({ label: 'Go', kind: 'navigate', to: '/x' }, fetchImpl as unknown as typeof fetch);
    expect(out.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('quiet model', () => {
  const now = 1_790_000_000_000;
  const quiet = (over: Partial<ReturnType<typeof normalizeQuiet>> = {}) => normalizeQuiet({
    active: true, allowPermissions: true,
    holds: [{ source: 'plugin:walnut-rhythm', since: now - 60_000, until: now + 60_000, reason: 'Focus block' }],
    ...over,
  });

  it('silences every toast but a permission ask while permissions are allowed', () => {
    const q = quiet();
    expect(quietAllowsToast(q, 'reminder', now)).toBe(false);
    expect(quietAllowsToast(q, 'operation-error', now)).toBe(false);
    expect(quietAllowsToast(q, 'hook', now)).toBe(false);
    expect(quietAllowsToast(q, 'permission', now)).toBe(true);
    expect(quietAllowsToast(quiet({ allowPermissions: false }), 'permission', now)).toBe(false);
    expect(quietAllowsToast(NOT_QUIET, 'reminder', now)).toBe(true);
  });

  it('never holds back an ephemeral toast (feedback on the human\'s own action, no feed copy)', () => {
    expect(quietAllowsToast(quiet(), 'sort', now)).toBe(true);
    expect(quietAllowsToast(quiet({ allowPermissions: false }), 'audio-error', now)).toBe(true);
  });

  it('a hold past its `until` stops counting before the server says so', () => {
    const q = quiet();
    expect(effectiveQuiet(q, now + 61_000)).toEqual(NOT_QUIET);
    expect(quietAllowsToast(q, 'reminder', now + 61_000)).toBe(true);
  });

  it('degrades on garbage and labels the holds for the bell', () => {
    expect(normalizeQuiet(null)).toEqual(NOT_QUIET);
    expect(normalizeQuiet({ active: true, holds: [{ nope: 1 }] }).active).toBe(false);
    expect(quietLabel(quiet(), now)).toMatch(/^Quiet: Focus block until /);
    expect(quietLabel(normalizeQuiet({ active: true, holds: [{ source: 'user', since: now }] }), now)).toBe('Quiet: you');
    expect(quietLabel(NOT_QUIET, now)).toBe('Notifications');
  });
});

describe('chime', () => {
  it('never throws, with no AudioContext or with one that refuses to start', () => {
    expect(() => playChime('reminder')).not.toThrow();
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('autoplay'); } });
    expect(() => playChime('reminder')).not.toThrow();
    vi.unstubAllGlobals();
  });
});
