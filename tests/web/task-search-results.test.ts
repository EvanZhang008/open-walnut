import { describe, expect, it } from 'vitest';
import {
  mapServerTaskSearchResults,
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
