import { describe, it, expect } from 'vitest';
import { chunkByKind, leadingStepGroup, stepGroups, type StepKind } from '../../web/src/components/sessions/stream-step-groups';

const K = (s: string): StepKind[] => s.split('').map((c) => ({ s: 'step', c: 'card', '.': 'silent', o: 'other' } as const)[c as 's' | 'c' | '.' | 'o']);

describe('stepGroups', () => {
  it('the reported stretch is one group: card, thinking, card, commands, card, command', () => {
    expect(stepGroups(K('cscsssscs'))).toEqual([{ members: [0, 1, 2, 3, 4, 5, 6, 7, 8], cards: 3, steps: 6 }]);
  });
  it('silent items neither join nor split', () => {
    expect(stepGroups(K('c.s..c'))).toEqual([{ members: [0, 2, 5], cards: 2, steps: 1 }]);
  });
  it('anything a reader sees splits', () => {
    expect(stepGroups(K('csocs'))).toEqual([
      { members: [0, 1], cards: 1, steps: 1 },
      { members: [3, 4], cards: 1, steps: 1 },
    ]);
    expect(stepGroups(K('ooo'))).toEqual([]);
  });
});

describe('leadingStepGroup', () => {
  it('is the group the timeline opens with', () => {
    expect(leadingStepGroup(K('..scos'))).toEqual({ members: [2, 3], cards: 1, steps: 1 });
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
