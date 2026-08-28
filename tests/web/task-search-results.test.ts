import { describe, expect, it } from 'vitest';
import {
  mapServerTaskSearchResults,
  taskIdsFromSearchResults,
  taskReferenceMatchField,
} from '../../web/src/components/tasks/search-results';

const SESSION_ID = '12345678-1234-4abc-8def-1234567890ab';

function task(
  id: string,
  refs: {
    session_id?: string;
    session_ids?: string[];
    plan_session_id?: string;
    exec_session_id?: string;
    external_url?: string;
  } = {},
) {
  return { id, ...refs };
}

describe('task search result merging', () => {
  it('maps session hits to their owning task', () => {
    expect(taskIdsFromSearchResults([
      { type: 'session', sessionId: 'matched-session', taskId: 'owning-task' },
    ])).toEqual(['owning-task']);
  });

  it('drops orphan sessions and preserves the remaining server order', () => {
    expect(taskIdsFromSearchResults([
      { type: 'session', sessionId: 'orphan-session' },
      { type: 'task', taskId: 'direct-task' },
      { type: 'session', sessionId: 'owned-session', taskId: 'session-owner' },
    ])).toEqual(['direct-task', 'session-owner']);
  });

  it('keeps the first rank when task and session hits share an owner', () => {
    expect(taskIdsFromSearchResults([
      { type: 'session', sessionId: 'best-evidence', taskId: 'shared-task' },
      { type: 'task', taskId: 'other-task' },
      { type: 'task', taskId: 'shared-task' },
      { type: 'session', sessionId: 'later-evidence', taskId: 'shared-task' },
    ])).toEqual(['shared-task', 'other-task']);
  });

  it('uses server task IDs after the response even when a stale local session link matches', () => {
    const staleLocalOwner = task('stale-local-owner', { session_ids: [SESSION_ID] });
    const authoritativeOwner = task('authoritative-owner');

    expect(mapServerTaskSearchResults(
      [staleLocalOwner, authoritativeOwner],
      ['authoritative-owner'],
    )).toEqual([authoritativeOwner]);
  });

  it('does not retain unrelated local tasks after server results arrive', () => {
    const localOnly = task('local-only');
    const semantic = task('semantic-task');

    expect(mapServerTaskSearchResults(
      [localOnly, semantic],
      ['semantic-task'],
    )).toEqual([semantic]);
  });

  it('recognizes active, historical, and legacy session slots', () => {
    expect(taskReferenceMatchField(task('a', { session_id: SESSION_ID }), SESSION_ID)).toBe('session_id');
    expect(taskReferenceMatchField(task('b', { session_ids: [SESSION_ID] }), SESSION_ID)).toBe('session_id');
    expect(taskReferenceMatchField(task('c', { plan_session_id: SESSION_ID }), SESSION_ID)).toBe('session_id');
    expect(taskReferenceMatchField(task('d', { exec_session_id: SESSION_ID }), SESSION_ID)).toBe('session_id');
  });

  it('does not treat a natural-language URL slug as a copied reference', () => {
    expect(taskReferenceMatchField(task('a', {
      external_url: 'https://example.test/projects/deployment-notes',
    }), 'deployment')).toBeNull();
  });
});
