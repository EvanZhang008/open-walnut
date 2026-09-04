import { describe, it, expect } from 'vitest';
import {
  extractEntityRefs,
  projectRefTag,
  sessionRefTag,
  taskRefTag,
} from '@/utils/entity-ref-tags';

/**
 * The client half of the entity-ref markup contract (server half:
 * src/utils/entity-refs.ts). Two things must hold or pills break:
 *   - builders escape `"` and ONLY `"` — anything more double-escapes downstream,
 *     where the render pipeline HTML-escapes for real;
 *   - a builder's output must parse back to the same values, spans included, so a
 *     composer can edit a pill in place instead of re-deriving positions.
 */

describe('ref tag builders', () => {
  it('build the three kinds with id + label', () => {
    expect(taskRefTag('t-1234567-abcd', 'Fix the thing')).toBe(
      '<task-ref id="t-1234567-abcd" label="Fix the thing"/>',
    );
    expect(sessionRefTag('sess-9', 'Nightly run')).toBe(
      '<session-ref id="sess-9" label="Nightly run"/>',
    );
    expect(projectRefTag('Marina', 'Marina Rebuild')).toBe(
      '<project-ref id="Marina" label="Marina Rebuild"/>',
    );
  });

  it('projectRefTag defaults the label to the name', () => {
    expect(projectRefTag('Marina')).toBe('<project-ref id="Marina" label="Marina"/>');
    // An explicitly empty label is a choice, not a missing one — it is not the name.
    expect(projectRefTag('Marina', '')).toBe('<project-ref id="Marina" label=""/>');
  });

  it('escapes `"` and nothing else', () => {
    expect(taskRefTag('t-1', 'The "Big" Push')).toBe(
      '<task-ref id="t-1" label="The &quot;Big&quot; Push"/>',
    );
    expect(projectRefTag('A "quoted" name')).toBe(
      '<project-ref id="A &quot;quoted&quot; name" label="A &quot;quoted&quot; name"/>',
    );
    // & < > stay raw: the render pipeline owns HTML escaping.
    expect(projectRefTag('A & <B>')).toBe('<project-ref id="A & <B>" label="A & <B>"/>');
  });
});

describe('extractEntityRefs', () => {
  it('returns nothing for text with no ref', () => {
    expect(extractEntityRefs('')).toEqual([]);
    expect(extractEntityRefs('plain prose with <div> and Array<T>')).toEqual([]);
    // A kind that does not exist is not a ref.
    expect(extractEntityRefs('<note-ref id="x"/>')).toEqual([]);
  });

  it('reports a span that slices the exact tag back out', () => {
    const tag = projectRefTag('Marina');
    const text = `filed under ${tag} today`;
    const [ref] = extractEntityRefs(text);
    expect(ref).toEqual({
      kind: 'project',
      id: 'Marina',
      label: 'Marina',
      start: 'filed under '.length,
      end: 'filed under '.length + tag.length,
    });
    expect(text.slice(ref.start, ref.end)).toBe(tag);
  });

  it('omits label entirely when the tag carries none', () => {
    const refs = extractEntityRefs('<project-ref id="Marina"/>');
    expect(refs).toHaveLength(1);
    expect(refs[0].label).toBeUndefined();
    expect('label' in refs[0]).toBe(false);
  });

  it('decodes &quot; back to a real quote in the label (id stays as written)', () => {
    const refs = extractEntityRefs(taskRefTag('t-1', 'The "Big" Push'));
    expect(refs[0].label).toBe('The "Big" Push');
    expect(refs[0].id).toBe('t-1');
  });

  it('returns every occurrence, mixed kinds, in document order with usable spans', () => {
    const parts = [
      'a ',
      taskRefTag('t-1', 'One'),
      ' b ',
      sessionRefTag('s-1', 'Two'),
      ' c ',
      projectRefTag('Marina'),
      ' d ',
      taskRefTag('t-2', 'Three'),
    ];
    const text = parts.join('');
    const refs = extractEntityRefs(text);
    expect(refs.map((r) => [r.kind, r.id])).toEqual([
      ['task', 't-1'],
      ['session', 's-1'],
      ['project', 'Marina'],
      ['task', 't-2'],
    ]);
    // Spans are non-overlapping, ascending, and each slices out its own tag.
    const tags = parts.filter((p) => p.startsWith('<'));
    refs.forEach((r, i) => expect(text.slice(r.start, r.end)).toBe(tags[i]));
    for (let i = 1; i < refs.length; i++) expect(refs[i].start).toBeGreaterThanOrEqual(refs[i - 1].end);
  });

  it('accepts the non-self-closing and unlabeled shapes the same regex allows', () => {
    const refs = extractEntityRefs('<task-ref id="t-1"><session-ref id="s-1" label="S"/>');
    expect(refs.map((r) => r.kind)).toEqual(['task', 'session']);
    expect(refs[0].label).toBeUndefined();
    expect(refs[1].label).toBe('S');
  });

  it('two calls on the same text agree (no shared lastIndex state)', () => {
    const text = `${projectRefTag('P')} ${projectRefTag('Q')}`;
    expect(extractEntityRefs(text)).toEqual(extractEntityRefs(text));
    expect(extractEntityRefs(text)).toHaveLength(2);
  });
});
