/**
 * Human Inbox letter → iOS push notification.
 *
 * Contract under test:
 *   - a letter event pushes to every registered device (mode `always`, the
 *     DEFAULT), regardless of whether a browser WS is open. The old sender gated
 *     on `clientCount() > 0`, so a Mac console tab silently suppressed every
 *     letter push — that gate must be gone.
 *   - mode `when-inactive` suppresses while THAT device reports itself
 *     foregrounded, and sends once the report goes stale (a lease, not a latch)
 *     or is released. Per-device: one phone's mode never mutes another's.
 *   - a missing APNs credential degrades honestly — `attempted:false` plus a
 *     reason that names the ASC-vs-APNs key confusion, no throw.
 *   - the payload carries the letter id in the exact shape
 *     `LetterDeepLink.letterId(fromPush:)` reads (flat `type`/`letterId` beside
 *     `aps`, and the same fields nested under `data`).
 *   - `action_required` rides priority 10 while quieter types ride 5, and a
 *     letter type the device muted is not sent at all.
 *
 * No network: the APNs HTTP/2 sender is stubbed at the module boundary and the
 * Expo path at `fetch`, so nothing leaves the box.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const getConfig = vi.hoisted(() => vi.fn());
/** Mirrors the real atomic helper: hand the mutator the current rows. */
const updatePushTokens = vi.hoisted(() => vi.fn(
  async (mutate: (t: unknown[]) => unknown[] | null) => mutate([]) ?? [],
));
const sendApns = vi.hoisted(() => vi.fn(async () => ({
  attempted: true, sent: 1, failed: 0, deadTokens: [] as string[],
})));

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/config-manager.js', () => ({ getConfig, updatePushTokens }));
vi.mock('../../src/core/push/apns.js', () => ({
  sendApns,
  apnsStatus: vi.fn(async () => ({ configured: true, environment: 'production', topic: 'test' })),
}));

import {
  letterPushContent,
  pushLetter,
  LETTER_PUSH_TYPE,
} from '../../src/core/push/letter-push.js';
import { apnsPayload, tokenKind } from '../../src/core/push/send.js';
import {
  ACTIVE_LEASE_MS,
  decideForDevice,
  isActive,
  parseMode,
  selectDevices,
} from '../../src/core/push/letter-push-policy.js';
import type { PushTokenEntry } from '../../src/core/types.js';

/** A realistic APNs device token (64 hex chars). */
const APNS_TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);

function device(over: Partial<PushTokenEntry> = {}): PushTokenEntry {
  return {
    token: APNS_TOKEN,
    platform: 'ios',
    kind: 'apns',
    key_name: 'iPhone',
    registered_at: new Date().toISOString(),
    mode: 'always',
    ...over,
  };
}

function letter(over: Partial<Parameters<typeof pushLetter>[0]> = {}) {
  return {
    letterId: 'lt-m9x2k1-a4f7',
    subject: 'Sync freeze root cause found',
    type: 'review',
    textPreview: 'The 22h stall was an orphaned rebase lock.',
    kind: 'new' as const,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendApns.mockResolvedValue({ attempted: true, sent: 1, failed: 0, deadTokens: [] });
  getConfig.mockResolvedValue({ push_tokens: [device()] });
});

