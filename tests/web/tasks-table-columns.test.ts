/**
 * /tasks column model (web/src/components/tasks/tasks-table-columns.ts).
 * Pure logic — no React mount.
 */
import { describe, it, expect } from 'vitest';
import {
  TP_COLUMNS,
  TP_DEFAULT_COLUMNS,
  parseColumns,
  serializeColumns,
  toggleColumn,
  visibleColumns,
  offerColumns,
  gridTemplate,
  formatTableTime,
  type TpColumnId,
} from '../../web/src/components/tasks/tasks-table-columns';

const ALL_IDS = TP_COLUMNS.map((c) => c.id);

describe('parseColumns', () => {
  it('nothing stored → the shipped default layout', () => {
    expect(parseColumns(null)).toEqual(TP_DEFAULT_COLUMNS);
    expect(parseColumns(undefined)).toEqual(TP_DEFAULT_COLUMNS);
    expect(parseColumns('')).toEqual(TP_DEFAULT_COLUMNS);
  });

  it('malformed or non-array values fall back to the default instead of throwing', () => {
    expect(parseColumns('{not json')).toEqual(TP_DEFAULT_COLUMNS);
    expect(parseColumns('"due"')).toEqual(TP_DEFAULT_COLUMNS);
    expect(parseColumns('{"due":true}')).toEqual(TP_DEFAULT_COLUMNS);
  });

  it('unknown ids are dropped, duplicates collapse, order is normalized to display order', () => {
    // A column retired in a later build must not wedge the whole choice.
    expect(parseColumns(JSON.stringify(['updated', 'bogus', 'due', 'due', 42, 'priority'])))
      .toEqual(['priority', 'due', 'updated']);
  });

  it('an explicit empty array means "Title only" and is honoured, not defaulted', () => {
    expect(parseColumns('[]')).toEqual([]);
  });

  it('round-trips through serializeColumns', () => {
    const chosen: TpColumnId[] = ['phase', 'created', 'completed'];
    expect(parseColumns(serializeColumns(chosen))).toEqual(chosen);
  });
});

describe('toggleColumn', () => {
  it('adds a missing column in display order and removes a present one', () => {
    const base: TpColumnId[] = ['due', 'session'];
    expect(toggleColumn(base, 'priority')).toEqual(['priority', 'due', 'session']);
    expect(toggleColumn(base, 'completed')).toEqual(['due', 'session', 'completed']);
    expect(toggleColumn(base, 'due')).toEqual(['session']);
  });

  it('can turn every optional column off', () => {
    let cols: TpColumnId[] = [...TP_DEFAULT_COLUMNS];
    for (const id of TP_DEFAULT_COLUMNS) cols = toggleColumn(cols, id);
    expect(cols).toEqual([]);
  });
});

describe('visibleColumns', () => {
  it('the default choice in the All Tasks view is exactly the pre-chooser layout', () => {
    const vis = visibleColumns(TP_DEFAULT_COLUMNS, { isAll: true, showPriority: true });
    expect(vis.map((c) => c.label)).toEqual(['Priority', 'Due', 'Session', 'Project']);
  });

  it('Project is only drawn in the All Tasks view', () => {
    const vis = visibleColumns(TP_DEFAULT_COLUMNS, { isAll: false, showPriority: true });
    expect(vis.map((c) => c.id)).toEqual(['priority', 'due', 'session']);
  });

  it('Priority follows the app-wide show_priority flag even when chosen', () => {
    const vis = visibleColumns(TP_DEFAULT_COLUMNS, { isAll: true, showPriority: false });
    expect(vis.map((c) => c.id)).toEqual(['due', 'session', 'project']);
  });

  it('every column can be shown at once, in display order', () => {
    const vis = visibleColumns(ALL_IDS, { isAll: true, showPriority: true });
    expect(vis.map((c) => c.id)).toEqual(ALL_IDS);
  });
});

describe('offerColumns', () => {
  it('lists Project only in All Tasks, and greys Priority out (with a reason) when the flag is off', () => {
    const all = offerColumns(TP_DEFAULT_COLUMNS, { isAll: true, showPriority: true });
    expect(all.map((o) => o.def.id)).toEqual(ALL_IDS);
    expect(all.every((o) => !o.disabledReason)).toBe(true);
    expect(all.filter((o) => o.checked).map((o) => o.def.id)).toEqual(TP_DEFAULT_COLUMNS);

    const scoped = offerColumns(TP_DEFAULT_COLUMNS, { isAll: false, showPriority: false });
    expect(scoped.some((o) => o.def.id === 'project')).toBe(false);
    const pri = scoped.find((o) => o.def.id === 'priority')!;
    expect(pri.disabledReason).toMatch(/Settings/);
  });
});

describe('gridTemplate', () => {
  it('is always the title track plus ONE track per visible column', () => {
    for (const chosen of [[], ['due'], TP_DEFAULT_COLUMNS, ALL_IDS] as TpColumnId[][]) {
      const vis = visibleColumns(chosen, { isAll: true, showPriority: true });
      const tracks = gridTemplate(vis).replace(/minmax\([^)]*\)/g, 'TITLE').trim().split(/\s+/);
      expect(tracks.length, JSON.stringify(chosen)).toBe(1 + vis.length);
      expect(tracks[0]).toBe('TITLE');
      expect(tracks.slice(1)).toEqual(vis.map((c) => c.width));
    }
  });

  it('the default layout reproduces the tracks the CSS used to hard-code', () => {
    const vis = visibleColumns(TP_DEFAULT_COLUMNS, { isAll: true, showPriority: true });
    expect(gridTemplate(vis)).toBe('minmax(280px, 1fr) 120px 90px 170px 140px');
    const noPri = visibleColumns(TP_DEFAULT_COLUMNS, { isAll: false, showPriority: false });
    expect(gridTemplate(noPri)).toBe('minmax(280px, 1fr) 90px 170px');
  });
});

describe('formatTableTime', () => {
  const NOW = Date.UTC(2026, 8, 23, 12, 0, 0); // 2026-09-23T12:00Z

  it('empty / invalid → empty string (the cell draws its own dash)', () => {
    expect(formatTableTime(undefined, NOW)).toBe('');
    expect(formatTableTime(null, NOW)).toBe('');
    expect(formatTableTime('', NOW)).toBe('');
    expect(formatTableTime('not a date', NOW)).toBe('');
  });

  it('under seven days reads as an age', () => {
    expect(formatTableTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
    expect(formatTableTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3h ago');
    expect(formatTableTime(new Date(NOW - 6 * 86400_000).toISOString(), NOW)).toBe('6d ago');
  });

  it('seven days or older switches to a short date, with the year only when it differs', () => {
    const sameYear = formatTableTime('2026-03-05T10:00:00Z', NOW);
    expect(sameYear).toMatch(/Mar/);
    expect(sameYear).not.toMatch(/2026/);
    const otherYear = formatTableTime('2025-03-05T10:00:00Z', NOW);
    expect(otherYear).toMatch(/Mar/);
    expect(otherYear).toMatch(/2025/);
  });

  it('a future timestamp (clock skew) still renders instead of going negative', () => {
    expect(formatTableTime(new Date(NOW + 60_000).toISOString(), NOW)).toBe('just now');
  });
});
