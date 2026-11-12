import { describe, it, expect } from 'vitest';
import { chunkByKind, foldsAsOne, leadingStepGroup, settleWords, stepGroups, type StepKind } from '../../web/src/components/sessions/stream-step-groups';

const K = (s: string): StepKind[] => s.split('').map((c) => ({ s: 'step', c: 'card', n: 'send', w: 'words', a: 'agent', '.': 'silent', o: 'other' } as const)[c as 's' | 'c' | 'n' | 'w' | 'a' | '.' | 'o']);

describe('stepGroups', () => {
  it('the reported stretch is one group: card, thinking, card, commands, card, command', () => {
    expect(stepGroups(K('cscsssscs'))).toEqual([{ members: [0, 1, 2, 3, 4, 5, 6, 7, 8], cards: 3, steps: 6, sends: 0, words: 0, agents: 0 }]);
  });
  it('silent items neither join nor split', () => {
    expect(stepGroups(K('c.s..c'))).toEqual([{ members: [0, 2, 5], cards: 2, steps: 1, sends: 0, words: 0, agents: 0 }]);
  });
  it('anything a reader sees splits', () => {
    expect(stepGroups(K('csocs'))).toEqual([
      { members: [0, 1], cards: 1, steps: 1, sends: 0, words: 0, agents: 0 },
      { members: [3, 4], cards: 1, steps: 1, sends: 0, words: 0, agents: 0 },
    ]);
    expect(stepGroups(K('ooo'))).toEqual([]);
  });
});

describe('leadingStepGroup', () => {
  it('is the group the timeline opens with', () => {
    expect(leadingStepGroup(K('..scos'))).toEqual({ members: [2, 3], cards: 1, steps: 1, sends: 0, words: 0, agents: 0 });
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
    expect(stepGroups(K('snno'))).toEqual([{ members: [0, 1, 2], cards: 0, steps: 1, sends: 2, words: 0, agents: 0 }]);
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

// 2026-11-12, the user, of a live turn whose words and subagent sat between two folds:
// "If they are togter they need ot be collpesed". Every pair of step kinds is one fold.
describe('words and agents are steps of the turn', () => {
  it('words on the way, with a step after them, stay words; the last words are the answer so far', () => {
    expect(settleWords(K('wsw'))).toEqual(K('wso'));
    expect(settleWords(K('w.s'))).toEqual(K('w.s'));
    // A reader's row ends the turn's stretch: words before it with no step after them are an answer.
    expect(settleWords(K('wos'))).toEqual(K('oos'));
    expect(settleWords(K('was'))).toEqual(K('was'));
    // A card is not the session working on: a short answer before the notes delivered at
    // its turn's end stays the answer.
    expect(settleWords(K('wc'))).toEqual(K('oc'));
    expect(settleWords(K('wcs'))).toEqual(K('wcs'));
  });
  it('words before a step of another turn or question are that turn\'s answer', () => {
    const seg = (cut: number) => (i: number) => (i < cut ? 'a' : 'b');
    expect(settleWords(K('wss'), seg(1))).toEqual(K('oss'));
    expect(settleWords(K('wsws'), seg(2))).toEqual(K('wsws'));
    expect(settleWords(K('wsws'), seg(3))).toEqual(K('wsos'));
  });
  it('any two kinds of step in a row are one fold', () => {
    const kinds = ['s', 'c', 'w', 'a'];
    for (const x of kinds) for (const y of kinds) {
      const [g] = stepGroups(K(`${x}${y}`));
      expect(g.members, `${x}${y}`).toEqual([0, 1]);
      expect(foldsAsOne(g), `${x}${y}`).toBe(x !== y);
    }
    expect(foldsAsOne(stepGroups(K('wsacn'))[0])).toBe(true);
  });
  it('the live turn opens with its words', () => {
    expect(leadingStepGroup(settleWords(K('wsas')))).toEqual({ members: [0, 1, 2, 3], cards: 0, steps: 2, sends: 0, words: 1, agents: 1 });
  });
  it('words and agents keep their own chunk in the fold', () => {
    const kinds = K('wssaw');
    expect(chunkByKind([0, 1, 2, 3, 4], (i) => kinds[i])).toEqual([
      { kind: 'words', members: [0] }, { kind: 'step', members: [1, 2] }, { kind: 'agent', members: [3] }, { kind: 'words', members: [4] },
    ]);
  });
});
