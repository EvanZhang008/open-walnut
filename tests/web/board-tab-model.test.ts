/**
 * Whether a session's header offers the Board tab (board-tab-model.ts): only a
 * task that leads now, one with open subtasks. A Board kept from a finished team
 * does not count (2026-11-19, the user: "only show if it is leader").
 */
import { describe, it, expect } from 'vitest';
import { boardTabState } from '../../web/src/components/sessions/board-tab-model';

describe('boardTabState', () => {
  it('no task: hidden', () => {
    expect(boardTabState({ taskId: undefined, storeOpenSubtasks: 3, owner: { own_board: true } })).toBe('hidden');
  });
  it('open subtasks in the store: shown at once, with no server answer', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 1, owner: undefined })).toBe('shown');
  });
  it('the store says no open subtasks: hidden at once, with no server answer', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 0, owner: undefined })).toBe('hidden');
  });
  it('an old Board of its own and no open subtasks: hidden (the Interview task, 2026-11-19)', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 0, owner: { own_board: true, open_subtasks: 0 } })).toBe('hidden');
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: null, owner: { own_board: true, open_subtasks: 0 } })).toBe('hidden');
  });
  it('a plain task or a worker: hidden', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 0, owner: { own_board: false, open_subtasks: 0 } })).toBe('hidden');
  });
  it('the live store outranks the answer\'s count; with no store, the count stands in', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 0, owner: { own_board: false, open_subtasks: 2 } })).toBe('hidden');
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: null, owner: { own_board: false, open_subtasks: 2 } })).toBe('shown');
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: null, owner: undefined })).toBe('unknown');
  });
});
