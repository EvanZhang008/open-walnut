import { describe, expect, it } from 'vitest';
import { GRID_ZOOM_LEVELS, fittedSlotPx, gridSnapMinute, gridMinute, gridY, gridLocalIso } from '../../web/src/components/calendar/calendar-grid-settings';

describe('calendar grid coordinates', () => {
  it('round-trips every quarter hour at every zoom and both visible ranges', () => {
    for (const zoom of GRID_ZOOM_LEVELS) {
      for (const start of [0, 420]) {
        for (let minute = start; minute <= 1860; minute += 15) {
          expect(gridMinute(gridY(minute, start, 24 * zoom), start, 24 * zoom)).toBe(minute);
        }
      }
    }
  });
  it('fits eighteen hours to every viewport and allows snapping past midnight', () => {
    for (const height of [400, 800, 1400]) {
      expect(fittedSlotPx(height, 1) * 36).toBeCloseTo(height - 12);
      expect(fittedSlotPx(height, 2)).toBeCloseTo(fittedSlotPx(height, 1) * 2);
    }
    expect(gridSnapMinute(1480, 15, 1860)).toBe(1485);
    expect(gridSnapMinute(2000, 30, 1860)).toBe(1830);
  });
  it('formats midnight as the next local day, including month and year boundaries', () => {
    expect(gridLocalIso('2026-10-08', 1380)).toBe('2026-10-08T23:00:00');
    expect(gridLocalIso('2026-10-31', 1440)).toBe('2026-11-01T00:00:00');
    expect(gridLocalIso('2026-12-31', 1440)).toBe('2027-01-01T00:00:00');
    expect(gridLocalIso('2026-12-31', 1500)).toBe('2027-01-01T01:00:00');
    expect(gridLocalIso('2027-01-01', -30)).toBe('2026-12-31T23:30:00');
  });
  it('maps offsets independently of the visible window', () => {
    expect(gridY(420, 420, 24)).toBe(0);
    expect(gridY(1380, 420, 24)).toBe(768);
    expect(gridMinute(96, 420, 24)).toBe(540);
    expect(gridMinute(192, 420, 48)).toBe(540);
  });
});
