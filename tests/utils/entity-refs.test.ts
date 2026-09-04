/**
 * Unit tests for the shared entity-ref helpers (strip + extract). These back
 * both the mobile message normalization (api-v1) and the notification feed.
 */
import { describe, it, expect } from 'vitest';
import {
  stripEntityRefs, extractFirstRefs, projectRefTag, listEntityRefs,
} from '../../src/utils/entity-refs.js';

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

  it('strips a project ref down to its label', () => {
    expect(stripEntityRefs('work on <project-ref id="Marina" label="Marina"/> today'))
      .toBe('work on Marina today');
  });
});

describe('projectRefTag', () => {
  it('carries the name as the id and defaults the label to it', () => {
    expect(projectRefTag('Marina')).toBe('<project-ref id="Marina" label="Marina"/>');
  });

  it('takes an explicit label', () => {
    expect(projectRefTag('Marina', 'Marina (Q3)')).toBe('<project-ref id="Marina" label="Marina (Q3)"/>');
  });

  it('escapes quotes in both attributes', () => {
    expect(projectRefTag('the "big" one')).toBe('<project-ref id="the &quot;big&quot; one" label="the &quot;big&quot; one"/>');
  });

  it('round-trips through the strippers and extractors', () => {
    const tag = projectRefTag('the "big" one');
    expect(stripEntityRefs(tag)).toBe('the "big" one');
    expect(extractFirstRefs(tag).projectName).toBe('the "big" one');
  });
});

describe('listEntityRefs', () => {
  it('returns every ref of every kind in document order', () => {
    const input = `a ${projectRefTag('Marina')} b <task-ref id="t1" label="T1"/> c <session-ref id="s1"/>`;
    expect(listEntityRefs(input)).toEqual([
      { kind: 'project', id: 'Marina', label: 'Marina' },
      { kind: 'task', id: 't1', label: 'T1' },
      { kind: 'session', id: 's1' },
    ]);
  });

  it('is empty for plain text', () => {
    expect(listEntityRefs('nothing to see')).toEqual([]);
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

  it('pulls the first project name (identity IS the name, so it rides `id`)', () => {
    const input = 'a <project-ref id="Marina" label="Marina"/> b <project-ref id="Acme"/>';
    expect(extractFirstRefs(input)).toEqual({ projectName: 'Marina' });
  });
});
