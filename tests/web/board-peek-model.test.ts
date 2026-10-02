/**
 * What the right column shows for a task chip clicked on a Board
 * (web/src/components/board/board-peek-model.ts). The peek itself is proven in
 * a real browser: tests/e2e/browser/task-board-peek.spec.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  BOARD_PHASE_LABELS, PEEK_EXCERPT_CHARS, boardPeekExcerpt, boardPeekView, boardPhaseLabel,
} from '../../web/src/components/board/board-peek-model';

function task(over: Partial<Task>): Task {
  return { id: 't-worker', title: 'Worker', phase: 'TODO', session_ids: [], summary: '', description: '', note: '', ...over } as Task;
}

describe('boardPeekView', () => {
  it('the panel\'s own task is its own chat, whatever the store says', () => {
    expect(boardPeekView('t-lead', 't-lead', task({ id: 't-lead', session_id: 's1' }))).toEqual({ kind: 'own' });
    expect(boardPeekView('t-lead', 't-lead', null)).toEqual({ kind: 'own' });
  });

  it('on a worker\'s panel (its Board is the leader\'s), the leader is just another task', () => {
    expect(boardPeekView('t-lead', 't-worker', task({ id: 't-lead', session_id: 's-lead' }))).toEqual({ kind: 'session', sessionId: 's-lead' });
    expect(boardPeekView('t-worker', 't-worker', task({ session_id: 's-worker' }))).toEqual({ kind: 'own' });
  });

  it('a task with a session shows that session', () => {
    expect(boardPeekView('t-worker', 't-lead', task({ session_id: 's-current' }))).toEqual({ kind: 'session', sessionId: 's-current' });
  });

  it('falls back through the older session slots, newest last id first', () => {
    expect(boardPeekView('t-worker', 't-lead', task({ exec_session_id: 's-exec' }))).toEqual({ kind: 'session', sessionId: 's-exec' });
    expect(boardPeekView('t-worker', 't-lead', task({ session_ids: ['s-old', 's-new'] }))).toEqual({ kind: 'session', sessionId: 's-new' });
  });

  it('a task with no session is a known card', () => {
    expect(boardPeekView('t-worker', 't-lead', task({}))).toEqual({ kind: 'card', known: true });
  });

  it('a task the store does not have is an unknown card', () => {
    expect(boardPeekView('nosuchtask0000', 't-lead', null)).toEqual({ kind: 'card', known: false });
  });

  it('a panel with no task never treats a target as its own', () => {
    expect(boardPeekView('t-worker', undefined, null)).toEqual({ kind: 'card', known: false });
  });
});

describe('boardPhaseLabel', () => {
  it('uses the words of the frame\'s own chips, so the header matches the chip clicked', () => {
    const frame = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/components/board/board-elements.frame.js'), 'utf8');
    const line = frame.split('\n').find((l) => /var PHASES = \{/.test(l)) ?? '';
    for (const [phase, label] of Object.entries(BOARD_PHASE_LABELS)) expect(line).toContain(`${phase}: '${label}'`);
  });

  it('passes an unknown phase through and is empty for none', () => {
    expect(boardPhaseLabel('NEED_ACTION')).toBe('Needs you');
    expect(boardPhaseLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(boardPhaseLabel(undefined)).toBe('');
  });
});

describe('boardPeekExcerpt', () => {
  it('prefers the summary over the description', () => {
    expect(boardPeekExcerpt(task({ summary: 'Short summary.', description: 'Long description.' }))).toBe('Short summary.');
  });

  it('uses the start of the description when there is no summary, on one line', () => {
    expect(boardPeekExcerpt(task({ summary: '  ', description: 'First line\n\n  second   line' }))).toBe('First line second line');
  });

  it('is empty for no task and for a task with neither', () => {
    expect(boardPeekExcerpt(null)).toBe('');
    expect(boardPeekExcerpt(task({}))).toBe('');
  });

  it('cuts a long text at a word boundary with an ellipsis', () => {
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    const out = boardPeekExcerpt(task({ description: words }));
    expect(out.length).toBeLessThanOrEqual(PEEK_EXCERPT_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
    expect(words.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.slice(0, -1).endsWith(' ')).toBe(false);
    expect(/word\d+…$/.test(out)).toBe(true);
  });

  it('cuts a text with no spaces at the limit', () => {
    const out = boardPeekExcerpt(task({ description: 'x'.repeat(400) }), 50);
    expect(out).toBe(`${'x'.repeat(50)}…`);
  });

  it('keeps non-ASCII text intact', () => {
    // Test data: CJK characters as explicit escapes.
    const text = '\u4efb\u52a1\u6458\u8981';
    expect(boardPeekExcerpt(task({ summary: text }))).toBe(text);
  });
});
