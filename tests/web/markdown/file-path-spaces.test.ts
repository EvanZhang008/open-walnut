import { describe, it, expect } from 'vitest';
import { renderMarkdownWithRefs, filePathsToHtml } from '@/utils/markdown';

/**
 * File paths with SPACES in segments (common for vault notes like
 * "H1 2026 Achievement Overview.md") must linkify as ONE anchor covering the
 * whole path — not break at the first space (the original bug: the dir pass
 * linked ".../H1" and " 2026 Achievement Overview.md" was left as plain text).
 *
 * Space chunks are only trusted when each chunk after a space starts with an
 * uppercase letter / digit / CJK char, and the whole match ends in `.ext` —
 * so path-then-prose text doesn't get swallowed.
 */
describe('file paths with spaces (plain text pass — filePathsToHtml)', () => {
  it('linkifies a note path with Title Case + year spaces as one anchor', () => {
    const p = '/Users/me/.open-walnut/notes/Areas/Career/achievement/H1 2026 Achievement Overview.md';
    const out = filePathsToHtml(`One-pager: ${p} done`);
    expect(out).toContain(`data-file-path="${p}"`);
    expect(out).toContain(`>${p}</a>`);
  });

  it('does not swallow following prose after a space-free path', () => {
    const out = filePathsToHtml('renamed /a/b/c.md to something else');
    expect(out).toContain('data-file-path="/a/b/c.md"');
    expect(out).not.toContain('data-file-path="/a/b/c.md to');
  });

  it('stops at the first .ext when Title-Case prose follows', () => {
    // "See Section" starts uppercase — lazy quantifier must stop at file.md,
    // leaving the prose OUTSIDE the anchor (as sibling plain text).
    const out = filePathsToHtml('open /docs/My Notes/file.md See Section 2 for more');
    expect(out).toContain('data-file-path="/docs/My Notes/file.md"');
    expect(out).toContain('</a> See Section 2 for more');
  });

  it('does not link lowercase prose after a slash-word', () => {
    // "either/or maybe" is prose, not a path
    const out = filePathsToHtml('choose either/or maybe both');
    expect(out).not.toContain('file-link');
  });

  it('keeps :line suffix with spaced path', () => {
    const out = filePathsToHtml('at /x/My Dir/Some File.ts:42 there');
    expect(out).toContain('data-file-path="/x/My Dir/Some File.ts"');
    expect(out).toContain('data-file-line="42"');
  });

  it('linkifies CJK note filenames', () => {
    const p = '/Users/me/.open-walnut/notes/Areas/职业/半年总结 2026.md';
    const out = filePathsToHtml(`见 ${p}`);
    expect(out).toContain(`data-file-path="${p}"`);
  });

  it('linkifies sentence-style note titles: dash separators, lowercase connectors, (draft) tags', () => {
    // Real personal-ai-written note shape that broke 2026-08-08: en-dash chunk,
    // lowercase "to" connector, parenthesized "(draft)" tag.
    const p = '/Users/me/.open-walnut/notes/Projects/Marina Renewal/2026-08-08 – Status Ping to Acme (draft).md';
    const out = filePathsToHtml(`草稿已存: ${p}`);
    expect(out).toContain(`data-file-path="${p}"`);
    expect(out).toContain(`>${p}</a>`);
  });

  it('linkifies ASCII-dash + version-tag note names', () => {
    const p = '/n/p/Draft - Reply to IT (v2).md';
    const out = filePathsToHtml(`saved ${p} ok`);
    expect(out).toContain(`data-file-path="${p}"`);
  });

  it('does not swallow prose after .ext even when a dash follows', () => {
    const out = filePathsToHtml('moved /x/y/z.md - see notes elsewhere');
    expect(out).toContain('data-file-path="/x/y/z.md"');
    expect(out).not.toContain('data-file-path="/x/y/z.md -');
  });

  it('lowercase connector cannot end a filename (still stops at first .ext)', () => {
    const out = filePathsToHtml('renamed /a/b/c.md to keep things tidy');
    expect(out).toContain('data-file-path="/a/b/c.md"');
    expect(out).not.toContain('data-file-path="/a/b/c.md to');
  });

  it('spaced leaf stops at its own .ext when prose with another .ext follows', () => {
    const out = filePathsToHtml('read /a/b/H1 2026 Overview.md and Other Notes.md later');
    expect(out).toContain('data-file-path="/a/b/H1 2026 Overview.md"');
    expect(out).not.toContain('data-file-path="/a/b/H1 2026 Overview.md and');
  });

  it('connector + Title Case prose after a space-free path is not swallowed', () => {
    const out = filePathsToHtml('then run /a/b/c.md and Other Steps.md later');
    expect(out).toContain('data-file-path="/a/b/c.md"');
    expect(out).not.toContain('data-file-path="/a/b/c.md and');
  });
});

describe('file paths with spaces inside inline code (post-marked pass)', () => {
  it('linkifies a spaced path inside backticks as one anchor', () => {
    const p = '/Users/me/.open-walnut/notes/Areas/Career/achievement/H1 2026 Achievement Overview.md';
    const html = renderMarkdownWithRefs(`One-pager: \`${p}\``);
    expect(html).toContain(`data-file-path="${p}"`);
    // No nested/broken anchors: the whole path is the anchor text
    expect(html).toContain(`>${p}</a>`);
  });

  it('never produces nested anchors when dir + spaced-file passes overlap', () => {
    const p = '/Users/me/notes/H1 2026 Overview.md';
    const html = renderMarkdownWithRefs(`\`${p}\` and \`/a/b/c\``);
    // A nested anchor would appear as "<a" occurring inside another anchor's text
    expect(html).not.toMatch(/<a[^>]*>[^<]*<a /);
  });

  it('still linkifies plain space-free paths in code', () => {
    const html = renderMarkdownWithRefs('`/src/utils/markdown.ts:42`');
    expect(html).toContain('data-file-path="/src/utils/markdown.ts"');
    expect(html).toContain('data-file-line="42"');
  });

  it('leaves URLs intact (no path linkification inside them)', () => {
    const html = renderMarkdownWithRefs('`https://host/a/b/task.md`');
    expect(html).not.toContain('data-file-path');
  });

  it('linkifies a sentence-style note title inside backticks as one anchor', () => {
    const p = '/Users/me/.open-walnut/notes/Projects/Marina Renewal/2026-08-08 – Status Ping to Acme (draft).md';
    const html = renderMarkdownWithRefs(`草稿已存: \`${p}\``);
    expect(html).toContain(`data-file-path="${p}"`);
    expect(html).not.toMatch(/<a[^>]*>[^<]*<a /);
  });
});
