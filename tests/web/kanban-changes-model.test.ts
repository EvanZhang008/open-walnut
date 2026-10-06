/**
 * "Changed since you last looked" (web/src/components/board/kanban/kanban-changes-model.ts):
 * moves and summaries by the leader or a worker count, a human's never do
 * (C28, C62), suggestions (C69), new output (C61), new cards, the foot's one
 * signal, the What changed log (C88) and the snapshot (C63).
 */
import { describe, expect, it } from 'vitest';
import { summaryHash, templateLanes } from '../../src/core/boards/board-lanes';
import {
  cardChange, changeLog, cutTitle, snapshotFor, writerLead, writerText, type CardChangeInput,
} from '../../web/src/components/board/kanban/kanban-changes-model';

const OWNER = 'own00000-0000-4000-8000-000000000000';
const NOW = new Date(2026, 9, 3, 15, 30).getTime();
const at = (h: number, m: number) => new Date(2026, 9, 3, h, m).toISOString();
const titles: Record<string, string> = { 'wkr00000-0000-4000-8000-000000000000': 'V1000000104 worker on checkout latency' };

function input(p: Partial<CardChangeInput> = {}): CardChangeInput {
  return {
    taskId: 'card0000-0000-4000-8000-000000000000', label: 'V1000000104', lanes: templateLanes('triage'),
    lane: 'investigating', source: 'auto', unread: false, summaryHash: summaryHash('same'), createdAt: at(8, 0),
    baseline: { lane: 'investigating', summaryHash: summaryHash('same'), unread: false }, hasBaseline: true,
    baselineAt: at(9, 0), ownerId: OWNER, titleOf: (id) => titles[id] ?? '', now: NOW, ...p,
  };
}

describe('cardChange', () => {
  it('no baseline yet: nothing is changed; unchanged card: null', () => {
    expect(cardChange(input({ hasBaseline: false, lane: 'mitigating' }))).toBeNull();
    expect(cardChange(input())).toBeNull();
  });

  it('a move by the leader, with who and when', () => {
    const c = cardChange(input({ lane: 'mitigating', source: 'explicit', laneAt: at(15, 2), laneBy: `task:${OWNER}` }));
    // R3-04: the foot shows who and when (never cut); where it came from is in the tooltip text.
    expect(c?.foot).toEqual({ text: 'Moved from Investigating by the leader · 15:02', short: 'Moved by the leader', clock: '15:02', more: 0 });
    expect(c?.items[0].sentence).toBe('the leader moved V1000000104 from Investigating to Mitigating');
  });

  it('a move by another session names its task, cut to 24', () => {
    const c = cardChange(input({ lane: 'mitigating', source: 'explicit', laneAt: at(15, 2), laneBy: 'task:wkr00000-0000-4000-8000-000000000000' }));
    expect(c?.foot?.text).toBe('Moved from Investigating by V1000000104 worker on ch… · 15:02');
    expect(cutTitle('V1000000104 worker')).toBe('V1000000104 worker');
  });

  it('an automatic move says so; a human move never counts', () => {
    expect(cardChange(input({ lane: 'resolved', laneAt: at(14, 0) }))?.foot?.text).toBe('Moved from Investigating automatically · 14:00');
    expect(cardChange(input({ lane: 'mitigating', source: 'explicit', laneAt: at(15, 0), laneBy: 'human' }))).toBeNull();
  });

  it('a summary update by the leader counts; by a human it does not', () => {
    const c = cardChange(input({ summaryHash: summaryHash('new'), summaryAt: at(15, 2), summaryBy: `task:${OWNER}` }));
    expect(c?.foot?.text).toBe('Summary updated by the leader · 15:02');
    expect(cardChange(input({ summaryHash: summaryHash('new'), summaryAt: at(15, 2), summaryBy: 'human' }))).toBeNull();
  });

  it('a suggestion after the baseline counts; one older than the baseline does not', () => {
    const card = { lane_suggested: { lane: 'mitigating', by: OWNER, at: at(15, 2) } };
    expect(cardChange(input({ card }))?.foot?.text).toBe('Leader suggests Mitigating');
    expect(cardChange(input({ card: { lane_suggested: { ...card.lane_suggested, at: at(8, 0) } } }))).toBeNull();
  });

  it('new output: only output_at after the baseline (C61); an unread flip alone is the dot, not a change', () => {
    expect(cardChange(input({ unread: true }))).toBeNull();
    expect(cardChange(input({ card: { output_at: at(14, 10) } }))?.foot?.text).toBe('New output · 14:10');
    expect(cardChange(input({ unread: true, baseline: { lane: 'investigating', summaryHash: summaryHash('same'), unread: true } }))).toBeNull();
    const both = cardChange(input({ card: { output_at: at(14, 10) }, summaryHash: summaryHash('new'), summaryAt: at(14, 10), summaryBy: `task:${OWNER}` }));
    expect(both?.items.map((i) => i.kind)).toEqual(['summary', 'output']);
    expect(both?.foot).toEqual({ text: 'Summary updated by the leader · 14:10', short: 'Summary by the leader', clock: '14:10', more: 0 });
  });

  it('several changes: the first + how many more', () => {
    const c = cardChange(input({ lane: 'mitigating', source: 'explicit', laneAt: at(15, 2), laneBy: `task:${OWNER}`,
      summaryHash: summaryHash('new'), summaryAt: at(15, 2), summaryBy: `task:${OWNER}` }));
    expect(c?.foot).toEqual({ text: 'Moved from Investigating by the leader · 15:02', short: 'Moved by the leader', clock: '15:02', more: 1 });
  });

  it('a card with no baseline entry is new', () => {
    expect(cardChange(input({ baseline: undefined, createdAt: at(9, 12) }))?.foot?.text).toBe('New card · 09:12');
  });

  it('N4: a card a human placed (Add task, from any window) is not new to them', () => {
    expect(cardChange(input({ baseline: undefined, createdAt: at(9, 12), source: 'explicit', laneBy: 'human', laneAt: at(9, 12) }))).toBeNull();
    // A worker's or the leader's new card still is.
    expect(cardChange(input({ baseline: undefined, createdAt: at(9, 12), source: 'explicit', laneBy: `task:${OWNER}` }))?.items[0].kind).toBe('new');
  });
});

