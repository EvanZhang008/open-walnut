/**
 * The rail's plugin status items, pure side (web/src/components/layout/status-item-model.ts):
 * the wire list degrades instead of throwing, and the ring, its centre text and the title's
 * `{remaining}` all tick from the timer alone.
 */
import { describe, it, expect } from 'vitest';
import {
  formatRemaining, itemTitle, orderedActions, remainingMs, ringFraction, ringText, statusItemsOf,
} from '../../web/src/components/layout/status-item-model';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 9, 0, 0);

const wire = (overrides: Record<string, unknown> = {}) => ({
  key: 'walnut-rhythm:rhythm', pluginId: 'walnut-rhythm', pluginName: 'Rhythm', id: 'rhythm',
  title: 'Stand up in {remaining}', tone: 'neutral',
  timer: { startedAt: T0, endsAt: T0 + 60 * MIN, mode: 'fill' },
  actions: [
    { kind: 'op', label: 'Snooze 10 min', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_snooze', args: { minutes: 10 } },
    { kind: 'op', label: 'Stand up now', pluginId: 'walnut-rhythm', op: 'walnut_rhythm_break_done', primary: true },
  ],
  ...overrides,
});

describe('statusItemsOf', () => {
  it('reads a good list', () => {
    const [item] = statusItemsOf({ items: [wire()] });
    expect(item).toMatchObject({ key: 'walnut-rhythm:rhythm', tone: 'neutral', timer: { mode: 'fill' } });
    expect(item!.actions.map((a) => a.primary)).toEqual([false, true]);
  });

  it('degrades: no list, junk rows, unknown tone and glyph, a broken timer, a duplicate key', () => {
    expect(statusItemsOf(null)).toEqual([]);
    expect(statusItemsOf({ items: 'nope' })).toEqual([]);
    const items = statusItemsOf({
      items: [
        wire({ tone: 'neon', glyph: 'rocket', timer: { startedAt: T0, endsAt: T0 - 1 } }),
        wire({ title: 'duplicate' }),
        { key: 'x' },
        'junk',
        wire({ key: 'b:b', pluginId: 'b', actions: [{ kind: 'navigate', label: 'Go', to: '/' }, { kind: 'op', label: '', pluginId: 'b', op: 'x' }] }),
      ],
    });
    expect(items.map((one) => one.key)).toEqual(['walnut-rhythm:rhythm', 'b:b']);
    expect(items[0]).toMatchObject({ tone: 'neutral' });
    expect(items[0]!.glyph).toBeUndefined();
    expect(items[0]!.timer).toBeUndefined();
    expect(items[1]!.actions).toEqual([]);
  });
});

describe('the clock', () => {
  const fill = statusItemsOf({ items: [wire()] })[0]!;
  const drain = statusItemsOf({ items: [wire({ timer: { startedAt: T0, endsAt: T0 + 25 * MIN } })] })[0]!;

  it('fill grows toward the end, drain shrinks toward it, both clamp', () => {
    expect(ringFraction(fill, T0 + 15 * MIN)).toBeCloseTo(0.25);
    expect(ringFraction(drain, T0 + 5 * MIN)).toBeCloseTo(0.8);
    expect(ringFraction(fill, T0 - MIN)).toBe(0);
    expect(ringFraction(fill, T0 + 99 * MIN)).toBe(1);
    expect(ringFraction(drain, T0 + 99 * MIN)).toBe(0);
    expect(ringFraction({ timer: undefined }, T0)).toBe(1);
  });

  it('minutes left round up, and the centre shows hours past an hour', () => {
    expect(remainingMs(fill, T0 + 59 * MIN + 30_000)).toBe(30_000);
    expect(ringText(fill, T0 + 59 * MIN + 30_000)).toBe('1');
    expect(ringText(fill, T0 + 12 * MIN)).toBe('48');
    expect(ringText(fill, T0 + 60 * MIN)).toBe('0');
    const long = statusItemsOf({ items: [wire({ timer: { startedAt: T0, endsAt: T0 + 150 * MIN } })] })[0]!;
    expect(ringText(long, T0)).toBe('3h');
    expect(ringText({ ...fill, glyph: 'stand' }, T0)).toBe('');
  });

  it('formats the remaining time for words', () => {
    expect(formatRemaining(0)).toBe('0 min');
    expect(formatRemaining(1)).toBe('1 min');
    expect(formatRemaining(12 * MIN)).toBe('12 min');
    expect(formatRemaining(60 * MIN)).toBe('1 h');
    expect(formatRemaining(65 * MIN)).toBe('1 h 5 min');
  });

  it('fills {remaining} in the title, and drops it when there is no timer', () => {
    expect(itemTitle(fill, T0 + 12 * MIN)).toBe('Stand up in 48 min');
    expect(itemTitle({ title: 'Focus · {remaining} left', timer: drain.timer }, T0 + 20 * MIN)).toBe('Focus · 5 min left');
    expect(itemTitle({ title: 'Paused {remaining}', timer: undefined }, T0)).toBe('Paused');
    expect(itemTitle({ title: 'Time to stand up', timer: undefined }, T0)).toBe('Time to stand up');
  });
});

describe('orderedActions', () => {
  it('puts the primary first and keeps the rest in order', () => {
    const [item] = statusItemsOf({ items: [wire()] });
    expect(orderedActions(item!).map((a) => a.label)).toEqual(['Stand up now', 'Snooze 10 min']);
  });
});
