/**
 * Frontmatter-safe load/save split for MEMORY FILES edited in the web console.
 *
 * WHY THIS EXISTS
 *
 * A memory file (`MEMORY.md`, `USER.md`, a daily log, a topic page…) opens in the
 * SHARED WYSIWYG editor (`MarkdownEditorPanel` → `NotesEditor` → `tiptap-markdown`),
 * and one keystroke rewrites the WHOLE file through that editor's markdown
 * serializer. Handing it a leading YAML frontmatter block destroys the block:
 *
 *   - markdown-it reads the CLOSING `---` as a setext-H2 UNDERLINE, so
 *     `---\nname: X\ndescription: >\n  prose\n---` collapses into a single
 *     `## name: X description: > prose` heading line, and
 *   - `tiptap-markdown`'s text serializer runs `escapeHTML`, so the YAML
 *     block-scalar marker `>` comes back as a literal `&gt;`.
 *
 * For `MEMORY.md`/`USER.md` that is not cosmetic: they are BOUNDED stores whose
 * `## Title` sections are injected into the Personal AI's system prompt every turn, so
 * a collapsed frontmatter block becomes a FAKE entry — it charges its length
 * against the char budget and is a legal `replace`/`remove` target string.
 *
 * THE FIX (same pattern the vault-notes path uses — see hooks/useNoteContent.ts
 * and components/notes/frontmatter.ts): the editor edits the BODY only. We keep
 * the frontmatter block verbatim and re-attach it byte-for-byte on save.
 *
 * Beyond the notes path we ALSO preserve the whitespace at the frontmatter/body
 * seam and at EOF. The editor's serializer drops leading blank lines and the
 * trailing newline, so without this a save-without-typing would still shift two
 * bytes and the round trip would not be byte-identical.
 */

import { splitFrontmatter } from '@/components/notes/frontmatter';

export interface SplitMemoryFile {
  /** Verbatim leading `---\n…\n---\n` block, or '' when the file has none. */
  frontmatter: string;
  /** Blank-line run between the frontmatter (or BOF) and the first body line. */
  leadingGap: string;
  /** The markdown the editor edits — no frontmatter, no boundary whitespace. */
  body: string;
  /** Whitespace run at EOF (usually a single `\n`, or '' when absent). */
  trailingGap: string;
}

/**
 * A YAML-ish key line: one bare word then a colon. Mirrors the backend's
 * `YAML_KEY_RE` (src/core/bounded-memory.ts) so both ends agree on what counts as
 * real frontmatter.
 */
const YAML_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/;

/**
 * Does this fence block actually contain YAML? `splitFrontmatter`'s regex is
 * purely positional, so on a file whose frontmatter was ALREADY collapsed (a lone
 * opening `---`, no closing fence) it would happily treat a `---` thematic break
 * far down the body as the closing fence and hide everything in between from the
 * editor. Requiring the first non-empty line to look like a YAML key keeps that
 * from happening.
 */
function looksLikeYaml(frontmatter: string): boolean {
  const lines = frontmatter.split('\n').slice(1); // drop the opening fence
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (line.trim() === '---') return false; // empty block — nothing to protect
    return YAML_KEY_RE.test(line.trim());
  }
  return false;
}

/**
 * Split raw memory-file bytes into the parts `joinMemoryFile` needs.
 *
 * Never throws, and `joinMemoryFile(split(raw), split(raw).body) === raw` for any
 * input. Three shapes matter:
 *
 *  - **healthy** — `---\n…\n---\n` fence up front: kept out of `body`.
 *  - **no frontmatter** — `frontmatter` is '' and the whole file is the body.
 *  - **already collapsed** (the pre-repair rot shape: a lone opening `---` and a
 *    `## name: … description: &gt; …` heading, with no closing fence): the
 *    YAML-shape check rejects it, so it degrades to the "no frontmatter" case —
 *    the orphaned `---` and the collapsed heading stay in the body as ordinary
 *    markdown. Nothing crashes and nothing is attached twice; healing that shape
 *    belongs to the backend parser, not to the editor.
 */
