import { describe, expect, it } from 'vitest';
import { GRID_ZOOM_LEVELS, gridMinute, gridY, gridLocalIso } from '../../web/src/components/calendar/calendar-grid-settings';

describe('calendar grid coordinates', () => {
  it('round-trips every quarter hour at every zoom and both visible ranges', () => {
    for (const zoom of GRID_ZOOM_LEVELS) {
      for (const start of [0, 420]) {
        for (let minute = start; minute <= 1380; minute += 15) {
          expect(gridMinute(gridY(minute, start, 24 * zoom), start, 24 * zoom)).toBe(minute);
        }
      }
    }
  });
  it('formats midnight as the next local day, including month and year boundaries', () => {
    expect(gridLocalIso('2026-10-08', 1380)).toBe('2026-10-08T23:00:00');
    expect(gridLocalIso('2026-10-31', 1440)).toBe('2026-11-01T00:00:00');
    expect(gridLocalIso('2026-12-31', 1440)).toBe('2027-01-01T00:00:00');
  });
  it('places 7 AM at the origin and 11 PM at the end of the default range', () => {
    expect(gridY(420, 420, 24)).toBe(0);
    expect(gridY(1380, 420, 24)).toBe(768);
    expect(gridMinute(96, 420, 24)).toBe(540);
    expect(gridMinute(192, 420, 48)).toBe(540);
  });
});
