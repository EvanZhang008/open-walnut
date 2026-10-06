/**
 * The kanban's shared pure rules (src/core/boards/board-lanes.ts): templates
 * (C2), the 4.2 auto lane table (C56), placeCard in both event orders (C12),
 * lane validation (C78), the delete preview (C20) and the summary choice
 * (G11, G34).
 */
import { describe, expect, it } from 'vitest';
import {
  GENERAL_LANES, MAX_LANES, TRIAGE_LANES, autoLaneKind, deletePreview, deletePreviewText, displayedSummary,
  effectiveLanes, firstLaneOfKind, makeLaneId, normalizeBoardCard, normalizeKanbanSeen, normalizeLanes, pickLaneTemplate,
  placeCard, statelessLaneKind, stripMarkdown, summaryHash, templateLanes, validateLanes, type BoardCard, type BoardLane,
} from '../../src/core/boards/board-lanes';

const T = (iso: string) => `2026-10-0${iso}Z`;

describe('templates (C2)', () => {
  it('a team with a ticket tag gets the triage lanes, in order', () => {
    expect(pickLaneTemplate(['sev:2', 'ticket:V1000000101'])).toBe('triage');
    expect(pickLaneTemplate(['Ticket-Id:V1000000102'])).toBe('triage');
    expect(templateLanes('triage').map((l) => l.name)).toEqual(
      ['New', 'Investigating', 'Mitigating', 'Waiting on others', 'Waiting on CR', 'Resolved']);
    expect(TRIAGE_LANES.map((l) => l.id)).toEqual(['new', 'investigating', 'mitigating', 'waiting-others', 'waiting-cr', 'resolved']);
  });

  it('any other team gets the general lanes', () => {
    expect(pickLaneTemplate(['sev:2', 'area:payments', 'tickets'])).toBe('general');
    expect(templateLanes('general').map((l) => `${l.id}:${l.kind}`)).toEqual(
      ['todo:todo', 'in-progress:active', 'waiting:wait', 'review:review', 'done:done']);
    expect(GENERAL_LANES.map((l) => l.name)).toEqual(['To do', 'In progress', 'Waiting', 'Review', 'Done']);
  });

  it('stored lanes win over the tags and keep their template', () => {
    const stored: BoardLane[] = [{ id: 'todo', name: 'Queue', kind: 'todo' }, { id: 'done', name: 'Done', kind: 'done' }];
    const r = effectiveLanes(stored, ['ticket:V1000000101'], 'general');
    expect(r.lanes.map((l) => l.name)).toEqual(['Queue', 'Done']);
    expect(r.template).toBe('general');
    expect(effectiveLanes(null, ['ticket:V1000000101']).template).toBe('triage');
    // Copies: editing the result never edits the frozen template.
    templateLanes('triage')[0].name = 'Changed';
    expect(TRIAGE_LANES[0].name).toBe('New');
  });

  it('firstLaneOfKind falls back to the first todo lane, then the first lane (4.2 rule 3)', () => {
    const lanes: BoardLane[] = [{ id: 'a', name: 'A', kind: 'active' }, { id: 'b', name: 'B', kind: 'todo' }, { id: 'c', name: 'C', kind: 'done' }];
    expect(firstLaneOfKind(lanes, 'wait')?.id).toBe('b');
    expect(firstLaneOfKind(lanes.filter((l) => l.kind !== 'todo'), 'wait')?.id).toBe('a');
    expect(firstLaneOfKind([], 'todo')).toBeNull();
  });
});

