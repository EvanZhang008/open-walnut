/**
 * Where a dragged card lands (web/src/components/board/kanban/kanban-dnd.ts):
 * before or after the card under the pointer, the head = first, the empty area
 * = end, a done lane is always the top (G26, C86), hidden cards keep their
 * place, and the keyboard drag's lanes, positions and announcements (8.2, C6).
 */
import { describe, expect, it } from 'vitest';
import {
  announce, cardTargetAt, dropInLane, insertAt, keyDropResult, keyPosition, startKeyDrag, stepKeyDrag, type KeyLane,
} from '../../web/src/components/board/kanban/kanban-dnd';

describe('drop index', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('insertAt moves the card out, then in at the index', () => {
    expect(insertAt(order, 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(insertAt(order, 'x', 99)).toEqual(['a', 'b', 'c', 'd', 'x']);
  });

  it('before or after the card under the pointer; the line is where the card goes', () => {
    expect(dropInLane(order, order, 'x', { type: 'card', id: 'b', after: false }, 'active')).toEqual({ order: ['a', 'x', 'b', 'c', 'd'], index: 1, lineBefore: 'b' });
    expect(dropInLane(order, order, 'x', { type: 'card', id: 'b', after: true }, 'active')).toEqual({ order: ['a', 'b', 'x', 'c', 'd'], index: 2, lineBefore: 'c' });
    expect(dropInLane(order, order, 'x', { type: 'card', id: 'd', after: true }, 'active')).toEqual({ order: ['a', 'b', 'c', 'd', 'x'], index: 4, lineBefore: null });
  });

  it('the head is first, the empty area is the end', () => {
    expect(dropInLane(order, order, 'x', { type: 'head' }, 'wait').index).toBe(0);
    expect(dropInLane(order, order, 'x', { type: 'end' }, 'wait')).toMatchObject({ index: 4, lineBefore: null });
    expect(dropInLane([], [], 'x', { type: 'end' }, 'todo')).toEqual({ order: ['x'], index: 0, lineBefore: null });
  });

  it('a reorder in the same lane: third to first', () => {
    expect(dropInLane(order, order, 'c', { type: 'card', id: 'a', after: false }, 'active').order).toEqual(['c', 'a', 'b', 'd']);
    // Dropped on itself: stays where it was relative to its neighbours.
    expect(dropInLane(order, order, 'c', { type: 'card', id: 'b', after: true }, 'active').order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('hidden cards keep their place relative to the shown ones', () => {
    const shown = ['a', 'c'];
    // Before c: after the hidden b.
    expect(dropInLane(order, shown, 'x', { type: 'card', id: 'c', after: false }, 'active').order).toEqual(['a', 'b', 'x', 'c', 'd']);
    // The end: after the last SHOWN card, the hidden d stays after it.
    expect(dropInLane(order, shown, 'x', { type: 'end' }, 'active').order).toEqual(['a', 'b', 'c', 'x', 'd']);
  });

  it('C86: a done lane is always the top, the line too', () => {
    const r = dropInLane(order, order, 'x', { type: 'card', id: 'c', after: false }, 'done');
    expect(r).toEqual({ order: ['x', 'a', 'b', 'c', 'd'], index: 0, lineBefore: 'a' });
  });

  it('the pointer y picks the card and the side', () => {
    const boxes = [{ id: 'a', top: 0, height: 100 }, { id: 'b', top: 110, height: 100 }];
    expect(cardTargetAt(20, boxes)).toEqual({ type: 'card', id: 'a', after: false });
    expect(cardTargetAt(80, boxes)).toEqual({ type: 'card', id: 'a', after: true });
    expect(cardTargetAt(105, boxes)).toEqual({ type: 'card', id: 'b', after: false });
    expect(cardTargetAt(400, boxes)).toEqual({ type: 'end' });
    expect(cardTargetAt(10, [])).toEqual({ type: 'end' });
  });
});

describe('keyboard drag', () => {
  const lanes: KeyLane[] = [
    { id: 'new', name: 'New', kind: 'todo', shown: ['t1'], order: ['t1'] },
    { id: 'investigating', name: 'Investigating', kind: 'active', shown: ['i1', 'i2', 'i3'], order: ['i1', 'i2', 'i3'] },
    { id: 'mitigating', name: 'Mitigating', kind: 'active', shown: ['m1', 'm2'], order: ['m1', 'm2'] },
    { id: 'resolved', name: 'Resolved', kind: 'done', shown: ['d1', 'd2'], order: ['d1', 'd2'] },
  ];

  it('C6: Space, ArrowRight twice, ArrowDown once: second lane to the right, position 2', () => {
    let s = startKeyDrag(lanes, 't1', 'Ticket one');
    expect(s).toMatchObject({ laneIndex: 0, pos: 0 });
    s = stepKeyDrag(s!, 'ArrowRight', lanes);
    s = stepKeyDrag(s, 'ArrowRight', lanes);
    s = stepKeyDrag(s, 'ArrowDown', lanes);
    expect(keyPosition(s, lanes)).toEqual({ position: 2, of: 3 });
    const r = keyDropResult(s, lanes);
    expect(r).toMatchObject({ lane: 'mitigating', index: 1, order: ['m1', 't1', 'm2'] });
    expect(announce.over('Ticket one', 'Mitigating', 2, 3)).toBe('Ticket one is over Mitigating, position 2 of 3.');
    expect(announce.dropped('Ticket one', 'Mitigating', 2)).toBe('Ticket one dropped in Mitigating, position 2.');
  });

  it('positions clamp to the lane; a done lane is always position 1', () => {
    let s = startKeyDrag(lanes, 'i3', 'Three')!;
    expect(s.pos).toBe(2);
    s = stepKeyDrag(s, 'ArrowDown', lanes);
    expect(s.pos).toBe(2);
    s = stepKeyDrag(s, 'ArrowRight', lanes);
    expect(s.pos).toBe(2); // the end of Mitigating (2 cards)
    s = stepKeyDrag(s, 'ArrowRight', lanes);
    expect(keyPosition(s, lanes).position).toBe(1);
    s = stepKeyDrag(s, 'ArrowDown', lanes);
    expect(keyDropResult(s, lanes)).toMatchObject({ lane: 'resolved', index: 0 });
    expect(stepKeyDrag(s, 'ArrowRight', lanes).laneIndex).toBe(3);
    expect(stepKeyDrag(s, 'Tab', lanes)).toBe(s);
  });

  it('the announcements are the English sentences of 8.2', () => {
    expect(announce.picked('A')).toBe('Picked up A.');
    expect(announce.cancelled()).toBe('Move cancelled.');
  });
});