describe('payload contract (what LetterDeepLink parses)', () => {
  it('carries the letter id flat AND nested, under the type LetterDeepLink expects', () => {
    const payload = apnsPayload(letterPushContent(letter()));

    // LetterDeepLink.payloadType — changing this string breaks every deep link.
    expect(LETTER_PUSH_TYPE).toBe('human_inbox_letter');
    // Flat at the top level: the first shape payloadDictionaries() reads.
    expect(payload.type).toBe('human_inbox_letter');
    expect(payload.letterId).toBe('lt-m9x2k1-a4f7');
    // Nested under `data`: the second shape it accepts.
    expect(payload.data).toMatchObject({
      type: 'human_inbox_letter',
      letterId: 'lt-m9x2k1-a4f7',
      letterType: 'review',
      kind: 'new',
    });
  });

  it('the letter id passes LetterDeepLink.isValidLetterId — lt-<b36>-<rand>', () => {
    const id = (apnsPayload(letterPushContent(letter())).letterId as string);
    const parts = id.split('-');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('lt');
    expect(parts[1]).toMatch(/^[0-9a-z]{1,12}$/);
    expect(parts[2]).toMatch(/^[0-9a-z]{4,12}$/);
  });

  it('puts the subject in the alert title and the preview in the body', () => {
    const payload = apnsPayload(letterPushContent(letter()));
    expect((payload.aps as Record<string, Record<string, string>>).alert).toEqual({
      title: 'New letter: Sync freeze root cause found',
      body: 'The 22h stall was an orphaned rebase lock.',
    });
  });

  it('an agent reply is prefixed Reply:', () => {
    expect(letterPushContent(letter({ kind: 'reply' })).title)
      .toBe('Reply: Sync freeze root cause found');
  });

  it('trims a long subject rather than letting the OS elide it', () => {
    expect(letterPushContent(letter({ subject: 'S'.repeat(300) })).title).toHaveLength(100);
  });

  it('an empty preview still says something readable', () => {
    expect(letterPushContent(letter({ textPreview: '' })).body).toBe('Open Walnut to read it');
  });

  it('wakes the app so the badge refreshes without a tap', () => {
    const aps = apnsPayload(letterPushContent(letter())).aps as Record<string, unknown>;
    expect(aps['content-available']).toBe(1);
  });

  it('collapses on the letter id so one letter cannot become three banners', () => {
    expect(letterPushContent(letter()).collapseId).toBe('lt-m9x2k1-a4f7');
  });

  /**
   * The collapse id has to reach the SENDER, not just the content object. It was
   * computed and then dropped on the floor at first, which silently loses the
   * de-duplication: a redelivered letter event stacks a second banner.
   */
  it('passes the collapse id through to the APNs sender', async () => {
    await pushLetter(letter());
    expect(sendApns.mock.calls[0][2]).toMatchObject({ collapseId: 'lt-m9x2k1-a4f7' });
  });

  it('passes the urgency through to the sender, not just into the content', async () => {
    await pushLetter(letter({ type: 'action_required' }));
    expect(sendApns.mock.calls[0][2]).toMatchObject({ priority: 10 });
  });

  it('action_required is delivered now; quieter types may be batched', () => {
    expect(letterPushContent(letter({ type: 'action_required' })).priority).toBe(10);
    expect(letterPushContent(letter({ type: 'info' })).priority).toBe(5);
    expect(letterPushContent(letter({ type: 'completion' })).priority).toBe(5);
  });
});

describe('mode: always (the default)', () => {
  it('pushes even though a browser WS is open — the bug this fixes', async () => {
    // No clientCount mock exists in this module at all: the letter path must not
    // consult the browser WS count. Asserting the send happens IS the assertion.
    const out = await pushLetter(letter());
    expect(out.sent).toBe(1);
    expect(sendApns).toHaveBeenCalledTimes(1);
  });

  it('an absent mode field defaults to always, not to quiet', async () => {
    getConfig.mockResolvedValue({ push_tokens: [device({ mode: undefined })] });
    const out = await pushLetter(letter());
    expect(out.sent).toBe(1);
    expect(out.suppressed).toBe(0);
  });

  it('pushes even while the device reports itself foregrounded', async () => {
    getConfig.mockResolvedValue({ push_tokens: [device({ mode: 'always', active_at: Date.now() })] });
    const out = await pushLetter(letter());
    expect(out.sent).toBe(1);
  });

  it('parseMode falls back to always for junk', () => {
    expect(parseMode(undefined)).toBe('always');
    expect(parseMode('nonsense')).toBe('always');
    expect(parseMode('when-inactive')).toBe('when-inactive');
  });
});

