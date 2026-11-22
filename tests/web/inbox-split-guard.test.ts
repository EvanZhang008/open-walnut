import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const web = path.resolve(__dirname, '../../web/src');
const read = (p: string) => fs.readFileSync(path.join(web, p), 'utf8');

describe('inbox split uses one reader and kept view choices', () => {
  it('layout and density live in view memory, not transient component state', () => {
    // The notification center's letter state lives in its own hook (useNotificationLetters.ts).
    expect(read('components/common/useNotificationLetters.ts')).toContain("usePageView<InboxLayout>('inbox', 'layout', 'cards', isInboxLayout)");
    expect(read('components/common/useNotificationLetters.ts')).toContain('const changeInboxLayout = useLeanCallback(');
    expect(read('components/inbox/InboxPane.tsx')).toContain("usePageView<InboxDensity>('inbox', 'density', 'roomy', isInboxDensity)");
  });

  it('the embedded and overlay hosts share the same letter behavior', () => {
    const source = read('components/inbox/LetterReader.tsx');
    expect(source.match(/<LetterView\b/g)).toHaveLength(1);
    expect(source).toContain('key={letterId}');
    expect(source).toContain('if (!embedded) lockScroll()');
    expect(source).toContain('if (embedded) return');
  });

  it('split rows keep whole-container peek and do not duplicate the body in the list', () => {
    const source = read('components/inbox/LetterEnvelopeRow.tsx');
    expect(source).toContain('data-peek-row=""');
    expect(source).toContain('{!indexRow && <div id={bodyId}');
    // An index row's Read letter opens the reader; only a card's is the disclosure that unfolds it here.
    expect(source).toMatch(/\{indexRow \? \(\s*<button[^>]*onClick=\{\(event\) => \{ event\.stopPropagation\(\); onOpen\(\); \}\}/);
    expect(source).toMatch(/<DisclosureButton expanded=\{expanded\}[\s\S]*?toggleExpanded\(\)/);
    const css = read('styles/inbox-split.css');
    expect(css).toContain('@container (max-width: 620px)');
    expect(css).toContain('grid-template-rows: minmax(100px, 32%) minmax(0, 1fr)');
  });
});