describe('the log and the snapshot', () => {
  it('What changed lists every change, oldest first, with the time', () => {
    const a = cardChange(input({ lane: 'mitigating', source: 'explicit', laneAt: at(15, 2), laneBy: `task:${OWNER}` }));
    const b = cardChange(input({ label: 'V1000000109', card: { output_at: at(14, 10) } }));
    const log = changeLog([{ taskId: 'a', change: a ?? undefined }, { taskId: 'b', change: b ?? undefined }], NOW);
    expect(log.map((l) => l.text)).toEqual(['14:10 V1000000109 new output', '15:02 the leader moved V1000000104 from Investigating to Mitigating']);
  });

  it('writerText', () => {
    expect(writerText(`task:${OWNER}`, OWNER, () => '')).toBe('the leader');
    expect(writerText('human', OWNER, () => '')).toBe('you');
    // R3-03: a writer is never guessed ('a session'); unknown = nobody named.
    expect(writerText(undefined, OWNER, () => '')).toBe('');
  });

  it('snapshot: each card as shown; a loading card keeps its previous entry', () => {
    const snap = snapshotFor([
      { taskId: 'a', loading: false, snapshot: { lane: 'new', summaryHash: 'h1', unread: false } },
      { taskId: 'b', loading: true, snapshot: { lane: 'resolved', summaryHash: '' } },
      { taskId: 'c', loading: true, snapshot: { lane: 'resolved', summaryHash: '' } },
    ], { b: { lane: 'resolved', summaryHash: 'h2' } });
    expect(snap).toEqual({ a: { lane: 'new', summaryHash: 'h1', unread: false }, b: { lane: 'resolved', summaryHash: 'h2' } });
  });
});

describe('round 4 fixes', () => {
  it('R3-03: a summary not read yet is no change, and an unknown writer is never named', () => {
    expect(cardChange(input({ summaryHash: summaryHash(''), summaryKnown: false }))).toBeNull();
    expect(cardChange(input({ summaryHash: summaryHash('other'), summaryKnown: false }))).toBeNull();
    const removed = cardChange(input({ summaryHash: summaryHash(''), summaryAt: at(15, 2) }));
    expect(removed?.foot?.short).toBe('Summary removed');
    const anon = cardChange(input({ summaryHash: summaryHash('new'), summaryAt: at(15, 2) }));
    expect(anon?.foot?.short).toBe('Summary updated');
    expect(JSON.stringify([removed, anon])).not.toContain('a session');
    const moved = cardChange(input({ lane: 'mitigating', source: 'explicit', laneAt: at(15, 2) }));
    expect(moved?.foot).toEqual({ text: 'Moved from Investigating · 15:02', short: 'Moved from Investigating', clock: '15:02', more: 0 });
  });

  it('R3-04: an automatic move and a worker move keep the time beside a short label', () => {
    expect(cardChange(input({ lane: 'resolved', laneAt: at(14, 0) }))?.foot).toMatchObject({ short: 'Moved automatically', clock: '14:00' });
    const w = cardChange(input({ lane: 'mitigating', source: 'explicit', laneAt: at(15, 2), laneBy: 'task:wkr00000-0000-4000-8000-000000000000' }));
    expect(w?.foot).toMatchObject({ short: 'Moved by V1000000104 worker on ch…', clock: '15:02' });
  });

  it('R3-04: the card\'s own worker is named "the worker", never by its own (cut) title', () => {
    const self = 'task:card0000-0000-4000-8000-000000000000' as const;
    const sum = cardChange(input({ summaryHash: summaryHash('new'), summaryAt: at(15, 2), summaryBy: self }));
    expect(sum?.foot).toMatchObject({ text: 'Summary updated by the worker \u00b7 15:02', short: 'Summary by the worker', clock: '15:02' });
    expect(sum?.items[0].sentence).toBe('the worker updated the summary of V1000000104');
    const moved = cardChange(input({ lane: 'mitigating', source: 'explicit', laneAt: at(15, 2), laneBy: self }));
    expect(moved?.foot?.short).toBe('Moved by the worker');
    const card = { lane_suggested: { lane: 'resolved', by: 'card0000-0000-4000-8000-000000000000', at: at(15, 2) } };
    expect(cardChange(input({ card }))?.foot?.text).toBe('Worker suggests Resolved');
    expect(writerLead('the leader')).toBe('Leader');
    expect(writerLead('V1000000104 worker')).toBe('V1000000104 worker');
  });

  it('R3-02: an automatic move caused by the user (laneBy human) is not counted', () => {
    expect(cardChange(input({ lane: 'resolved', laneAt: at(15, 2), laneBy: 'human' }))).toBeNull();
  });
});
