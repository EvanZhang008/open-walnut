import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs, renderNoteMarkdown, markdownToRichHtml } from '@/utils/markdown';

/**
 * Contract: strikethrough requires DOUBLE tildes on EVERY renderer, not just the
 * task-note one.
 *
 * The 2026-07-28 bug: marked's default `del` tokenizer opens on a SINGLE `~`, so
 * two unrelated approximations in one paragraph ("watching ~550K objects … cache
 * (~20 min rebuild)") paired up and struck out everything between them — including
 * the <strong> runs. It surfaced in the session Files tab rendering an incident
 * write-up, but the same global `marked` singleton backs chat, the Changed tab's
 * markdown rows, the context inspector and copy-as-rich-text.
 *
 * The note renderer had a LOCAL fix from 2026-07-19; these tests pin the retune at
 * the shared level so a marked bump or a new consumer can't silently regress it.
 * GitHub itself only strikes on `~~`, so double-tilde is the GFM-correct behavior.
 */

/** The shape of the paragraph from the report (names genericized), which rendered fully struck. */
const INCIDENT_PROSE =
  'The primary controller (watching ~550K K8s objects, largest in the fleet) has been ' +
  '**silently losing its leader lease and restarting** — recently ~694 times per two ' +
  'weeks, roughly every 30 minutes, with no alarm ever firing on it (a recorded ' +
  'detection gap). Each restart wipes the in-memory cache (~20 min cold rebuild), ' +
  'loses DELETE events during the window, and feeds the repair storms of Layer 2.';

describe('del requires double tildes (global marked singleton)', () => {
  it('the reported paragraph renders with NO strikethrough', () => {
    const html = renderMarkdownWithRefs(INCIDENT_PROSE);
    expect(html).not.toContain('<del>');
    // The approximations survive as literal text…
    expect(html).toContain('~550K');
    expect(html).toContain('~694');
    expect(html).toContain('~20 min');
    // …and the bold run inside the former strike range is still bold.
    expect(html).toContain('<strong>silently losing its leader lease and restarting</strong>');
  });

  it('a single pair of lone tildes cannot strike across a paragraph', () => {
    const html = renderMarkdownWithRefs('grew to ~100 nodes, then dropped to ~25 nodes.');
    expect(html).not.toContain('<del>');
    expect(html).toContain('~100 nodes');
    expect(html).toContain('~25 nodes');
  });

  it('double-tilde still produces <del> on the chat/file path', () => {
    expect(renderMarkdownWithRefs('a ~~struck~~ b')).toContain('<del>struck</del>');
    expect(renderMarkdownWithRefs('~~x~~')).toContain('<del>x</del>');
  });

  it('an odd lone tilde does not swallow a later real strike', () => {
    const html = renderMarkdownWithRefs('about ~5 items and ~~this is struck~~ here');
    expect(html).toContain('<del>this is struck</del>');
    expect(html).toContain('~5 items');
  });

  it('unclosed double-tilde stays literal and does not crash', () => {
    expect(renderMarkdownWithRefs('~~')).toContain('~~');
    expect(renderMarkdownWithRefs('open ~~never closed')).toContain('never closed');
  });

  it('tildes inside code are untouched by the retune', () => {
    const html = renderMarkdownWithRefs('run `rm ~/tmp/~cache~` now');
    expect(html).not.toContain('<del>');
    expect(html).toContain('<code>');
  });

  it('copy-as-rich-text shares the contract (same singleton)', () => {
    const html = markdownToRichHtml('grew ~100 then ~25');
    expect(html).not.toContain('<del>');
    expect(markdownToRichHtml('a ~~struck~~ b')).toContain('<del>struck</del>');
  });

  it('the note renderer keeps its own (already-fixed) behavior', () => {
    const html = renderNoteMarkdown('local git UNDERCOUNTS ~100 commits, rollout is ~25 CRs.');
    expect(html).not.toContain('<del>');
    expect(renderNoteMarkdown('a ~~struck~~ b')).toContain('<del>struck</del>');
  });

  it('a tilde-fenced code block is still code, not a strike', () => {
    const html = renderMarkdownWithRefs(['~~~', 'approx ~5 things', '~~~'].join('\n'));
    expect(html).not.toContain('<del>');
    expect(html).toContain('<code');
  });
});
