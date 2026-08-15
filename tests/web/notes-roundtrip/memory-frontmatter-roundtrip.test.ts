/**
 * MEMORY-FILE FRONTMATTER ROUND-TRIP — the gate on the write path that used to
 * DESTROY the YAML frontmatter of MEMORY.md / USER.md.
 *
 * The memory page edits a memory file in the SHARED WYSIWYG editor and autosaves
 * `editor.storage.markdown.getMarkdown()` back over the whole file on a 500 ms
 * debounce, so typing one character rewrites the file through tiptap-markdown.
 * Handing the raw bytes to that editor collapses the frontmatter: markdown-it
 * reads the CLOSING `---` as a setext-H2 underline, so the whole YAML block comes
 * back as ONE `## name: … description: &gt; …` heading line. For MEMORY.md /
 * USER.md — bounded stores whose `## Title` sections are injected into the
 * Personal AI's prompt every turn — that heading then reads as a real ENTRY.
 *
 * The fix (mirrors what hooks/useNoteContent.ts does for vault notes): the editor
 * edits the BODY only; the frontmatter block is preserved verbatim and re-attached
 * on save. `components/memory/memory-file-io.ts` owns that split/join, plus the
 * two escaping corrections the serializer needs (pre-escape tag-shaped prose the
 * parser would DELETE; decode the `&lt;`/`&gt;` its `escapeHTML` emits).
 *
 * These tests drive the REAL production serializer + parser via the same headless
 * harness the notes corpus uses, so what is asserted here is what the live editor
 * does — not a re-implementation.
 */
import { describe, it, expect } from 'vitest';
import { createNotesMarkdownHarness } from './editor-harness';
import {
  splitMemoryFile,
  joinMemoryFile,
  escapeUnknownTags,
  decodeEditorEscapes,
} from '@/components/memory/memory-file-io';

const h = createNotesMarkdownHarness();

/**
 * The exact pipeline the memory page runs: load → split off frontmatter →
 * pre-escape → editor round trip (what one keystroke + autosave does) → decode +
 * re-attach frontmatter → the bytes PUT to /api/memory.
 */
function saveThroughEditor(raw: string): string {
  const split = splitMemoryFile(raw);
  const seed = escapeUnknownTags(split.body);
  const edited = h.roundTrip(seed);
  return joinMemoryFile(split, edited);
}

/** The OLD (broken) path: whole file straight through the editor. */
function saveWithoutSplit(raw: string): string {
  return h.roundTrip(raw);
}

// A healthy bounded-store file in the real on-disk shape: fenced YAML with a
// `description: >` block scalar, a `# Title`, then `## Entry` sections.
const HEALTHY = `---
name: Global Memory
description: >
  Bounded behavior rules. Updated by the agent via the memory tool.
  Hard budget: 8000 chars.
---

# MEMORY.md — Global

## Release Checklist

Build, then verify in a real browser before claiming done.

## Naming Rule

When importing a record, never use a generic "Import <id>" title — read the source first. Budget: keep entries under 400 chars.
`;

