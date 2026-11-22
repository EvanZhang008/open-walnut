// A stretch of time with no readings never draws as a reading: a flat line or an empty track
// reads as "steady", so each chart says it has no data in words (2026-11-22 UI audit: Walnut
// Health's "No data" alarms drew flat grey sparks; a host's 12-hour track was a bare grey bar
// for the hours before its record began).
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { createElement } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { Spark } from '../../web/src/components/settings/sections/HealthMonitorSection';
import { sparks, timeline, TIMELINE_MS } from '../../web/src/components/settings/sections/host-fleet-dashboard-model';

const spark = (points: Array<number | null>, state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA') =>
  parseHTML(`<div>${renderToStaticMarkup(createElement(Spark, { points, state }))}</div>`).document;

describe('charts with no data say so', () => {
  it('a Health alarm with too little data shows "No data", never a line, even with zeros in its points', () => {
    for (const points of [[0, 0, 0, 0], [null, null], []]) {
      const doc = spark(points, 'INSUFFICIENT_DATA');
      expect(doc.querySelector('svg')).toBeNull();
      expect(doc.querySelector('.health-spark-empty')?.textContent).toBe('No data');
    }
  });
  it('a Health alarm with readings draws its line', () => {
    expect(spark([1, 2, 3], 'OK').querySelector('svg path')).not.toBeNull();
    expect(spark([null, null], 'OK').querySelector('.health-spark-empty')?.textContent).toBe('No data');
  });
  it('every stretch of a host timeline with no record names itself in words', () => {
    const NOW = Date.UTC(2026, 10, 22, 12);
    const hist = (coverageFrom: number | null) => ({ host: { now: { at: NOW }, history: coverageFrom === null ? null : { coverageFrom, outages: [] } } as never });
    const partial = timeline(hist(NOW - TIMELINE_MS / 4).host, NOW);
    expect(partial[0]).toMatchObject({ tone: 'none', note: expect.stringMatching(/^Recording since /) });
    const none = timeline(hist(null).host, NOW);
    expect(none).toEqual([expect.objectContaining({ tone: 'none', note: 'No record yet' })]);
    for (const segs of [partial, none]) for (const s of segs) if (s.tone === 'none') expect(s.note).toBeTruthy();
  });
  it('a host chart lane with no reading says No data, never a bare "max 0"', () => {
    const recent = { stepMinutes: 15, cpu: [null, null], mem: [null, null], sessions: [0, 0], up: [0, 0] };
    const lanes = sparks({ history: { recent } } as never);
    expect(lanes.map((l) => [l.key, l.value])).toEqual([['cpu', 'No data'], ['mem', 'No data'], ['sessions', 'No data']]);
  });
});
