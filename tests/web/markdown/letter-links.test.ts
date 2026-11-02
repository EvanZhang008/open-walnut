import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { linkLetterIds } from '@/utils/letter-links';

/**
 * A letter id in agent text opens that letter (web/src/utils/letter-links.ts,
 * opened by utils/open-anywhere.ts). 2026-11-02, the user on a Thread card that
 * pointed at a letter: "u can give me a link to the letter".
 */

const ID = 'lt-mvx2abcd-9f3k';
const LINK = `<a class="letter-link" data-letter-id="${ID}" href="#" title="Open this letter">${ID}</a>`;

describe('letter ids in rendered agent text', () => {
  it('a bare id in prose, CJK prose and a code span becomes the letter link', () => {
    expect(renderMarkdownWithRefs(`The video is in letter ${ID}.`)).toContain(LINK);
    // U+89C6 U+9891 ... : CJK prose around the id.
    expect(renderMarkdownWithRefs(`视频在信 ${ID} 里`)).toContain(LINK);
    expect(renderMarkdownWithRefs(`see \`${ID}\``)).toContain(LINK);
  });

  it('[words](letter:<id>) is a link with those words', () => {
    const html = renderMarkdownWithRefs(`[the letter](letter:${ID})`);
    expect(html).toContain(`<a class="letter-link" data-letter-id="${ID}" href="#" title="Open this letter">the letter</a>`);
  });

  it('a longer token, a path segment or an id inside a link stays as it is', () => {
    expect(linkLetterIds('<p>salt-lt-abc-defg and lt-abc-defgh-x</p>')).not.toContain('letter-link');
    expect(linkLetterIds(`<p>/tmp/${ID}/x</p>`)).not.toContain('letter-link');
    expect(linkLetterIds(`<p><a href="https://x.test/${ID}">${ID}</a></p>`)).not.toContain('letter-link');
    expect(linkLetterIds(`<button>${ID}</button>`)).not.toContain('letter-link');
  });

  it('a file preview (taskIds off) keeps the file as written', () => {
    expect(renderMarkdownWithRefs(`id ${ID}`, undefined, undefined, { taskIds: 'off' })).not.toContain('letter-link');
  });
});
