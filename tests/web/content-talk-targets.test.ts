/**
 * Who the Talk to box opens on (web/src/utils/content-actions.ts pickTarget): the CEO by default,
 * the node asked for by id, and for a mail's Ask router the router of THAT mail's area only. An area
 * whose router is gone opens on the CEO, never on another area's router (2026-11-16 review: the box
 * would have named the wrong router and the send would have looked intended).
 */
import { describe, expect, it } from 'vitest';
import { CEO_TARGET, pickTarget, routerOfArea, type ContentTarget } from '../../web/src/utils/content-actions';

const ceo: ContentTarget = { id: 'mvil3n7t-5e42', kind: 'ceo', name: 'CEO' };
const personal: ContentTarget = { id: 'router-personal', kind: 'router', name: 'Personal mail router', areaId: 'personal' };
const work: ContentTarget = { id: 'router-work', kind: 'router', name: 'Work mail router', areaId: 'work' };
const vp: ContentTarget = { id: 'vp-walnut', kind: 'vp', name: 'Walnut VP' };
const all = [ceo, work, personal, vp];

describe('pickTarget', () => {
  it('opens on the CEO when nothing is asked, or the asked id is not offered', () => {
    expect(pickTarget(all)).toBe(ceo);
    expect(pickTarget(all, { id: 'gone' })).toBe(ceo);
    expect(pickTarget([], undefined)).toBe(CEO_TARGET);
  });

  it('opens on the node asked for by id', () => {
    expect(pickTarget(all, { id: vp.id })).toBe(vp);
    expect(pickTarget(all, { id: work.id })).toBe(work);
  });

  it("opens on the router of the mail's own area, and on the CEO when that area has none", () => {
    expect(pickTarget(all, { areaId: 'personal' })).toBe(personal);
    expect(pickTarget(all, { areaId: 'work' })).toBe(work);
    expect(pickTarget(all, { areaId: 'team' })).toBe(ceo);
    expect(routerOfArea(all, 'team')).toBeUndefined();
    // A VP never stands in for a router, whatever it is called.
    expect(routerOfArea([ceo, { ...vp, areaId: 'team' } as ContentTarget], 'team')).toBeUndefined();
  });
});
