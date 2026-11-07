/**
 * The org chart's aria-controls ids come from row keys, which hold spaces and any character a
 * project name has: the encoding must give two keys two ids (a review found "Review Space" and
 * "Review_20Space" sharing one).
 */
import { describe, expect, it } from 'vitest';
import { domId } from '../../web/src/components/org/OrgChartVp';

describe('org chart domId', () => {
  it('is a valid id with no spaces, and one to one', () => {
    const keys = ['project:review space', 'project:review_20space', 'project:review_0020space', 'project:a\u00020', 'project:a ', 'project:\u82b1\u56ed', 'main'];
    const ids = keys.map((k) => domId('oc-tasks', k));
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(new Set(ids).size).toBe(keys.length);
  });
});