describe('memory file: frontmatter survives a save through the editor', () => {
  it('BASELINE: the unsplit path really does collapse the YAML block (the bug)', () => {
    const broken = saveWithoutSplit(HEALTHY);
    // The closing fence became a setext-H2 underline: one heading, YAML inline.
    expect(broken).toMatch(/^---\n\n## name: Global Memory description:/);
    // …and the block-scalar marker came back HTML-escaped.
    expect(broken).toContain('&gt;');
    // Which is exactly the fake-entry shape: a `## ` line the bounded-store
    // parser counts as an entry against the char budget — 2 real entries + 1 fake.
    expect(broken.split('\n').filter((l) => l.startsWith('## ')).length).toBe(3);
    expect(HEALTHY.split('\n').filter((l) => l.startsWith('## ')).length).toBe(2);
  });

  it('load → save WITHOUT typing is byte-identical', () => {
    expect(saveThroughEditor(HEALTHY)).toBe(HEALTHY);
  });

  it('saved bytes keep a parseable fenced YAML block', () => {
    const saved = saveThroughEditor(HEALTHY);
    expect(saved.startsWith('---\n')).toBe(true);
    expect(/^---\n[\s\S]*?\n---\n/.test(saved)).toBe(true);
    expect(saved).toContain('description: >');
  });

  it('no HTML entity artifacts anywhere in the saved bytes', () => {
    const saved = saveThroughEditor(HEALTHY);
    expect(saved).not.toContain('&gt;');
    expect(saved).not.toContain('&lt;');
    expect(saved).not.toContain('&amp;');
  });

  it('the frontmatter never reaches the editor surface', () => {
    const { body } = splitMemoryFile(HEALTHY);
    expect(body.startsWith('# MEMORY.md')).toBe(true);
    expect(body).not.toContain('name: Global Memory');
    expect(body).not.toContain('---');
  });

  it('entry count is unchanged (no fake entry, none lost)', () => {
    const count = (s: string) => s.split('\n').filter((l) => l.startsWith('## ')).length;
    expect(count(saveThroughEditor(HEALTHY))).toBe(count(HEALTHY));
  });

  it('is idempotent — repeated saves are a fixed point', () => {
    const once = saveThroughEditor(HEALTHY);
    const twice = saveThroughEditor(once);
    expect(twice).toBe(once);
    expect(saveThroughEditor(twice)).toBe(once);
  });

  it('an edited entry is persisted and the frontmatter is untouched', () => {
    const split = splitMemoryFile(HEALTHY);
    const edited = h.roundTrip(escapeUnknownTags(split.body)) + '\n\n## Added Rule\n\nAlways verify.';
    const saved = joinMemoryFile(split, edited);
    expect(saved.startsWith(split.frontmatter)).toBe(true);
    expect(saved).toContain('## Added Rule');
    expect(saved).toContain('Always verify.');
    expect(saved).toContain('description: >');
    expect(saved).not.toContain('&gt;');
    // Still exactly one fenced block — nothing was duplicated.
    expect(saved.split('\n').filter((l) => l.trim() === '---').length).toBe(2);
  });
});

// ─── Edge cases the write path must survive ────────────────────────────────

describe('memory file: edge cases', () => {
  it('NO frontmatter — body is the whole file, nothing is prepended', () => {
    const raw = '# Daily Log\n\n## Morning\n\nReviewed the build.\n';
    const split = splitMemoryFile(raw);
    expect(split.frontmatter).toBe('');
    expect(split.body).toBe('# Daily Log\n\n## Morning\n\nReviewed the build.');
    const saved = saveThroughEditor(raw);
    expect(saved).toBe(raw);
    expect(saved.startsWith('---')).toBe(false);
  });

  it('ALREADY-COLLAPSED frontmatter — does not crash, does not double-attach', () => {
    // The pre-repair rot shape: a lone opening `---`, no closing fence, and the
    // YAML flattened into a `## key: … &gt; …` heading.
    const rotted = `---

## name: Global Memory description: &gt; Bounded behavior rules. Hard budget: 8000 chars.

# MEMORY.md — Global

## Release Checklist

Build, then verify.
`;
    const split = splitMemoryFile(rotted);
    // Treated as "no frontmatter" — the orphan fence stays in the body rather
    // than a bogus block being carved out and re-attached.
    expect(split.frontmatter).toBe('');
    const saved = saveThroughEditor(rotted);
    // Exactly one `---` line — no second fence was invented.
    expect(saved.split('\n').filter((l) => l.trim() === '---').length).toBe(1);
    // Content is preserved (the backend parser owns healing this shape).
    expect(saved).toContain('## Release Checklist');
    expect(saved).toContain('Build, then verify.');
    // Stable: a second pass through the editor changes nothing further.
    expect(saveThroughEditor(saved)).toBe(saved);
  });

  it('empty file', () => {
    expect(saveThroughEditor('')).toBe('');
    const split = splitMemoryFile('');
    expect(split.frontmatter).toBe('');
    expect(split.body).toBe('');
  });

  it('frontmatter only, no body', () => {
    const raw = '---\nname: Empty Store\n---\n';
    const split = splitMemoryFile(raw);
    expect(split.frontmatter).toBe(raw);
    expect(split.body).toBe('');
    expect(saveThroughEditor(raw)).toBe(raw);
  });

  it('a `---` thematic break in the BODY is not mistaken for a closing fence', () => {
    const raw = '# Notes\n\nBefore.\n\n---\n\nAfter.\n';
    const split = splitMemoryFile(raw);
    expect(split.frontmatter).toBe('');
    expect(split.body).toContain('Before.');
    expect(split.body).toContain('After.');
  });

  it('CRLF frontmatter is preserved verbatim', () => {
    const raw = '---\r\nname: Store\r\n---\r\n\r\n# Title\r\n';
    const split = splitMemoryFile(raw);
    expect(split.frontmatter).toBe('---\r\nname: Store\r\n---\r\n');
    expect(joinMemoryFile(split, split.body)).toBe(raw);
  });

  it('split → join with an untouched body reproduces any input byte-for-byte', () => {
    for (const raw of [
      HEALTHY,
      '',
      '\n',
      '---\nname: X\n---\n',
      '# Body only\n',
      'no trailing newline',
      '---\nname: X\n---\n\n\n# Gapped\n\n\n',
    ]) {
      const split = splitMemoryFile(raw);
      expect(joinMemoryFile(split, split.body), JSON.stringify(raw)).toBe(raw);
    }
  });

  it('an emptied body does not leave dangling boundary whitespace', () => {
    const split = splitMemoryFile(HEALTHY);
    expect(joinMemoryFile(split, '')).toBe(split.frontmatter);
    expect(joinMemoryFile(split, '   \n\n')).toBe(split.frontmatter);
  });
});

// ─── The escaping corrections, asserted against the real serializer ─────────

describe('memory file: angle-bracket / entity fidelity', () => {
  const through = (md: string) => decodeEditorEscapes(h.roundTrip(escapeUnknownTags(md)));

  it('tag-shaped prose survives instead of being DELETED', () => {
    // Without the pre-escape the parser eats `<id>` entirely.
    expect(h.roundTrip('Never use a generic "Import <id>" title.')).not.toContain('<id>');
    expect(through('Never use a generic "Import <id>" title.')).toBe(
      'Never use a generic "Import <id>" title.',
    );
    expect(through('Route <sid> then <task-id> next.')).toBe('Route <sid> then <task-id> next.');
    expect(through('Text </div> alone')).toBe('Text </div> alone');
  });

  it('a bare `>` / `<` in prose is not turned into an entity', () => {
    // The serializer's escapeHTML is what produced the literal `&gt;` rot.
    expect(h.roundTrip('Budget: a > b in prose.')).toContain('&gt;');
    expect(through('Budget: a > b in prose.')).toBe('Budget: a > b in prose.');
    expect(through('Compare a < b here.')).toBe('Compare a < b here.');
    expect(through('A -> B and X => Y')).toBe('A -> B and X => Y');
  });

  it('code spans and fences are left alone by the pre-escape', () => {
    const fenced = '```ts\nconst a: Array<string> = [];\n```';
    expect(escapeUnknownTags(fenced)).toBe(fenced);
    expect(through(fenced)).toBe(fenced);
    expect(escapeUnknownTags('Use `Array<string>` here.')).toBe('Use `Array<string>` here.');
    expect(through('Use `Array<string>` here.')).toBe('Use `Array<string>` here.');
  });

  it('real markup keeps its existing behavior (no over-escaping)', () => {
    // Autolinks and KNOWN html tags are untouched by the pre-escape, so the
    // editor still parses them as markup exactly as it did before.
    const autolink = 'See <https://example.com> for docs.';
    expect(escapeUnknownTags(autolink)).toBe(autolink);
    expect(through(autolink)).toBe(autolink);
    expect(escapeUnknownTags('Text <b>bold</b> more')).toBe('Text <b>bold</b> more');
    expect(escapeUnknownTags('Text <img src="/a.png"> more')).toBe('Text <img src="/a.png"> more');
  });

  it('blockquotes still parse (the pre-escape never touches a bare `>`)', () => {
    expect(escapeUnknownTags('> quoted line')).toBe('> quoted line');
    expect(h.roundTrip('> quoted line')).toBe('> quoted line');
  });

  it('decodeEditorEscapes peels exactly one layer and leaves `&amp;` alone', () => {
    expect(decodeEditorEscapes('a &gt; b')).toBe('a > b');
    expect(decodeEditorEscapes('&lt;id&gt;')).toBe('<id>');
    // Legacy double-escaped rot decodes one layer, not two (no over-decoding).
    expect(decodeEditorEscapes('&amp;gt;')).toBe('&amp;gt;');
    expect(decodeEditorEscapes('plain text')).toBe('plain text');
  });

  it('a full save cycle of a body containing all of these is a fixed point', () => {
    const raw = `---
name: Global Memory
description: >
  Rules the Personal AI reads every turn.
---

# MEMORY.md — Global

## Naming

Never use a generic "Import <id>" title. Budget: a > b, and A -> B.

## Code

Use \`Array<string>\`, not the bare form.

\`\`\`ts
const x: Map<string, number> = new Map();
\`\`\`

> A quoted aside stays a quote.
`;
    const once = saveThroughEditor(raw);
    expect(once).toBe(raw);
    expect(saveThroughEditor(once)).toBe(once);
  });
});