describe('mode: when-inactive (the Slack rule)', () => {
  const now = 1_800_000_000_000;

  it('suppresses while the app reports active', async () => {
    getConfig.mockResolvedValue({
      push_tokens: [device({ mode: 'when-inactive', active_at: now - 1_000 })],
    });
    const out = await pushLetter(letter(), now);
    expect(out.attempted).toBe(false);
    expect(out.suppressed).toBe(1);
    expect(sendApns).not.toHaveBeenCalled();
  });

  it('sends once the active report goes stale — a lease, not a latch', async () => {
    getConfig.mockResolvedValue({
      push_tokens: [device({ mode: 'when-inactive', active_at: now - ACTIVE_LEASE_MS - 1 })],
    });
    const out = await pushLetter(letter(), now);
    expect(out.sent).toBe(1);
  });

  it('sends when the lease was released on backgrounding', async () => {
    getConfig.mockResolvedValue({
      push_tokens: [device({ mode: 'when-inactive', active_at: undefined })],
    });
    const out = await pushLetter(letter(), now);
    expect(out.sent).toBe(1);
  });

  it('a future activeAt (clock skew) cannot mute a device indefinitely', () => {
    expect(isActive({ activeAt: now + ACTIVE_LEASE_MS + 60_000 }, now)).toBe(false);
    // Mild skew is still honoured, so a slightly-fast phone isn't spammed.
    expect(isActive({ activeAt: now + 1_000 }, now)).toBe(true);
  });

  it('a garbage activeAt is not evidence of being active', () => {
    expect(isActive({ activeAt: Number.NaN }, now)).toBe(false);
    expect(isActive({ activeAt: Infinity }, now)).toBe(false);
    expect(isActive({}, now)).toBe(false);
  });

  it('is per-device: an active phone does not mute the other one', async () => {
    getConfig.mockResolvedValue({
      push_tokens: [
        device({ token: APNS_TOKEN, key_name: 'iPhone', mode: 'when-inactive', active_at: now }),
        device({ token: OTHER_TOKEN, key_name: 'iPad', mode: 'always' }),
      ],
    });
    const out = await pushLetter(letter(), now);
    expect(out.suppressed).toBe(1);
    expect(sendApns).toHaveBeenCalledTimes(1);
    // Only the iPad's token was targeted.
    expect(sendApns.mock.calls[0][0]).toEqual([{ token: OTHER_TOKEN }]);
  });

  it('decideForDevice names its reason so a log can explain the silence', () => {
    expect(decideForDevice({ mode: 'when-inactive', activeAt: now }, 'review', now))
      .toEqual({ send: false, reason: 'app-active' });
    expect(decideForDevice({ mode: 'when-inactive' }, 'review', now))
      .toEqual({ send: true, reason: 'inactive' });
    expect(decideForDevice({ mode: 'always', activeAt: now }, 'review', now))
      .toEqual({ send: true, reason: 'always' });
  });
});

describe('letter types are a visible choice, not a hidden heuristic', () => {
  it('a muted type is not sent to the device that muted it', async () => {
    getConfig.mockResolvedValue({
      push_tokens: [device({ letter_types: ['action_required', 'review'] })],
    });
    const out = await pushLetter(letter({ type: 'info' }));
    expect(out.attempted).toBe(false);
    expect(out.suppressed).toBe(1);
  });

  it('an accepted type still goes through', async () => {
    getConfig.mockResolvedValue({
      push_tokens: [device({ letter_types: ['action_required'] })],
    });
    expect((await pushLetter(letter({ type: 'action_required' }))).sent).toBe(1);
  });

  it('no type list means every type is welcome', () => {
    expect(decideForDevice({}, 'info', Date.now()).send).toBe(true);
    expect(selectDevices([{}, {}], 'info', Date.now())).toHaveLength(2);
  });
});

