/**
 * Number keys and Enter on prompt cards (web/src/components/sessions/prompt-keys.ts):
 * which key counts, where typing is text, and which card a key answers when several
 * columns each show one. The dispatch itself runs in the browser spec
 * (tests/e2e/browser/permission-prompt-keys.spec.ts); this tier has no DOM.
 */
import { describe, expect, it } from 'vitest';
import { denyNoteMessage, isTextEntry, noteOfDenyMessage, pickPromptCard, promptKeyOf, promptKeyRange, promptKeyList, choiceKeys } from '@/components/sessions/prompt-keys';

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('promptKeyOf', () => {
  it('a bare digit 1..9 or a bare Enter', () => {
    expect(promptKeyOf(key('1'))).toEqual({ digit: 1 });
    expect(promptKeyOf(key('9'))).toEqual({ digit: 9 });
    expect(promptKeyOf(key('Enter'))).toBe('enter');
  });
  it.each([
    ['0', {}], ['a', {}], ['F1', {}], ['1', { metaKey: true }], ['2', { ctrlKey: true }], ['3', { altKey: true }],
    ['!', { shiftKey: true }], ['Enter', { shiftKey: true }], ['Enter', { metaKey: true }],
  ])('not %s with %o', (k, mods) => {
    expect(promptKeyOf(key(k, mods))).toBeNull();
  });
});

/** Minimal element for the text-entry check. */
function el(tagName: string, extra: Record<string, unknown> = {}, insideEditor = false) {
  return { tagName, ...extra, closest: (sel: string) => (insideEditor && sel.includes('contenteditable') ? {} : null) };
}

describe('isTextEntry', () => {
  it('fields are text', () => {
    expect(isTextEntry(el('TEXTAREA'))).toBe(true);
    expect(isTextEntry(el('INPUT', { type: 'text' }))).toBe(true);
    expect(isTextEntry(el('INPUT', { type: '' }))).toBe(true);
    expect(isTextEntry(el('SELECT'))).toBe(true);
    expect(isTextEntry(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTextEntry(el('SPAN', {}, true))).toBe(true);
  });
  it('buttons, checkboxes, body and nothing are not', () => {
    expect(isTextEntry(el('BUTTON'))).toBe(false);
    expect(isTextEntry(el('INPUT', { type: 'checkbox' }))).toBe(false);
    expect(isTextEntry(el('BODY'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

/** A node in a tree with a document order. */
class FakeNode {
  children: FakeNode[] = [];
  constructor(public name: string, public parent: FakeNode | null = null, public order = 0) { parent?.children.push(this); }
  contains(other: unknown): boolean {
    for (let n = other as FakeNode | null; n; n = n.parent) if (n === this) return true;
    return false;
  }
  compareDocumentPosition(other: unknown): number {
    return (other as FakeNode).order > this.order ? 4 : 2;
  }
}

describe('pickPromptCard', () => {
  const root = new FakeNode('root');
  const left = new FakeNode('left', root, 1);
  const right = new FakeNode('right', root, 10);
  const leftOld = new FakeNode('left-old', left, 2);
  const leftNew = new FakeNode('left-new', left, 3);
  const leftBtn = new FakeNode('left-old-button', leftOld, 2.5);
  const rightCard = new FakeNode('right-card', right, 11);
  const cards = [leftNew, rightCard, leftOld].map((n) => ({ el: n as unknown as Element, item: n.name }));

  it('the card holding focus wins', () => {
    expect(pickPromptCard(cards, leftBtn as unknown as Node, right as unknown as Element)).toBe('left-old');
  });
  it('else the newest card in the panel keys go to, never another column\'s', () => {
    expect(pickPromptCard(cards, null, left as unknown as Element)).toBe('left-new');
    expect(pickPromptCard(cards, null, right as unknown as Element)).toBe('right-card');
  });
  it('a panel with no card takes no key', () => {
    const empty = new FakeNode('empty', root, 20);
    expect(pickPromptCard(cards, null, empty as unknown as Element)).toBeNull();
  });
  it('no panel: only a page with one card answers', () => {
    expect(pickPromptCard(cards, null, null)).toBeNull();
    expect(pickPromptCard(cards.slice(1, 2), null, null)).toBe('right-card');
  });
});

describe('the note a deny carries', () => {
  it('round-trips, trimmed', () => {
    const message = denyNoteMessage('  use pnpm instead ');
    expect(message).toBe('The user denied this tool call and said: use pnpm instead');
    expect(noteOfDenyMessage(message)).toBe('use pnpm instead');
    expect(noteOfDenyMessage('User dismissed the questions')).toBeNull();
    expect(noteOfDenyMessage(undefined)).toBeNull();
  });
  it('the key range', () => {
    expect(promptKeyRange(2)).toBe('1–2');
    expect(promptKeyList([1, 2, 3, 4])).toBe('1–4');
    expect(promptKeyList([1, 4])).toBe('1 or 4');
    expect(promptKeyList([1, 2, 4])).toBe('1, 2 or 4');
    expect(promptKeyRange(12)).toBe('1–9');
    expect(promptKeyRange(1)).toBe('1');
  });
});

describe('choiceKeys', () => {
  it("keeps a Claude prompt's numbers fixed, whichever choices a card offers", () => {
    expect(choiceKeys(['allow_once', 'allow_session', 'allow_always', 'reject_once'])).toEqual([1, 2, 3, 4])
    // A long one-off command (no project choice) and a "*" command (no remembering choices).
    expect(choiceKeys(['allow_once', 'allow_session', 'reject_once'])).toEqual([1, 2, 4])
    expect(choiceKeys(['allow_once', 'reject_once'])).toEqual([1, 4])
  })
  it('numbers any other list in order', () => {
    expect(choiceKeys(['allow', 'deny'])).toEqual([1, 2])
    expect(choiceKeys([undefined, undefined])).toEqual([1, 2])
    expect(choiceKeys(['allow_once', 'proceed_always', 'reject_once'])).toEqual([1, 2, 3])
  })
})
