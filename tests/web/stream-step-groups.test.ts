import { describe, it, expect } from 'vitest';
import { chunkByKind, foldsAsOne, leadingStepGroup, stepGroups, type StepKind } from '../../web/src/components/sessions/stream-step-groups';

const K = (s: string): StepKind[] => s.split('').map((c) => ({ s: 'step', c: 'card', n: 'send', '.': 'silent', o: 'other' } as const)[c as 's' | 'c' | 'n' | '.' | 'o']);

describe('stepGroups', () => {
  it('the reported stretch is one group: card, thinking, card, commands, card, command', () => {
    expect(stepGroups(K('cscsssscs'))).toEqual([{ members: [0, 1, 2, 3, 4, 5, 6, 7, 8], cards: 3, steps: 6, sends: 0 }]);
  });
  it('silent items neither join nor split', () => {
    expect(stepGroups(K('c.s..c'))).toEqual([{ members: [0, 2, 5], cards: 2, steps: 1, sends: 0 }]);
  });
  it('anything a reader sees splits', () => {
    expect(stepGroups(K('csocs'))).toEqual([
      { members: [0, 1], cards: 1, steps: 1, sends: 0 },
      { members: [3, 4], cards: 1, steps: 1, sends: 0 },
    ]);
    expect(stepGroups(K('ooo'))).toEqual([]);
  });
});

describe('leadingStepGroup', () => {
  it('is the group the timeline opens with', () => {
    expect(leadingStepGroup(K('..scos'))).toEqual({ members: [2, 3], cards: 1, steps: 1, sends: 0 });
  });
  it('is null when something visible comes first, or nothing does', () => {
    expect(leadingStepGroup(K('.osc'))).toBeNull();
    expect(leadingStepGroup(K('..'))).toBeNull();
  });
});

describe('chunkByKind', () => {
  it('keeps each stretch of one kind together, in order', () => {
    const kinds = K('cscssc');
    expect(chunkByKind([0, 1, 2, 3, 4, 5], (i) => kinds[i])).toEqual([
      { kind: 'card', members: [0] }, { kind: 'step', members: [1] }, { kind: 'card', members: [2] },
      { kind: 'step', members: [3, 4] }, { kind: 'card', members: [5] },
    ]);
  });
});

describe('sends', () => {
  it('a send joins the stretch and makes it one fold, alone or with steps', () => {
    // The reported turn: reasoning, two sends, then the answer.
    expect(stepGroups(K('snno'))).toEqual([{ members: [0, 1, 2], cards: 0, steps: 1, sends: 2 }]);
    expect(foldsAsOne(stepGroups(K('snno'))[0])).toBe(true);
    expect(foldsAsOne(stepGroups(K('no'))[0])).toBe(true);
  });
  it('cards alone and steps alone keep their own row', () => {
    expect(foldsAsOne(stepGroups(K('cc'))[0])).toBe(false);
    expect(foldsAsOne(stepGroups(K('ss'))[0])).toBe(false);
    expect(foldsAsOne(stepGroups(K('cs'))[0])).toBe(true);
  });
  it('a send keeps its own chunk in the fold', () => {
    const kinds = K('snnc');
    expect(chunkByKind([0, 1, 2, 3], (i) => kinds[i])).toEqual([
      { kind: 'step', members: [0] }, { kind: 'send', members: [1, 2] }, { kind: 'card', members: [3] },
    ]);
  });
});
