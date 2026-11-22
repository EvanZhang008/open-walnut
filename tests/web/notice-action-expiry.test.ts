/**
 * A notice's button can say until when it means something (`expiresAt`, epoch ms), and once that
 * moment has passed no surface offers it (2026-11-21 audit: a "Focus block done, 10 min break"
 * notice still offered End break and Another block 23 hours later, as if the break were on).
 *
 *   - the wire keeps `expiresAt` only when it is a real moment; an older record has none and keeps
 *     every button;
 *   - displayActionsOf (the one list both the toast and the panel's row render) leaves out an
 *     expired button, and never falls back to the older single `action` when every listed one expired;
 *   - the plugin host carries a plugin's `expiresAt` onto the host button and refuses a bad one;
 *   - Rhythm's break notice sets it to the break's end on both its buttons.
 */
import { describe, expect, it } from 'vitest';
import {
  actionExpired, displayActionsOf, nextActionExpiry, wireActionsOf,
} from '../../web/src/contexts/notifications/notification-actions';
import { pluginNoticeActions } from '../../src/core/plugins/plugin-notifications';
import { focusDoneNotice, breakOverNotice } from '../../plugin-store/walnut-rhythm/src/server/notices';

const NOW = 1_800_000_000_000;
const op = (label: string, expiresAt?: unknown) => ({
  kind: 'op', label, pluginId: 'walnut-rhythm', op: `walnut_rhythm_${label.toLowerCase().replace(/\s+/g, '_')}`,
  ...(expiresAt !== undefined ? { expiresAt } : {}),
});

describe('a notice button\'s expiry', () => {
  it('the wire keeps a real moment and drops anything else; an older record has none', () => {
    const [kept, junk, none] = wireActionsOf([op('End break', NOW), op('Junk', 'soon'), op('Plain')]);
    const [negative] = wireActionsOf([op('Neg', -5)]);
    expect(kept.expiresAt).toBe(NOW);
    expect('expiresAt' in junk!).toBe(false);
    expect('expiresAt' in none!).toBe(false);
    expect('expiresAt' in negative!).toBe(false);
  });

  it('an expired button is left out; one without expiry never expires', () => {
    const actions = wireActionsOf([op('End break', NOW - 1), op('Another block', NOW + 60_000), op('Plain')]);
    expect(displayActionsOf({ actions }, NOW).map((a) => a.label)).toEqual(['Another block', 'Plain']);
    expect(displayActionsOf({ actions }, NOW + 120_000).map((a) => a.label)).toEqual(['Plain']);
    expect(actionExpired({ expiresAt: NOW }, NOW)).toBe(true);
    expect(actionExpired({}, NOW)).toBe(false);
  });

  it('every listed button expired: the notice offers none (it reads as history), never the single action', () => {
    const actions = wireActionsOf([op('End break', NOW - 1), op('Another block', NOW - 1)]);
    expect(displayActionsOf({ actions, action: actions[0] }, NOW)).toEqual([]);
    // The single action alone expires the same way.
    expect(displayActionsOf({ action: { label: 'Go', kind: 'navigate', to: '/x', expiresAt: NOW - 1 } }, NOW)).toEqual([]);
    // An older record (no expiresAt anywhere) keeps every button, whatever the clock says.
    const old = wireActionsOf([op('Done'), op('Snooze')]);
    expect(displayActionsOf({ actions: old }, NOW + 10 ** 12).map((a) => a.label)).toEqual(['Done', 'Snooze']);
  });

  it('the next expiry is the soonest one still ahead, so an open panel drops it on time', () => {
    const actions = wireActionsOf([op('A', NOW + 5_000), op('B', NOW + 1_000), op('C', NOW - 1), op('D')]);
    expect(nextActionExpiry({ actions }, NOW)).toBe(NOW + 1_000);
    expect(nextActionExpiry({ actions: wireActionsOf([op('D')]) }, NOW)).toBeNull();
  });

  it('the plugin host carries a plugin\'s expiresAt onto its button, and refuses one that is not a moment', () => {
    const [btn] = pluginNoticeActions('walnut-rhythm', [{ label: 'End break', op: 'break_skip', expiresAt: NOW }])!;
    expect(btn).toMatchObject({ kind: 'op', label: 'End break', expiresAt: NOW });
    const [plain] = pluginNoticeActions('walnut-rhythm', [{ label: 'Done', op: 'done' }])!;
    expect('expiresAt' in plain!).toBe(false);
    expect(() => pluginNoticeActions('walnut-rhythm', [{ label: 'X', op: 'x', expiresAt: Number.NaN }])).toThrow(/expiresAt/);
    expect(() => pluginNoticeActions('walnut-rhythm', [{ label: 'X', op: 'x', expiresAt: '1' as unknown as number }])).toThrow(/expiresAt/);
  });

  it('Rhythm\'s break notice: both buttons end with the break; the break-over question has no clock', () => {
    const block = { startedAt: NOW - 45 * 60_000, endedAt: NOW, minutes: 45, breakMinutes: 10 };
    const done = focusDoneNotice(block, 'short', 10, NOW + 10 * 60_000);
    expect(done.actions!.map((a) => [a.label, a.expiresAt])).toEqual([['End break', NOW + 600_000], ['Another block', NOW + 600_000]]);
    // 23 hours later the row shows no button that only applied to that break.
    const actions = wireActionsOf(pluginNoticeActions('walnut-rhythm', done.actions));
    expect(displayActionsOf({ actions }, NOW + 23 * 3_600_000)).toEqual([]);
    expect(displayActionsOf({ actions }, NOW + 60_000).map((a) => a.label)).toEqual(['End break', 'Another block']);
    const over = breakOverNotice({ minutes: 45, breakMinutes: 10 });
    expect(over.actions!.every((a) => a.expiresAt === undefined)).toBe(true);
  });
});
