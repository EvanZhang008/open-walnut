import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let data: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  data = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
});

afterEach(() => vi.unstubAllGlobals());

async function store() { return import('../../web/src/components/calendar/calendar-grid-settings'); }

describe('calendar time scale preferences', () => {
  it('persists both scale and full-day choice without replacing the other field', async () => {
    const { setCalendarGridSettings, GRID_SETTINGS_KEY } = await store();
    setCalendarGridSettings({ zoom: 1.5 });
    expect(JSON.parse(data.get(GRID_SETTINGS_KEY)!)).toEqual({ zoom: 1.5, fullDay: false });
    setCalendarGridSettings({ fullDay: true });
    expect(JSON.parse(data.get(GRID_SETTINGS_KEY)!)).toEqual({ zoom: 1.5, fullDay: true });
  });
  it.each(['garbage', 'null', '{"zoom":999,"fullDay":false}', '{"zoom":1,"fullDay":"no"}'])(
    'recovers from invalid stored settings %s', async (raw) => {
      const { setCalendarGridSettings, GRID_SETTINGS_KEY } = await store();
      data.set(GRID_SETTINGS_KEY, raw);
      setCalendarGridSettings({ fullDay: true });
      expect(JSON.parse(data.get(GRID_SETTINGS_KEY)!)).toEqual({ zoom: 1, fullDay: true });
    },
  );
  it('uses the previous scale after a new module reads the stored value', async () => {
    const initial = await store();
    initial.setCalendarGridSettings({ zoom: 2, fullDay: true });
    vi.resetModules();
    const next = await store();
    next.setCalendarGridSettings({ fullDay: false });
    expect(JSON.parse(data.get(next.GRID_SETTINGS_KEY)!)).toEqual({ zoom: 2, fullDay: false });
  });
  it('continues working when storage writes fail', async () => {
    const { setCalendarGridSettings } = await store();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => { throw new Error('Unavailable'); } });
    expect(() => setCalendarGridSettings({ zoom: 2 })).not.toThrow();
  });
});
