/**
 * Unit tests for the shared entity-ref helpers (strip + extract). These back
 * both the mobile message normalization (api-v1) and the notification feed.
 */
import { describe, it, expect } from 'vitest';
import { stripEntityRefs, extractFirstRefs } from '../../src/utils/entity-refs.js';

describe('stripEntityRefs', () => {
  it('replaces XML refs with their label', () => {
    const input = 'Task <task-ref id="mr1-0001" label="Daily Report"/> via <session-ref id="abc-def" label="CLI run"/>';
    expect(stripEntityRefs(input)).toBe('Task Daily Report via CLI run');
  });

  it('falls back to the id when unlabeled', () => {
    expect(stripEntityRefs('<task-ref id="mr1-0001"/>')).toBe('mr1-0001');
  });

  it('replaces legacy bracket refs with their label', () => {
    expect(stripEntityRefs('see [mr9i88ys-87a4|Some Label] here')).toBe('see Some Label here');
  });

  it('leaves plain text untouched', () => {
    expect(stripEntityRefs('no refs at all')).toBe('no refs at all');
  });
});

describe('extractFirstRefs', () => {
  it('pulls the first session and task ids', () => {
    const input = 'a <task-ref id="t1" label="T1"/> b <session-ref id="s1" label="S1"/> c <session-ref id="s2"/>';
    expect(extractFirstRefs(input)).toEqual({ taskId: 't1', sessionId: 's1' });
  });

  it('returns empty when nothing matches', () => {
    expect(extractFirstRefs('plain text')).toEqual({});
  });
});
