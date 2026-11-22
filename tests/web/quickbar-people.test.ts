/**
 * The quick bar's people rules (web/src/components/quickbar/quickbar-people.ts): the list order,
 * the person it opens on, and the name said first in a dictation picking who gets it.
 */
import { describe, it, expect } from 'vitest';
import {
  addresseeOf, filterPeople, sectionPeople, startingPerson, initialsOf, personOfRecent, quickSwitchTarget,
  RECENT_TASK_MS, type QuickPerson, type RecentSend,
} from '../../web/src/components/quickbar/quickbar-people';

const p = (id: string, title: string, kind: QuickPerson['kind'], extra: Partial<QuickPerson> = {}): QuickPerson => ({
  id, title, kind, project: '', state: 'waiting', stateLabel: 'Waiting', line: '', needs: 0, ...extra,
});

const ceo = p('m1', 'CEO', 'ceo');
const walnut = p('v1', 'Walnut VP', 'vp');
const garden = p('v2', 'Garden VP', 'vp');
const tile = p('t1', 'Pick the tile color', 'task', { state: 'needs' });
const beds = p('t2', 'Plan the beds', 'task');
const people = [ceo, walnut, garden, tile, beds];
const NOW = 1_800_000_000_000;

describe('sectionPeople', () => {
  it('lists the CEO, then VPs by the last send, then tasks sent to lately, then the rest', () => {
    const recents = [{ id: 't2', title: 'Plan the beds', at: NOW - 60_000 }, { id: 'v2', title: 'Garden VP', at: NOW - 120_000 }];
    const sections = sectionPeople(people, recents, NOW);
    expect(sections.map((s) => s.label)).toEqual(['Pinned', 'VPs', 'Recent', 'Tasks']);
    expect(sections.map((s) => s.people.map((x) => x.id))).toEqual([['m1'], ['v2', 'v1'], ['t2'], ['t1']]);
  });

  it('keeps a recent task the server no longer lists, and drops one past two days', () => {
    const recents = [
      { id: 'gone', title: 'Finished thing', at: NOW - 1000 },
      { id: 'old', title: 'Old thing', at: NOW - RECENT_TASK_MS - 1 },
    ];
    const recent = sectionPeople(people, recents, NOW).find((s) => s.label === 'Recent')!;
    expect(recent.people.map((x) => [x.id, x.title])).toEqual([['gone', 'Finished thing']]);
  });
});

const DAY = 24 * 3_600_000;
const r = (id: string, title: string, at: number, kind?: QuickPerson['kind']): RecentSend => ({ id, title, at, ...(kind ? { kind } : {}) });

describe('startingPerson (the last one chosen, however long ago)', () => {
  it('opens on the last one sent to, even days later', () => {
    expect(startingPerson(people, [r('v2', 'Garden VP', NOW - 1000)])?.id).toBe('v2');
    expect(startingPerson(people, [r('v2', 'Garden VP', NOW - 3 * DAY)])?.id).toBe('v2');
  });
  it('a pick by hand that was never sent counts, the newer of the two wins', () => {
    expect(startingPerson(people, [r('v2', 'Garden VP', NOW - DAY)], [r('v1', 'Walnut VP', NOW - 1000)])?.id).toBe('v1');
    expect(startingPerson(people, [r('v2', 'Garden VP', NOW - 1000)], [r('v1', 'Walnut VP', NOW - DAY)])?.id).toBe('v2');
  });
  it('the CEO chosen last is remembered too', () => {
    expect(startingPerson(people, [r('v1', 'Walnut VP', NOW - DAY)], [r('m1', 'CEO', NOW - 1000)])?.id).toBe('m1');
  });
  it('the CEO when nothing was chosen or the one chosen is no longer listed (a finished task)', () => {
    expect(startingPerson(people, [])?.id).toBe('m1');
    expect(startingPerson(people, [], [r('gone', 'Old task', NOW - 1000)])?.id).toBe('m1');
    expect(startingPerson([], [])).toBeNull();
  });
});

describe('quickSwitchTarget (Shift-Tab)', () => {
  it('goes to the CEO from a VP or a task', () => {
    expect(quickSwitchTarget(walnut, people, [], [])?.id).toBe('m1');
    expect(quickSwitchTarget(tile, people, [], [])?.id).toBe('m1');
  });
  it('from the CEO goes back to the last one chosen who is not the CEO', () => {
    const chosen = [r('m1', 'CEO', NOW - 100), r('v1', 'Walnut VP', NOW - 1000), r('v2', 'Garden VP', NOW - 2000)];
    expect(quickSwitchTarget(ceo, people, [], chosen)?.id).toBe('v1');
    // A send newer than the picks counts first.
    expect(quickSwitchTarget(ceo, people, [r('t2', 'Plan the beds', NOW - 500)], chosen)?.id).toBe('t2');
  });
  it('skips one no longer listed; nobody to go back to is undefined (the Tab list opens)', () => {
    expect(quickSwitchTarget(ceo, people, [], [r('gone', 'Old task', NOW - 100), r('v2', 'Garden VP', NOW - 1000)])?.id).toBe('v2');
    expect(quickSwitchTarget(ceo, people, [], [r('m1', 'CEO', NOW)])).toBeUndefined();
    expect(quickSwitchTarget(null, people, [], [])).toBeUndefined();
  });
  it('the people list did not load: from a VP it is null, the CEO the chip names', () => {
    expect(quickSwitchTarget(walnut, [], [], [])).toBeNull();
  });
});

