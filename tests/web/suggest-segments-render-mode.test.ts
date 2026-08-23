/**
 * Which render path a message takes: the cheap raw-string markdown render, or the
 * segment list.
 *
 * This decision is not cosmetic. splitSuggestSegments carefully WITHHOLDS an
 * unterminated card (hidden to end-of-text so a half-arrived card never shows a
 * live button), but that hiding only happens if the caller renders the SEGMENTS.
 * Hand the raw string to the markdown renderer instead and the hiding is thrown
 * away: DOMPurify drops the unknown `<suggest>`/`<action>` tags but KEEPS the text
 * between them, so the card's body appeared as a stray prose line mid-stream and
 * then vanished when the closer landed and the real card replaced it.
 *
 * So `needsSegments` has to be true in two cases, not one — a card to mount, and
 * a withheld region — while staying false for the overwhelmingly common plain
 * message, which must keep the fast path.
 *
 * It lives in the dependency-free parser module, not next to the React component
 * that calls it: this tier cannot resolve marked/dompurify (web/node_modules), and
 * a pure predicate about segments has no business behind that import wall.
 */
import { describe, it, expect } from 'vitest';
import { splitSuggestSegments, needsSegments } from '@/utils/suggest-parse';

/** What the renderer asks: does this text need the segment list? */
function needs(text: string): boolean {
  return needsSegments(splitSuggestSegments(text), text);
}

const OPEN = [
  'That task has not moved in three weeks.',
  '',
  '<suggest title="Triage this">',
  'It looks stale — put it in Focus?',
  '<action tool="task_focus_tier_set" args=\'{"id":"t_1","tier":"focus"}\' label="Put to Focus" style="primary"/>',
].join('\n');

describe('needsSegments', () => {
  it('keeps the fast path for ordinary text', () => {
    expect(needs('Just **prose** with a `<code>` sample and a [link](/x).')).toBe(false);
    expect(needs('')).toBe(false);
    expect(needs('   \n  ')).toBe(false);
  });

  it('keeps the fast path for a prose mention of the tag', () => {
    // looksLikeStreamingCard keeps this text intact, so nothing was withheld and
    // the answer must not be routed through the card renderer.
    expect(needs('You can wrap it in a <suggest> block if you like.')).toBe(false);
    expect(needs('A fenced sample:\n\n```\n<suggest title="x"><action dismiss/></suggest>\n```\n')).toBe(false);
  });

  it('takes the segment path for a complete card', () => {
    expect(needs(`${OPEN}\n</suggest>\n\nDone.`)).toBe(true);
  });

  it('takes the segment path while a card is still arriving', () => {
    // The regression: this used to be false, so the raw string rendered and the
    // body ("It looks stale …") leaked as prose.
    expect(needs(OPEN)).toBe(true);
    const segments = splitSuggestSegments(OPEN);
    expect(segments).toHaveLength(1);
    expect((segments[0] as { text: string }).text).toContain('has not moved in three weeks');
    expect((segments[0] as { text: string }).text).not.toContain('It looks stale');
    expect((segments[0] as { text: string }).text).not.toContain('<suggest');
  });

  it('takes the segment path for a partial open tag on the tail', () => {
    expect(needs('Here you go.\n\n<suggest tit')).toBe(true);
  });
});