describe('the 4.2 auto lane table (C56)', () => {
  it('every row', () => {
    expect(autoLaneKind({ type: 'card-appeared', phase: 'TODO', hasHadSession: false })).toBe('todo');
    expect(autoLaneKind({ type: 'session-running' })).toBe('active');
    expect(autoLaneKind({ type: 'phase', from: 'TODO', to: 'IN_PROGRESS' })).toBe('active');
    expect(autoLaneKind({ type: 'phase', from: 'IN_PROGRESS', to: 'WAITING' })).toBe('wait');
    expect(autoLaneKind({ type: 'phase', from: 'WAITING', to: 'IN_PROGRESS' })).toBe('active');
    expect(autoLaneKind({ type: 'phase', from: 'IN_PROGRESS', to: 'COMPLETE' })).toBe('done');
    expect(autoLaneKind({ type: 'phase', from: 'COMPLETE', to: 'IN_PROGRESS' })).toBe('active');
  });

  it('NEED_ACTION, idle, stopped, error and a turn end leave the lane alone', () => {
    expect(autoLaneKind({ type: 'phase', from: 'IN_PROGRESS', to: 'NEED_ACTION' })).toBeNull();
    expect(autoLaneKind({ type: 'phase', from: 'IN_PROGRESS', to: 'IN_PROGRESS' })).toBeNull();
    for (const type of ['session-idle', 'session-stopped', 'session-error', 'turn-end'] as const) {
      expect(autoLaneKind({ type })).toBeNull();
    }
  });

  it('the stateless rule never sends a card that had a session back to todo', () => {
    expect(statelessLaneKind({ phase: 'COMPLETE' })).toBe('done');
    expect(statelessLaneKind({ phase: 'WAITING', hasHadSession: true })).toBe('wait');
    expect(statelessLaneKind({ phase: 'NEED_ACTION' })).toBe('active');
    expect(statelessLaneKind({ phase: 'IN_PROGRESS' })).toBe('active');
    expect(statelessLaneKind({ phase: 'TODO', hasHadSession: true })).toBe('active');
    expect(statelessLaneKind({ phase: 'TODO' })).toBe('todo');
  });
});

describe('placeCard (C12: latest event wins, both orders)', () => {
  const lanes = templateLanes('triage');

  it('explicit in Mitigating, then the task completes: it shows in Resolved', () => {
    const card: BoardCard = { lane: 'mitigating', lane_at: T('1T09:00:00'), lane_by: 'human' };
    const open = placeCard(card, { phase: 'IN_PROGRESS', hasHadSession: true }, lanes);
    expect(open).toEqual({ lane: 'mitigating', source: 'explicit', completedAfterMove: false });
    const done = placeCard(card, { phase: 'COMPLETE', completed_at: T('1T10:00:00'), hasHadSession: true }, lanes);
    expect(done).toEqual({ lane: 'resolved', source: 'auto', completedAfterMove: true });
  });

  it('completed first, then dragged to Mitigating: it shows in Mitigating', () => {
    const card: BoardCard = { lane: 'mitigating', lane_at: T('2T09:00:00'), lane_by: 'human' };
    const r = placeCard(card, { phase: 'COMPLETE', completed_at: T('1T10:00:00'), hasHadSession: true }, lanes);
    expect(r).toEqual({ lane: 'mitigating', source: 'explicit', completedAfterMove: false });
  });

  it('an explicit lane that was deleted falls back to the auto lane, then the stateless rule', () => {
    const gone: BoardCard = { lane: 'ln-0000beef', lane_at: T('1T09:00:00'), lane_auto: { lane: 'mitigating', at: T('1T08:00:00') } };
    expect(placeCard(gone, { phase: 'IN_PROGRESS' }, lanes)).toEqual({ lane: 'mitigating', source: 'auto', completedAfterMove: false });
    expect(placeCard({ lane: 'ln-0000beef' }, { phase: 'TODO' }, lanes).lane).toBe('new');
    expect(placeCard(null, { phase: 'NEED_ACTION', hasHadSession: true }, lanes).lane).toBe('investigating');
    expect(placeCard(undefined, { phase: 'WAITING' }, lanes).lane).toBe('waiting-others');
    expect(placeCard(undefined, { phase: 'COMPLETE' }, lanes).lane).toBe('resolved');
  });

  it('the sticky auto lane survives a turn end (NEED_ACTION never moves a card back)', () => {
    const card: BoardCard = { lane_auto: { lane: 'investigating', at: T('1T09:00:00') } };
    expect(placeCard(card, { phase: 'NEED_ACTION', hasHadSession: true }, lanes).lane).toBe('investigating');
  });

  it('a completion the watch has not recorded still lands in done', () => {
    const card: BoardCard = { lane_auto: { lane: 'investigating', at: T('1T09:00:00') } };
    expect(placeCard(card, { phase: 'COMPLETE', completed_at: T('1T11:00:00') }, lanes).lane).toBe('resolved');
  });

  it('a wanted kind with no lane goes to the first todo lane', () => {
    const noWait = lanes.filter((l) => l.kind !== 'wait');
    expect(placeCard(undefined, { phase: 'WAITING' }, noWait).lane).toBe('new');
    expect(placeCard(undefined, { phase: 'TODO' }, []).lane).toBe('');
  });
});

