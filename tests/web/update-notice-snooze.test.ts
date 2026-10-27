/**
 * The update notice's ×: 30 minutes of quiet whatever lands, then only a newer update.
 */
import { describe, expect, it } from 'vitest';
import { isSnoozed, parseSnooze, SNOOZE_MS } from '@/components/common/update-notice-snooze';

const T = 1_800_000_000_000;

describe('update notice snooze', () => {
  it('hides every update while the 30 minutes run', () => {
    const s = { identity: 'web:a', until: T + SNOOZE_MS };
    expect(isSnoozed(s, 'web:a', T)).toBe(true);
    expect(isSnoozed(s, 'web:b', T + SNOOZE_MS - 1)).toBe(true);
    expect(isSnoozed(s, 'app:1:2:3', T + 60_000)).toBe(true);
  });

  it('after them shows a newer update and keeps the dismissed one hidden', () => {
    const s = { identity: 'web:a', until: T + SNOOZE_MS };
    expect(isSnoozed(s, 'web:b', T + SNOOZE_MS)).toBe(false);
    expect(isSnoozed(s, 'web:a', T + SNOOZE_MS * 10)).toBe(true);
  });

  it('nothing dismissed hides nothing', () => {
    expect(isSnoozed(null, 'web:a', T)).toBe(false);
  });

  it('a clock set back far past the snooze does not hide a newer update for days', () => {
    const s = { identity: 'web:a', until: T + SNOOZE_MS };
    expect(isSnoozed(s, 'web:b', T - 3 * 86_400_000)).toBe(false);
    expect(isSnoozed(s, 'web:a', T - 3 * 86_400_000)).toBe(true);
  });

  it('reads only a well-formed record', () => {
    expect(parseSnooze(null)).toBeNull();
    expect(parseSnooze('not json')).toBeNull();
    expect(parseSnooze('{"identity":"x"}')).toBeNull();
    expect(parseSnooze('{"identity":"x","until":"soon"}')).toBeNull();
    expect(parseSnooze(JSON.stringify({ identity: 'x', until: T }))).toEqual({ identity: 'x', until: T });
  });
});
