/**
 * `![[embed]]` — Obsidian wiki-embed, rendered INLINE in the editor (BUG 2).
 *
 * Obsidian's `![[path]]` embeds an attachment (vs. `[[path]]` which links to a
 * note). The editor previously had no embed support, so a real vault showed the
 * raw text `![[notes/Areas/.../foo.png]]`. This node renders:
 *   - images (png/jpg/jpeg/gif/webp) → inline <img>
 *   - PDFs (.pdf)                    → inline <iframe> preview
 *   - anything else (e.g. `.base`)   → a click-to-open card (never crash)
 * All via the single notes-owned endpoint /api/notes-v2/attachment (it resolves
 * bare names, vault-relative, and legacy `Notion/`-rooted paths — see
 * notes-attachment.ts), so this node just passes the raw inner path through.
 *
 * BYTE-CLEAN (the round-trip gate): like `tag-node.ts`, this is an ATOM inline
 * Node whose markdown `serialize` does `state.write('![[' + target + ']]')` —
 * NOT `state.esc()` — so the disk bytes stay literally `![[path]]` (the default
 * text serializer would escape `[` `]` `_` and corrupt it). A markdown-it inline
 * parse rule (registered BEFORE the `image` rule so `![[` is not eaten as an
 * `![alt](url)` image) turns `![[...]]` back into this node on load. Multiple
 * embeds on one line are handled — the rule fires per occurrence.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import { WikiEmbedView } from '../WikiEmbedView';

// `![[` then anything up to the closing `]]` (target excludes `]`). Mirrors the
// backend embed regex. Non-greedy so `![[a]] ![[b]]` matches twice, not once.
const EMBED_INLINE_RE = /^!\[\[([^\]]+)\]\]/;

export const WikiEmbedNode = Node.create({
  name: 'wikiEmbed',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-embed-target') || '',
        renderHTML: (attrs) => ({ 'data-embed-target': attrs.target }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-embed-target]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Static fallback (clipboard / non-React contexts). The interactive render
    // is the React NodeView below; this keeps the target greppable in the DOM.
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'notes-wikiembed' }),
      `![[${node.attrs.target}]]`,
    ];
  },

  renderText({ node }) {
    return `![[${node.attrs.target}]]`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikiEmbedView);
  },

  addStorage() {
    return {
      /**
       * Vault path of the note being edited. The NodeView reads it to send
       * `?note=` alongside the attachment request so the server can break
       * duplicate-filename ties by proximity. Lives in storage (not a node
       * attribute) because it belongs to the DOCUMENT, not to each embed — it
       * must never reach the serialized markdown. NotesEditor keeps it current.
       */
      notePath: '' as string,
      markdown: {
        // Byte-clean: literal write, NO escaping (see file header).
        serialize(state: MarkdownSerializerState, node: { attrs: { target: string } }) {
          state.write(`![[${node.attrs.target}]]`);
        },
        parse: {
          setup(md: any) {
            // Register BEFORE `image` so `![[` is captured as an embed, not as
            // the start of an `![alt](url)` image. Fires per occurrence so
            // multiple embeds on one line each become a node.
            md.inline.ruler.before('image', 'wnut_embed', (state: any, silent: boolean) => {
              // Fast bail: must start with `![[`.
              if (state.src.charCodeAt(state.pos) !== 0x21 /* ! */) return false;
              if (state.src.charCodeAt(state.pos + 1) !== 0x5b /* [ */) return false;
              if (state.src.charCodeAt(state.pos + 2) !== 0x5b /* [ */) return false;

              const m = EMBED_INLINE_RE.exec(state.src.slice(state.pos));
              if (!m) return false;
              const target = m[1].trim();
              if (!target) return false;

              if (!silent) {
                const token = state.push('wnut_embed', '', 0);
                token.content = target;
                token.markup = '![[';
              }
              state.pos += m[0].length;
              return true;
            });

            // Render the token to the `span[data-embed-target]` the parseHTML
            // rule above re-hydrates into a WikiEmbedNode.
            md.renderer.rules.wnut_embed = (tokens: any[], idx: number) => {
              const target = tokens[idx].content as string;
              // Escape the attribute value so a `"` in a path can't break out.
              const safe = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
              return `<span data-embed-target="${safe}">![[${safe}]]</span>`;
            };
          },
        },
      },
    };
  },
});
