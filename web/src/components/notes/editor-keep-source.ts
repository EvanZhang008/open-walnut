/**
 * The Markdown a WYSIWYG editor saves, with the file's own bytes kept on every
 * line the user did not edit.
 *
 * Every surface that saves `editor.storage.markdown.getMarkdown()` (a vault note,
 * the home notes panel, a task or memory field, a Markdown file in the Files
 * panel) goes through `markdownKeepingSource` instead: tiptap-markdown does not
 * round-trip byte for byte, so the raw serializer output rewrites lines nobody
 * touched (`|---|` becomes `| --- |`, `#` becomes `\#`, blank lines go). See
 * keepUntouchedSource for the merge, and tests/web/markdown-save-keeps-source.test.ts
 * for the guard that keeps every saving surface on this path.
 */
import { createDocument, type Editor } from '@tiptap/core';
import { normalizeForEditor } from './notes-content-preprocess';
import { entityRefsToMarkdownLinks } from '@/utils/markdown';
import { keepUntouchedSource } from '@/utils/markdown-keep-source';

/** The Markdown the editor would make of `body` with nobody touching it: the same
 *  parse setContent runs, then the serializer. */
export function serializeUntouched(ed: Editor, body: string): string {
  const html = ed.storage.markdown.parser.parse(normalizeForEditor(entityRefsToMarkdownLinks(body))) as string;
  return ed.storage.markdown.serializer.serialize(createDocument(html, ed.schema, ed.options.parseOptions)) as string;
}

interface KeepCache {
  /** serializeUntouched(seed), computed once per seed: the merge base. */
  seed: string;
  untouched: string | null;
  /** The last body handed out and what it became, so a save and the draft or
   *  no-op check around it do not merge the same text twice. */
  body?: string;
  text?: string;
}
const caches = new WeakMap<Editor, KeepCache>();

/** serializeUntouched(ed, seed), cached per editor and seed; null when it throws. */
export function untouchedMarkdown(ed: Editor, seed: string): string | null {
  let c = caches.get(ed);
  if (!c || c.seed !== seed) {
    let untouched: string | null = null;
    try { untouched = serializeUntouched(ed, seed); } catch { /* no merge base */ }
    c = { seed, untouched };
    caches.set(ed, c);
  }
  return c.untouched;
}

/**
 * `body` (the editor's Markdown, default: read it now) with every line the user
 * did not edit put back to `seed`'s bytes, where `seed` is the body the editor
 * was loaded from (the bytes on disk, frontmatter split off). No seed: `body` as
 * it is.
 *
 * The kept text is used only when the editor loads it as the same document as
 * `body`: it loads and serializes to `body` itself, or both load and serialize to
 * the same text (loading also collapses runs of spaces, which typing can leave in
 * `body`). The first alone holds where the serializer's output does not load back
 * as itself, which a table cell's bold once caused for a whole note (2026-11-09).
 * Anything else writes `body`, the editor's own spelling, which is always a
 * correct save. Not "renders to the same HTML": the serializer is lossy (inline
 * code ending in a space loses the space after it), so the file's own bytes can
 * render better than the editor's spelling, and that check threw the whole merge
 * away (2026-11-07, a 153-line note).
 */
export function markdownKeepingSource(ed: Editor, seed: string | null | undefined, body?: string): string {
  const current = body ?? (ed.storage.markdown.getMarkdown() as string);
  if (seed == null) return current;
  const untouched = untouchedMarkdown(ed, seed);
  const c = caches.get(ed)!;
  if (c.body === current) return c.text!;
  let text = current;
  if (untouched != null) {
    try {
      const kept = keepUntouchedSource(seed, untouched, current);
      if (kept === current) text = kept;
      else {
        const loaded = serializeUntouched(ed, kept);
        if (loaded === current || loaded === serializeUntouched(ed, current)) text = kept;
      }
    } catch { /* the editor's spelling is always a correct save */ }
  }
  c.body = current;
  c.text = text;
  return text;
}

/** `content` loads as the document whose Markdown is `currentMd`: an external
 *  content sync that would only re-parse the same document (a save's own bytes
 *  coming back) can be skipped. */
export function loadsAs(ed: Editor, content: string, currentMd: string): boolean {
  try { return serializeUntouched(ed, content) === currentMd; } catch { return false; }
}