describe('addresseeOf', () => {
  it('picks the person named first, English and Chinese, and strips the address', () => {
    expect(addresseeOf('to Walnut VP, ship the bar first', people)).toMatchObject({ person: { id: 'v1' }, rest: 'ship the bar first' });
    expect(addresseeOf('Garden VP: water the beds', people)).toMatchObject({ person: { id: 'v2' }, rest: 'water the beds' });
    expect(addresseeOf('tell the CEO... no', people)).toBeNull();
    expect(addresseeOf('tell CEO that the demo moved', people)).toMatchObject({ person: { id: 'm1' }, rest: 'that the demo moved' });
    // "gei Walnut VP, ..." with a full-width comma (U+FF0C).
    expect(addresseeOf('\u7ed9 Walnut VP\uff0c\u5148\u505a\u7b2c\u4e00\u7248', people)).toMatchObject({ person: { id: 'v1' }, rest: '\u5148\u505a\u7b2c\u4e00\u7248' });
    // "gen Garden VP shuo ..." with no comma: "say" ends the address.
    expect(addresseeOf('\u8ddfGarden VP\u8bf4\u660e\u5929\u6d47\u6c34', people)).toMatchObject({ person: { id: 'v2' }, rest: '\u660e\u5929\u6d47\u6c34' });
    // A VP by its bare name, and names said with odd spacing.
    expect(addresseeOf('Walnut, check the build', people)).toMatchObject({ person: { id: 'v1' } });
    expect(addresseeOf('walnut vp - check the build', people)).toMatchObject({ person: { id: 'v1' }, rest: 'check the build' });
  });

  it('leaves a sentence that only mentions someone, or has nothing after the name', () => {
    expect(addresseeOf('Walnut is slow today', people)).toBeNull();
    expect(addresseeOf('the Walnut VP said hi', people)).toBeNull();
    expect(addresseeOf('to Walnut VP,', people)).toBeNull();
    expect(addresseeOf('', people)).toBeNull();
  });

  it('prefers the longest name: "Walnut VP" over a task called "Walnut"', () => {
    const both = [...people, p('t3', 'Walnut', 'task')];
    expect(addresseeOf('to Walnut VP, hi there', both)?.person.id).toBe('v1');
    expect(addresseeOf('to Walnut, hi there', both)?.person.id).toBe('t3');
  });
});

describe('filterPeople and initials', () => {
  it('matches every word, title starts first, org nodes before tasks', () => {
    expect(filterPeople(people, 'vp').map((x) => x.id)).toEqual(['v1', 'v2']);
    expect(filterPeople(people, 'the').map((x) => x.id)).toEqual(['t1', 't2']);
    expect(filterPeople(people, 'plan beds').map((x) => x.id)).toEqual(['t2']);
    expect(filterPeople(people, '').length).toBe(5);
    expect([initialsOf(ceo), initialsOf(walnut), initialsOf(tile)]).toEqual(['CEO', 'W', 'P']);
  });
});

describe('personOfRecent (the people list did not load)', () => {
  it('opens on the last one chosen or sent to, as a loaded list would, so the chip and the send stay one person', () => {
    expect(personOfRecent([r('v1', 'Walnut VP', NOW - 3 * DAY, 'vp')])).toMatchObject({ id: 'v1', title: 'Walnut VP', kind: 'vp' })
    expect(personOfRecent([r('v1', 'Walnut VP', NOW - DAY, 'vp')], [r('v2', 'Garden VP', NOW - 1000, 'vp')])).toMatchObject({ id: 'v2' })
    // An entry written before `kind` was kept still names its person.
    expect(personOfRecent([r('t1', 'Pick the tile color', NOW - 60_000)])).toMatchObject({ id: 't1', title: 'Pick the tile color' })
  })
  it('nobody when nothing was chosen, or the CEO was chosen while the list did not load (no id)', () => {
    expect(personOfRecent([])).toBeNull()
    expect(personOfRecent([r('v1', 'Walnut VP', NOW - DAY, 'vp')], [r('', 'CEO', NOW - 1000, 'ceo')])).toBeNull()
    expect(startingPerson(people, [r('v1', 'Walnut VP', NOW - DAY, 'vp')], [r('', 'CEO', NOW - 1000, 'ceo')])?.id).toBe('m1')
  })
})
