/**
 * Whether a session's header offers the Board tab (board-tab-model.ts): only a
 * task that leads (open subtasks) or keeps a Board of its own.
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
  it('no open subtasks and no answer yet: unknown', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 0, owner: undefined })).toBe('unknown');
  });
  it('a Board of its own: shown (a lead whose subtasks all finished)', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 0, owner: { own_board: true, open_subtasks: 0 } })).toBe('shown');
  });
  it('a plain task or a worker: hidden', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 0, owner: { own_board: false, open_subtasks: 0 } })).toBe('hidden');
  });
  it('the live store outranks the answer\'s count; with no store, the count stands in', () => {
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: 0, owner: { own_board: false, open_subtasks: 2 } })).toBe('hidden');
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: null, owner: { own_board: false, open_subtasks: 2 } })).toBe('shown');
    expect(boardTabState({ taskId: 't', storeOpenSubtasks: null, owner: { own_board: false, open_subtasks: 0 } })).toBe('hidden');
  });
});