export function splitMemoryFile(raw: string): SplitMemoryFile {
  const split = splitFrontmatter(raw ?? '');
  const isYaml = split.frontmatter !== '' && looksLikeYaml(split.frontmatter);
  const frontmatter = isYaml ? split.frontmatter : '';
  const afterFrontmatter = isYaml ? split.body : (raw ?? '');
  // All-whitespace remainder: attribute it entirely to the TRAILING gap so the
  // same run is never claimed by both gaps (which would duplicate it on re-join).
  if (afterFrontmatter.trim() === '') {
    return { frontmatter, leadingGap: '', body: '', trailingGap: afterFrontmatter };
  }
  // Leading blank lines (the customary empty line after the closing fence).
  const leadingGap = /^[ \t]*\r?\n(?:[ \t]*\r?\n)*/.exec(afterFrontmatter)?.[0] ?? '';
  const withoutLead = afterFrontmatter.slice(leadingGap.length);
  const trailingGap = /\s*$/.exec(withoutLead)?.[0] ?? '';
  const body = withoutLead.slice(0, withoutLead.length - trailingGap.length);
  return { frontmatter, leadingGap, body, trailingGap };
}

/**
 * HTML tag names markdown-it/TipTap understand as real markup. `<b>` must stay a
 * tag (the editor turns it into a bold mark); everything else that merely LOOKS
 * like a tag is prose the editor would otherwise swallow.
 */
const KNOWN_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
]);

/** Regions the editor keeps verbatim: fenced blocks and inline code spans. */
const CODE_REGION_RE = /(^|\n)[ \t]*(?:```|~~~)[\s\S]*?(?:\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$)|`[^`\n]*`/g;

/** `<tag …>` / `</tag>` where tag is a plain HTML name. */
const TAG_RE = /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s[^<>]*?)?\/?>/g;

/**
 * Pre-escape the angle brackets of things that are NOT real HTML tags, so the
 * editor's parser cannot DELETE them.
 *
 * Rationale, measured against the production parser: `<id>` in prose is parsed as
 * an unknown HTML element and vanishes entirely on save (silent data loss in a
 * rule the Personal AI reads every turn). Feeding `&lt;id&gt;` instead survives the
 * round trip verbatim, and `decodeEditorEscapes` turns it back into `<id>`.
 *
 * Scoped narrowly on purpose:
 *  - only tag-SHAPED text (`<word …>`), never a bare `<`/`>` — a bare `>` at line
 *    start is a blockquote and must keep working;
 *  - never inside fenced blocks or inline code, which already survive verbatim;
 *  - never a KNOWN tag or an autolink (`<https://…>`, `<a@b.c>`), so real markup
 *    and links keep their existing behavior.
 */
export function escapeUnknownTags(md: string): string {
  if (!md || !md.includes('<')) return md;
  // Collect code/inline-code spans first; those are left completely untouched.
  const skip: Array<[number, number]> = [];
  for (const m of md.matchAll(CODE_REGION_RE)) skip.push([m.index!, m.index! + m[0].length]);
  const inSkip = (i: number) => skip.some(([s, e]) => i >= s && i < e);

  return md.replace(TAG_RE, (match, tag: string, offset: number) => {
    if (inSkip(offset)) return match;
    if (KNOWN_TAGS.has(tag.toLowerCase())) return match;
    return '&lt;' + match.slice(1, -1) + '&gt;';
  });
}

/**
 * Undo the ONE escaping artifact `tiptap-markdown` adds to every text node:
 * `escapeHTML` turns `<`/`>` into `&lt;`/`&gt;` on serialize and nothing decodes
 * them on parse, so a `>` the user typed comes back as a literal `&gt;` in the
 * saved bytes — visible corruption in a rule the Personal AI reads every turn.
 *
 * Deliberately narrow: only the two entities that serializer produces. `&amp;`
 * is NOT decoded — the editor never emits it, so decoding it would be a transform
 * the artifact does not justify (and would silently rewrite a literal `&amp;`).
 */
export function decodeEditorEscapes(body: string): string {
  if (!body.includes('&')) return body;
  return body.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Rebuild the full file bytes from a preserved split plus the editor's edited
 * body. Inverse of `splitMemoryFile`.
 *
 * The edited body is trimmed of its own boundary whitespace before the original
 * gaps are restored, so repeated saves can neither accumulate blank lines nor
 * erase the file's trailing newline.
 */
export function joinMemoryFile(split: SplitMemoryFile, editedBody: string): string {
  const core = decodeEditorEscapes(editedBody ?? '').replace(/^\s+/, '').replace(/\s+$/, '');
  // An emptied body must not leave `frontmatter + leadingGap` dangling with the
  // trailing gap glued on: collapse both gaps to the frontmatter's own newline.
  // With no frontmatter there is nothing to anchor to, so the original trailing
  // whitespace stands in — that keeps split→join lossless for a blank file.
  if (!core) return split.frontmatter || split.trailingGap;
  return split.frontmatter + split.leadingGap + core + split.trailingGap;
}
