import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectingInside } from '../../web/src/apps/mail/MailMessageRow';

afterEach(() => vi.unstubAllGlobals());

describe('mail row and group summary selection', () => {
  const inside = {} as Node;
  const outside = {} as Node;
  const row = { contains: (node: Node) => node === inside } as Element;

  it.each([
    ['anchor inside', inside, outside, true],
    ['focus inside', outside, inside, true],
    ['both inside', inside, inside, true],
    ['selection elsewhere', outside, outside, false],
    ['no endpoints', null, null, false],
  ])('%s', (_name, anchorNode, focusNode, expected) => {
    vi.stubGlobal('window', { getSelection: () => ({ isCollapsed: false, anchorNode, focusNode, toString: () => 'selected words' }) });
    expect(selectingInside(row)).toBe(expected);
  });

  it('a collapsed or empty selection does not consume the click', () => {
    for (const [isCollapsed, words] of [[true, 'selected words'], [false, '   ']] as const) {
      vi.stubGlobal('window', { getSelection: () => ({ isCollapsed, anchorNode: inside, focusNode: inside, toString: () => words }) });
      expect(selectingInside(row)).toBe(false);
    }
  });

  it('no browser selection does not consume the click', () => {
    vi.stubGlobal('window', { getSelection: () => null });
    expect(selectingInside(row)).toBe(false);
  });
});
