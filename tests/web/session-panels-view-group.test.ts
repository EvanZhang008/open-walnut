import { describe, it, expect, vi } from 'vitest';
import { sessionPanelsViewGroup } from '../../web/src/components/tasks/session-panels-view-group';
import type { ViewChoiceRow } from '../../web/src/components/tasks/ViewDropdown';

/**
 * The task panel filter menu's "Session panels" row. It is a readout as much as a control:
 * the current count is the one checked value, and under Auto it says how many panels Auto
 * means in this window right now (the home page publishes that count; before it has, the
 * row just says Auto rather than inventing a number).
 */
const row = (group: ReturnType<typeof sessionPanelsViewGroup>) => group.options[0] as ViewChoiceRow;

describe('sessionPanelsViewGroup', () => {
  it('offers 1 to 5 and Auto, with exactly the current count checked', () => {
    const r = row(sessionPanelsViewGroup('3', 3, vi.fn()));
    expect(r.choices.map((c) => c.label)).toEqual(['1', '2', '3', '4', '5', 'Auto']);
    expect(r.choices.filter((c) => c.active).map((c) => c.key)).toEqual(['3']);
  });

  it('names the live count on Auto only while Auto is the setting', () => {
    expect(row(sessionPanelsViewGroup('auto', 2, vi.fn())).choices.at(-1)).toMatchObject({ label: 'Auto (2)', active: true });
    expect(row(sessionPanelsViewGroup('auto', null, vi.fn())).choices.at(-1)).toMatchObject({ label: 'Auto', active: true });
    expect(row(sessionPanelsViewGroup('2', 2, vi.fn())).choices.at(-1)).toMatchObject({ label: 'Auto', active: false });
  });

  it('writes a new value, and writes nothing when the current one is picked again', () => {
    const setMode = vi.fn();
    const r = row(sessionPanelsViewGroup('2', 2, setMode));
    r.choices.find((c) => c.key === '2')!.onSelect();
    expect(setMode).not.toHaveBeenCalled();
    r.choices.find((c) => c.key === '4')!.onSelect();
    r.choices.find((c) => c.key === 'auto')!.onSelect();
    expect(setMode.mock.calls).toEqual([['4'], ['auto']]);
  });
});