describe('validateLanes (C78)', () => {
  let n = 0;
  const newId = () => `ln-${String(++n).padStart(8, '0')}`;

  it('trims names, makes ids for new lanes, keeps complete_on_drop on done lanes only', () => {
    const r = validateLanes([
      { id: 'new', name: '  New ', kind: 'todo', complete_on_drop: true },
      { name: 'Waiting on customer', kind: 'wait' },
      { id: 'resolved', name: 'Resolved', kind: 'done', complete_on_drop: true },
    ], { newId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lanes).toEqual([
      { id: 'new', name: 'New', kind: 'todo' },
      { id: 'ln-00000001', name: 'Waiting on customer', kind: 'wait' },
      { id: 'resolved', name: 'Resolved', kind: 'done', complete_on_drop: true },
    ]);
  });

  it('refuses a board without a done lane', () => {
    const r = validateLanes([{ name: 'New', kind: 'todo' }], { newId });
    expect(r).toMatchObject({ ok: false, reason: 'needs_done_lane' });
  });

  it('refuses empty, duplicate (ignoring case), too long names, bad kinds, too many lanes', () => {
    const done = { name: 'Done', kind: 'done' };
    expect(validateLanes([], { newId })).toMatchObject({ ok: false, reason: 'bad_request' });
    expect(validateLanes([{ name: ' ', kind: 'todo' }, done], { newId })).toMatchObject({ message: 'A lane needs a name' });
    expect(validateLanes([{ name: 'done', kind: 'todo' }, done], { newId }))
      .toMatchObject({ ok: false, message: 'There is already a lane called "Done"' });
    expect(validateLanes([{ name: 'x'.repeat(41), kind: 'todo' }, done], { newId })).toMatchObject({ reason: 'bad_request', max: 40 });
    expect(validateLanes([{ name: 'A', kind: 'later' }, done], { newId })).toMatchObject({ reason: 'bad_request' });
    const many = Array.from({ length: MAX_LANES + 1 }, (_, k) => ({ name: `L${k}`, kind: 'done' }));
    expect(validateLanes(many, { newId })).toMatchObject({ reason: 'bad_request', max: 12 });
    expect(validateLanes([{ id: 'Bad Id', name: 'A', kind: 'done' }], { newId })).toMatchObject({ reason: 'bad_request' });
    expect(validateLanes([{ id: 'a', name: 'A', kind: 'todo' }, { id: 'a', name: 'B', kind: 'done' }], { newId }))
      .toMatchObject({ reason: 'bad_request' });
  });

  it('server lane ids are ln- plus 8 hex', () => {
    expect(makeLaneId(() => 0xbeef)).toBe('ln-0000beef');
    expect(makeLaneId()).toMatch(/^ln-[0-9a-f]{8}$/);
  });
});

describe('deletePreview (C20, 7.3 strings)', () => {
  const lanes = templateLanes('triage');

  it('cards explicitly in the lane go where placeCard puts them after the delete', () => {
    const entries = [
      { card: { lane: 'waiting-cr', lane_at: T('1T09:00:00') }, task: { phase: 'TODO' } },
      { card: { lane: 'waiting-cr', lane_at: T('1T09:00:00') }, task: { phase: 'TODO' } },
      { card: { lane: 'waiting-cr', lane_at: T('1T09:00:00') }, task: { phase: 'TODO' } },
      { card: { lane: 'waiting-cr', lane_at: T('1T09:00:00') }, task: { phase: 'IN_PROGRESS', hasHadSession: true } },
      { card: { lane: 'mitigating' }, task: { phase: 'IN_PROGRESS' } },
    ];
    const p = deletePreview(lanes, 'waiting-cr', entries);
    expect(p.total).toBe(4);
    expect(p.moves).toEqual([{ lane: 'new', name: 'New', count: 3 }, { lane: 'investigating', name: 'Investigating', count: 1 }]);
    expect(deletePreviewText(p)).toBe('Its 4 cards move by their status: 3 to New, 1 to Investigating.');
  });

  it('one destination, one card, no cards', () => {
    const four = Array.from({ length: 4 }, () => ({ card: { lane: 'mitigating' }, task: { phase: 'TODO' } }));
    expect(deletePreviewText(deletePreview(lanes, 'mitigating', four))).toBe('Its 4 cards move to New.');
    expect(deletePreviewText(deletePreview(lanes, 'mitigating', four.slice(0, 1)))).toBe('Its 1 card moves to New.');
    expect(deletePreviewText(deletePreview(lanes, 'mitigating', []))).toBe('It has no cards.');
  });

  it('an auto card in the lane counts too (its auto lane is gone after the delete)', () => {
    const entries = [{ card: { lane_auto: { lane: 'mitigating', at: T('1T09:00:00') } }, task: { phase: 'IN_PROGRESS' } }];
    const p = deletePreview(lanes, 'mitigating', entries);
    expect(p.moves).toEqual([{ lane: 'investigating', name: 'Investigating', count: 1 }]);
  });
});

describe('summary choice and plain text (G11, G34)', () => {
  it('the newer of the card summary and the worker summary wins', () => {
    const card: BoardCard = { summary: 'Leader view', summary_at: T('1T09:00:00'), summary_by: 'task:owner', worker_summary_at: T('1T14:00:00') };
    expect(displayedSummary(card, 'Worker view')).toMatchObject({ text: 'Worker view', source: 'task', at: T('1T14:00:00') });
    const later: BoardCard = { ...card, summary_at: T('1T15:00:00') };
    expect(displayedSummary(later, 'Worker view')).toMatchObject({ text: 'Leader view', source: 'card', by: 'task:owner' });
    expect(displayedSummary({ summary: 'Only card', summary_at: T('1T09:00:00') }, '')).toMatchObject({ source: 'card' });
    expect(displayedSummary(undefined, 'Only worker')).toMatchObject({ source: 'task' });
    expect(displayedSummary({ summary: 'Card, no worker time', summary_at: T('1T09:00:00') }, 'Old worker text')).toMatchObject({ source: 'card' });
    expect(displayedSummary(null, '  ')).toBeNull();
  });

  it('markdown becomes plain text', () => {
    expect(stripMarkdown('## Status\n- **Bold** fix in `checkout-api`, see [the runbook](https://example.test/rb)'))
      .toBe('Status: Bold fix in checkout-api, see the runbook');
    expect(stripMarkdown('1. first *one*\n> quoted <b>tag</b>')).toBe('first one. quoted tag');
    expect(stripMarkdown('a < b and snake_case_name stay')).toBe('a < b and snake_case_name stay');
  });

  it('R3-11: headings, list items and paragraphs read as sentences, soft wraps join', () => {
    const md = '## Status\n**Mitigated** for now: the shard limit is applied.\n- Root cause: a retry loop on one shard\n'
      + '- Next: confirm the backfill finished\n\nThe export window reopens at 09:00';
    expect(stripMarkdown(md)).toBe('Status: Mitigated for now: the shard limit is applied. Root cause: a retry loop on one shard. '
      + 'Next: confirm the backfill finished. The export window reopens at 09:00');
    expect(stripMarkdown('one sentence that\nwraps on two lines')).toBe('one sentence that wraps on two lines');
    expect(stripMarkdown('- an item that\n  wraps under it\n- next')).toBe('an item that wraps under it. next');
    expect(stripMarkdown('# Done:\nall good')).toBe('Done: all good');
    expect(stripMarkdown('```\ncode line\n```\nafter')).toBe('code line. after');
  });

  it('summaryHash is stable, short and differs for different text', () => {
    expect(summaryHash('abc')).toBe(summaryHash('abc'));
    expect(summaryHash('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(summaryHash('abc')).not.toBe(summaryHash('abd'));
    expect(summaryHash('')).toBe('811c9dc5');
  });
});

describe('normalizers', () => {
  it('keep only well typed fields', () => {
    expect(normalizeLanes([{ id: 'a', name: 'A', kind: 'todo', complete_on_drop: true }, { id: 'b', kind: 'x' }]))
      .toEqual([{ id: 'a', name: 'A', kind: 'todo' }]);
    expect(normalizeLanes('nope')).toBeNull();
    expect(normalizeBoardCard({ lane: 'new', rank: 'x', lane_by: 'robot', lane_auto: { lane: 'new', at: T('1T09:00:00') } }))
      .toEqual({ lane: 'new', lane_auto: { lane: 'new', at: T('1T09:00:00') } });
    expect(normalizeBoardCard({})).toBeNull();
    expect(normalizeKanbanSeen({ at: T('1T09:00:00'), cards: { a: { lane: 'new', summaryHash: '00' }, b: { lane: 1 } } }))
      .toEqual({ at: T('1T09:00:00'), cards: { a: { lane: 'new', summaryHash: '00' } } });
  });
});
