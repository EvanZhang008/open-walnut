import { describe, it, expect } from 'vitest';
import {
  computeIntegrityReport,
  extractRemoteKey,
} from '../../src/core/session-integrity.js';

/**
 * These pin the two corruptions the detector exists to catch. Both were found in
 * the wild on 2026-08-20 (254 orphaned sessions, 69 duplicate remote-id groups
 * covering 141 task rows) after accumulating silently for ~6 months.
 */
describe('extractRemoteKey', () => {
  it('reads the remote id from any provider key', () => {
    // Provider names are NOT allowlisted — a plugin added later must work too.
    expect(extractRemoteKey({ acme: { id: 'abc' } })).toBe('acme:abc');
    expect(extractRemoteKey({ marina: { id: 'xyz' } })).toBe('marina:xyz');
  });

  it('accepts short_id and issue_key as the remote key', () => {
    expect(extractRemoteKey({ acme: { short_id: 'S-1' } })).toBe('acme:S-1');
    expect(extractRemoteKey({ acme: { issue_key: 'PROJ-42' } })).toBe('acme:PROJ-42');
  });

  it('prefers id over the other key fields when several are present', () => {
    expect(extractRemoteKey({ acme: { id: 'real', short_id: 'S-1' } })).toBe('acme:real');
  });

  it('returns null for shapes that carry no remote key', () => {
    expect(extractRemoteKey(null)).toBeNull();
    expect(extractRemoteKey(undefined)).toBeNull();
    expect(extractRemoteKey({})).toBeNull();
    expect(extractRemoteKey({ acme: {} })).toBeNull();
    // A local-only task stores no provider object at all.
    expect(extractRemoteKey({ acme: 'not-an-object' })).toBeNull();
    // Arrays are not provider maps; guarding this keeps Object.entries honest.
    expect(extractRemoteKey([{ id: 'x' }])).toBeNull();
    // An empty string is not a usable join key.
    expect(extractRemoteKey({ acme: { id: '' } })).toBeNull();
  });
});

describe('computeIntegrityReport — orphaned sessions', () => {
  it('reports zero on a consistent pair of stores', () => {
    const report = computeIntegrityReport(
      [{ claudeSessionId: 's1', taskId: 't1' }, { claudeSessionId: 's2', taskId: 't2' }],
      [{ id: 't1' }, { id: 't2' }],
    );
    expect(report.orphanedSessions).toBe(0);
    expect(report.orphanSample).toEqual([]);
    expect(report.duplicateRemoteIdGroups).toBe(0);
  });

  it('counts a session pointing at a deleted task', () => {
    const report = computeIntegrityReport(
      [{ claudeSessionId: 's1', taskId: 't1' }, { claudeSessionId: 's2', taskId: 'gone' }],
      [{ id: 't1' }],
    );
    expect(report.orphanedSessions).toBe(1);
    expect(report.orphanSample).toEqual(['s2']);
  });

  it('treats unset and empty task_id as "no task", not as a dangling pointer', () => {
    // '' is used as the no-task marker in places; counting it as an orphan would
    // report every unlinked session as corruption.
    const report = computeIntegrityReport(
      [
        { claudeSessionId: 's1' },
        { claudeSessionId: 's2', taskId: null },
        { claudeSessionId: 's3', taskId: '' },
      ],
      [],
    );
    expect(report.orphanedSessions).toBe(0);
  });

  it('caps the sample but keeps the full count', () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      claudeSessionId: `s${i}`, taskId: 'gone',
    }));
    const report = computeIntegrityReport(sessions, []);
    expect(report.orphanedSessions).toBe(12);
    expect(report.orphanSample).toHaveLength(5);
  });
});

describe('computeIntegrityReport — duplicate remote ids', () => {
  it('counts two task rows sharing one remote id', () => {
    // This is bug B's signature: the same remote item imported twice under
    // different local ids. Deleting either twin strands its sessions.
    const report = computeIntegrityReport([], [
      { id: 'old', ext: { acme: { id: 'REMOTE-1' } } },
      { id: 'new', ext: { acme: { id: 'REMOTE-1' } } },
    ]);
    expect(report.duplicateRemoteIdGroups).toBe(1);
    expect(report.duplicateTaskRows).toBe(2);
    expect(report.duplicateSample).toEqual(['acme:REMOTE-1']);
  });

  it('counts every row in a group larger than two', () => {
    const report = computeIntegrityReport([], [
      { id: 'a', ext: { acme: { id: 'R' } } },
      { id: 'b', ext: { acme: { id: 'R' } } },
      { id: 'c', ext: { acme: { id: 'R' } } },
    ]);
    expect(report.duplicateRemoteIdGroups).toBe(1);
    expect(report.duplicateTaskRows).toBe(3);
  });

  it('does not flag the same remote id under different providers', () => {
    // The key is provider-scoped, so two plugins that happen to issue the same
    // opaque id are unrelated items, not a duplicate.
    const report = computeIntegrityReport([], [
      { id: 'a', ext: { acme: { id: 'SAME' } } },
      { id: 'b', ext: { marina: { id: 'SAME' } } },
    ]);
    expect(report.duplicateRemoteIdGroups).toBe(0);
  });

  it('ignores local tasks with no ext', () => {
    const report = computeIntegrityReport([], [
      { id: 'a' }, { id: 'b' }, { id: 'c', ext: {} },
    ]);
    expect(report.duplicateRemoteIdGroups).toBe(0);
    expect(report.duplicateTaskRows).toBe(0);
  });

  it('reports both corruptions independently in one pass', () => {
    const report = computeIntegrityReport(
      [{ claudeSessionId: 's1', taskId: 'deleted' }],
      [
        { id: 'a', ext: { acme: { id: 'R' } } },
        { id: 'b', ext: { acme: { id: 'R' } } },
      ],
    );
    expect(report.orphanedSessions).toBe(1);
    expect(report.duplicateRemoteIdGroups).toBe(1);
  });
});
