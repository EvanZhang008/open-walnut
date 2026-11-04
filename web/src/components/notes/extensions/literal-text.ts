/**
 * The text node, serialized so that `<` and `>` typed as prose stay `<` and `>`.
 *
 * `tiptap-markdown` runs `escapeHTML` over EVERY text node on serialize, so an
 * arrow (`A -> B`) or a comparison (`x < y`) was written as `A -&gt; B` /
 * `x &lt; y`, both into the saved file and onto the clipboard (MarkdownCopy
 * uses the same serializer). The 2026-09-23 report: a sentence copied out of a
 * design doc in the Files panel and pasted into the session composer read
 * `-&gt;` and was sent to the CLI that way.
 *
 * The entity form is only ever NEEDED for a run CommonMark would otherwise read
 * as markup on the next load: an open or close tag, a comment or declaration,
 * an autolink (`<https://…>`). Those keep the entity so a literal `<div>` typed
 * in prose cannot become an element and lose its words. Everything else is
 * plain markdown text and is written verbatim. `memory-file-io.ts` relies on the
 * entity form for tag-shaped runs (it decodes them back on save), so that half
 * is unchanged.
 *
 * Two consequences, both deliberate:
 *  · A file that already carries `-&gt;` heals to `->` on its next save. The
 *    parser decodes every entity into the same `>` text, so the serializer
 *    cannot tell a healed arrow from a `&gt;` someone typed on purpose; both
 *    come out as the bare character, which renders identically.
 *  · A `>`, `#` or list marker right after a hard break (Shift+Enter) opens a
 *    LINE but not a block, and prosemirror-markdown only applies its
 *    start-of-line escapes at block start. The entity used to hide that `>`;
 *    now the escape is forced there, so `> not a quote` on a second line does
 *    not reload as a blockquote (nor `- x` as a list).
 *
 * Replaces StarterKit's `text` (configured `text: false`); the schema is the
 * same node, only the markdown `serialize` differs. Mirrored in
 * tests/web/notes-roundtrip/editor-harness.ts.
 */

import Text from '@tiptap/extension-text';
import type { MarkdownSerializerState } from 'prosemirror-markdown';

/**
 * A `<…>` run CommonMark can read as raw HTML or an autolink: `<` followed by a
 * letter (open tag, autolink, email), `/` (close tag), `!` (comment,
 * declaration, CDATA) or `?` (processing instruction), then anything up to the
 * next `>` with no further `<` inside. A digit or a space after `<` can never
 * start markup, so `<1abc>` and `a < b` are left alone.
 */
const MARKUP_RUN_RE = /<[A-Za-z/!?][^<>]*>/g;

/** `<`/`>` of markup-shaped runs as entities; every other `<`/`>` verbatim. */
export function escapeMarkupRuns(text: string): string {
  if (!text.includes('<')) return text;
  return text.replace(MARKUP_RUN_RE, (run) => `&lt;${run.slice(1, -1)}&gt;`);
}

/**
 * A `[[target]]` / `[[target|alias]]` wiki link. prosemirror-markdown escapes every `[` and `]`, so
 * it was saved as `\[\[target\]\]`: the editor still drew it as a link, but the notes index
 * (backlinks), Obsidian and every tool that moves notes and fixes links read only the bare form
 * (2026-11-04: an organize run's link fixing and its Undo skipped every link of a note edited in
 * Walnut). A wiki link is written as it is; the text around it is escaped as before.
 */
const WIKI_LINK_RUN_RE = /\[\[[^[\]\n]+\]\]/g;

/** `text` cut into its wiki-link runs and the text between them, in order. */
export function splitWikiLinks(text: string): Array<{ text: string; link: boolean }> {
  if (!text.includes('[[')) return [{ text, link: false }];
  const parts: Array<{ text: string; link: boolean }> = [];
  let at = 0;
  for (const m of text.matchAll(WIKI_LINK_RUN_RE)) {
    if (m.index! > at) parts.push({ text: text.slice(at, m.index), link: false });
    parts.push({ text: m[0], link: true });
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), link: false });
  return parts;
}

/** The two state fields the line-start check reads; public at runtime, not in the typings. */
type StateInternals = { out: string; atBlockStart: boolean };

export const LiteralText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: { text?: string | null }) {
          const { out, atBlockStart } = state as unknown as StateInternals;
          const afterBreak = out !== '' && out.endsWith('\n') && !atBlockStart;
          splitWikiLinks(node.text ?? '').forEach((link, i) => {
            // A wiki link as it is (see WIKI_LINK_RUN_RE): the link rule reads it before any HTML
            // rule could, so a `<b>` in its title needs no entity (one would be read back as text).
            if (link.link) { state.text(link.text, false); return; }
            const part = { text: escapeMarkupRuns(link.text) };
            if (i === 0 && afterBreak) {
              // Line start after a hard break: `state.text` would skip the
              // start-of-line escapes here (see header), so apply them ourselves.
              state.write(state.esc(part.text, true));
              return;
            }
            // `state.text` applies prosemirror-markdown's own escaping (`*`, `_`,
            // a block-leading `>` or `#`), which is what keeps a typed `> quote`
            // a quote and a typed `*` a star.
            state.text(part.text);
          });
        },
        parse: {
          setup(md: any) {
            // A wiki link reads as its own literal text, so a `*`, `_` or backtick in a note's name
            // never opens emphasis or code inside it (which split the link across marks and lost
            // it on the next save). A table's `\|` alias pipe reads as `|`, as the escape rule
            // would have read it.
            md.inline.ruler.before('escape', 'wnut_wiki_link', (state: any, silent: boolean) => {
              const start = state.pos;
              if (state.src.charCodeAt(start) !== 0x5b /* [ */ || state.src.charCodeAt(start + 1) !== 0x5b) return false;
              const m = /^\[\[[^[\]\n]+\]\]/.exec(state.src.slice(start, state.posMax));
              if (!m) return false;
              if (!silent) {
                const token = state.push('text', '', 0);
                token.content = m[0].replace(/\\\|/g, '|');
              }
              state.pos += m[0].length;
              return true;
            });
          },
        },
      },
    };
  },
});
