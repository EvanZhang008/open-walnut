/**
 * `#tag` — atomic inline Node rendered as a chip (§3.2 of IMPL-CONTRACT).
 *
 * Disk form: literal `#tag` text (greppable, plain text to `marked`). Nothing
 * extra is written. An atomic inline node (NOT a Mark) gives "backspace selects
 * the whole chip first" for free and a clean click target.
 *
 * Parse rule (markdown-it inline): fires on `#` + LETTER only, when preceded by
 * start-of-token or whitespace, and registered AFTER link tokenization so
 * `#frag` inside a URL is not captured. Not-a-tag: `C#`/`F#` (letter directly
 * before `#`), `#123` (digit after `#`), heading `# ` at line start.
 *
 * Slug normalization (must match BE): lowercase, strip leading `#`, spaces→`-`.
 * Authoring already inserts a normalized name, so serialize is a literal write.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { MarkdownSerializerState } from 'prosemirror-markdown';

/** Normalize a raw tag name to the slug form shared with the backend. */
export function normalizeTagName(raw: string): string {
  return raw.replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, '-');
}

// A tag char run: starts with a letter, then letters/digits/_/-/ (nested tags).
const TAG_BODY_RE = /^([A-Za-z][\w/-]*)/;

export const TagNode = Node.create({
  name: 'tag',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: el => (el as HTMLElement).getAttribute('data-tag') || '',
        renderHTML: attrs => ({ 'data-tag': attrs.name }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-tag]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'badge badge-clickable notes-tag' }),
      `#${node.attrs.name}`,
    ];
  },

  renderText({ node }) {
    return `#${node.attrs.name}`;
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: { attrs: { name: string } }) {
          state.write(`#${node.attrs.name}`);
        },
        parse: {
          setup(md: any) {
            // Inline rule placed after the link rule so `#frag` inside a URL
            // (already consumed by linkify/link) is never re-tagged.
            md.inline.ruler.after('link', 'wnut_tag', (state: any, silent: boolean) => {
              const start = state.pos;
              if (state.src.charCodeAt(start) !== 0x23 /* # */) return false;

              // Preceding char must be start-of-string or whitespace (NOT a
              // letter/digit → excludes C#, F#, issue123#x).
              if (start > 0) {
                const prev = state.src.charCodeAt(start - 1);
                const isSpace = prev === 0x20 || prev === 0x09 || prev === 0x0a;
                // `(` is allowed (e.g. "(#tag)") to mirror link-trigger leniency.
                if (!isSpace && prev !== 0x28 /* ( */) return false;
              }

              const rest = state.src.slice(start + 1);
              const m = TAG_BODY_RE.exec(rest);
              if (!m) return false; // next char not a letter → `#123`, `# ` heading

              const name = m[1];
              if (!silent) {
                const token = state.push('wnut_tag', '', 0);
                token.content = name;
                token.markup = '#';
              }
              state.pos = start + 1 + name.length;
              return true;
            });

            // Render the token as a chip span; normalizeDOM turns it into a TagNode.
            md.renderer.rules.wnut_tag = (tokens: any[], idx: number) => {
              const name = tokens[idx].content;
              return `<span data-tag="${name}">#${name}</span>`;
            };
          },
        },
      },
    };
  },
});