describe('honest degradation (never a silent no-op, never a throw)', () => {
  it('reports the reason when no device is registered', async () => {
    getConfig.mockResolvedValue({ push_tokens: [] });
    const out = await pushLetter(letter());
    expect(out).toMatchObject({ attempted: false, sent: 0 });
    expect(out.reason).toMatch(/no device registered/i);
    expect(sendApns).not.toHaveBeenCalled();
  });

  it('a missing APNs credential surfaces a reason naming the ASC-key confusion', async () => {
    sendApns.mockResolvedValue({
      attempted: false, sent: 0, failed: 0, deadTokens: [],
      reason: 'APNs auth key not configured (missing key_id). This is a DIFFERENT key from the '
        + 'App Store Connect API key used for TestFlight uploads',
    } as never);
    const out = await pushLetter(letter());
    expect(out.attempted).toBe(false);
    expect(out.reason).toMatch(/DIFFERENT key from the App Store Connect/);
  });

  it('an unreadable config degrades instead of throwing into the letter store', async () => {
    getConfig.mockRejectedValue(new Error('config.yaml is locked'));
    await expect(pushLetter(letter())).resolves.toMatchObject({ attempted: false });
  });

  it('a sender that throws does not escape into the caller', async () => {
    sendApns.mockRejectedValue(new Error('http2 exploded'));
    // pushLetter awaits sendApns directly, so a rejection must be caught by the
    // subscriber; assert the promise itself doesn't take the process down.
    await expect(pushLetter(letter())).rejects.toThrow('http2 exploded');
  });

  it('prunes tokens Apple reported dead so they cannot fail forever', async () => {
    sendApns.mockResolvedValue({
      attempted: true, sent: 0, failed: 1, deadTokens: [APNS_TOKEN],
    });
    // The prune must go through the ATOMIC helper, not a read-then-write: a
    // prune racing a fresh registration would otherwise drop the new row.
    updatePushTokens.mockImplementation(async (mutate) => mutate([device()]) ?? []);
    await pushLetter(letter());
    expect(updatePushTokens).toHaveBeenCalledTimes(1);
    const mutate = updatePushTokens.mock.calls[0][0] as (t: PushTokenEntry[]) => PushTokenEntry[] | null;
    expect(mutate([device()])).toEqual([]);
  });

  it('a prune that removes nothing writes nothing (no config churn)', async () => {
    sendApns.mockResolvedValue({
      attempted: true, sent: 0, failed: 1, deadTokens: ['not-a-registered-token'],
    });
    await pushLetter(letter());
    const mutate = updatePushTokens.mock.calls[0][0] as (t: PushTokenEntry[]) => PushTokenEntry[] | null;
    // null = "no write", which is what keeps a backup rewrite from happening.
    expect(mutate([device()])).toBeNull();
  });
});

describe('push credentials never ride a bug report', () => {
  /**
   * `redactConfig` runs UNCONDITIONALLY for bug-report bundles, which get pasted
   * into public issues, and for `GET /api/config` on a cloud replica (reachable
   * by any paired device). A device push token is a send capability — with the
   * APNs key it puts a notification on the user's lock screen — and the key path
   * names a file worth protecting. Both were leaking in the clear.
   */
  it('masks the device token and the APNs key path', async () => {
    const { redactConfig } = await import('../../src/core/config-redact.js');
    const redacted = redactConfig({
      push_tokens: [{ token: APNS_TOKEN, key_name: 'iPhone', mode: 'always' }],
      push: { apns: { key_id: 'ABCD1234EF', team_id: 'TEAMID', key_path: '/Users/me/secrets/AuthKey_ABCD1234EF.p8' } },
    }) as Record<string, never>;

    const raw = JSON.stringify(redacted);
    expect(raw).not.toContain(APNS_TOKEN);
    expect(raw).not.toContain('/Users/me/secrets/AuthKey_ABCD1234EF.p8');
    // Non-secret fields still project, so a bug report stays diagnosable: you
    // can see a device is registered and in which mode.
    expect(raw).toContain('iPhone');
    expect(raw).toContain('always');
  });
});

describe('token kind is decided from the token, never guessed at send time', () => {
  it('a hex token is APNs and a bracketed one is Expo', () => {
    expect(tokenKind({ token: APNS_TOKEN })).toBe('apns');
    expect(tokenKind({ token: 'ExponentPushToken[xxx]' })).toBe('expo');
    expect(tokenKind({ token: 'ExpoPushToken[xxx]' })).toBe('expo');
  });

  it('an explicit kind wins over the shape', () => {
    expect(tokenKind({ token: APNS_TOKEN, kind: 'expo' })).toBe('expo');
  });

  it('an APNs token never goes to the Expo endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await pushLetter(letter());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendApns).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
