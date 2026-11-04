/**
 * WikiLinkClick — renders inline `[[Title]]` / `[[folder/Title]]` text as a
 * clickable link inside the editor and reports the clicked target to React for
 * id-keyed resolution + navigation (Obsidian-native; the id NEVER appears in
 * link text — §2.2 / §3.5 of the contract).
 *
 * Two responsibilities, both via ONE ProseMirror plugin (no extra node — the
 * on-disk bytes stay plain `[[Title]]`, so the byte-clean round-trip is
 * untouched):
 *   1. Decorations: wrap each `[[…]]` run in a styled inline span so it looks
 *      and behaves like a link (cursor:pointer, accent color).
 *   2. handleClick: when a decorated span is clicked, extract the target text
 *      (the part before a real `|alias`) and hand it to `onLinkClick`. React
 *      resolves Title→note from the already-loaded list and navigates (or shows
 *      a disambiguation picker for an ambiguous bare `[[Title]]`).
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface WikiLinkClickOptions {
  /** Called with the raw target text (before any `|alias`) when a wiki-link is clicked. */
  onLinkClick: (target: string) => void;
  /**
   * Whether a link's target is a note that does not exist (null: not known yet, e.g. the notes
   * list has not loaded). Such a link is drawn as missing, so a link to a deleted or never made
   * note does not look like one that leads somewhere.
   */
  isMissing?: (target: string) => boolean | null;
}

const WIKI_LINK_CLICK_KEY = new PluginKey('wikiLinkClick');
/** Meta on a transaction that asks the links to be drawn again (the notes list changed). */
export const WIKI_LINK_REFRESH = 'wikiLinkRefresh';

// Matches `[[target]]` or `[[target|alias]]`; target excludes `]` and `|`.
// `g` so we can walk every occurrence within a text node.
const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** The plugin attribute payload stored on each decoration for click extraction. */
interface WikiDecoSpec {
  target: string;
}

/**
 * Build decorations marking every `[[…]]` run across all text nodes in the doc.
 *
 * An aliased link (`[[folder/Page|Page]]`) shows only its alias while the selection is
 * elsewhere, the way Obsidian's live preview does: the `[[target|` and `]]` runs get a hidden
 * class. When the selection touches the link, the whole source shows so it can be edited.
 */
export function buildDecorations(doc: import('@tiptap/pm/model').Node, selection?: { from: number; to: number }, isMissing?: (target: string) => boolean | null): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    WIKI_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_LINK_RE.exec(text)) !== null) {
      // A table cell escapes the alias pipe as `\|`; the backslash is not part of the target.
      const target = (m[1] || '').replace(/\\$/, '').trim();
      if (!target) continue;
      const from = pos + m.index;
      const to = from + m[0].length;
      const alias = (m[2] || '').trim();
      decos.push(
        Decoration.inline(
          from,
          to,
          isMissing?.(target)
            ? { class: 'notes-wikilink-ref notes-wikilink-missing', 'data-wikilink-target': target, title: 'No note here yet: click to make it' }
            : { class: 'notes-wikilink-ref', 'data-wikilink-target': target },
          // The spec carries the resolution target so the click handler can read
          // it without re-parsing; alias is purely display (rendered as text).
          { target: alias || target } as WikiDecoSpec,
        ),
      );
      const touched = selection && selection.from <= to && selection.to >= from;
      if (alias && !touched) {
        const aliasStart = to - 2 - (m[2] || '').length;
        decos.push(Decoration.inline(from, aliasStart, { class: 'notes-wikilink-syntax' }));
        decos.push(Decoration.inline(to - 2, to, { class: 'notes-wikilink-syntax' }));
      }
    }
  });
  return DecorationSet.create(doc, decos);
}

/** The aliased link whose hidden runs hold `pos` strictly inside them, or null. */
export function hiddenRunAt(doc: import('@tiptap/pm/model').Node, pos: number): { from: number; to: number; aliasStart: number } | null {
  let found: { from: number; to: number; aliasStart: number } | null = null;
  doc.descendants((node, at) => {
    if (found) return false;
    if (!node.isText || !node.text) return;
    if (pos <= at || pos >= at + node.text.length) return;
    WIKI_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_LINK_RE.exec(node.text)) !== null) {
      if (!(m[2] || '').trim() || !(m[1] || '').replace(/\\$/, '').trim()) continue;
      const from = at + m.index;
      const to = from + m[0].length;
      const aliasStart = to - 2 - (m[2] || '').length;
      if ((pos > from && pos < aliasStart) || (pos >= to - 2 && pos < to)) found = { from, to, aliasStart };
    }
  });
  return found;
}

export const WikiLinkClickExtension = Extension.create<WikiLinkClickOptions>({
  name: 'wikiLinkClick',

  addOptions() {
    return { onLinkClick: () => {} };
  },

  addProseMirrorPlugins() {
    const { onLinkClick, isMissing } = this.options;
    return [
      new Plugin<DecorationSet>({
        key: WIKI_LINK_CLICK_KEY,
        state: {
          init: (_config, state) => buildDecorations(state.doc, state.selection, isMissing),
          // Rebuild on a doc change (positions shift) and on a selection move (which link
          // shows its source) — cheap for typical note sizes.
          apply: (tr, old, _before, after) =>
            tr.docChanged || tr.selectionSet || tr.getMeta(WIKI_LINK_REFRESH) ? buildDecorations(after.doc, after.selection, isMissing) : old,
        },
        // A caret that lands in a hidden run from outside the link (a click at the end of the
        // alias, Ctrl+End, WebKit placing it before the hidden `]]`) goes to that side of the
        // link: typing there would land inside its source (2026-11-04: Enter there split the
        // link). Once the source shows, the caret moves inside it freely.
        appendTransaction(trs, oldState, newState) {
          if (!trs.some((tr) => tr.selectionSet) || trs.some((tr) => tr.docChanged)) return null;
          const sel = newState.selection;
          if (!sel.empty) return null;
          const run = hiddenRunAt(newState.doc, sel.from);
          if (!run) return null;
          const old = oldState.selection;
          if (old.from <= run.to && old.to >= run.from) return null;
          const to = sel.from >= run.to - 2 ? run.to : run.from;
          return newState.tr.setSelection(TextSelection.create(newState.doc, to));
        },
        props: {
          decorations(state) {
            return WIKI_LINK_CLICK_KEY.getState(state);
          },
          handleClick(view, _pos, event) {
            const el = (event.target as HTMLElement | null)?.closest('.notes-wikilink-ref');
            const target = el?.getAttribute('data-wikilink-target');
            if (target) {
              event.preventDefault();
              onLinkClick(target);
              return true; // tell ProseMirror we handled it
            }
            return false;
          },
        },
      }),
    ];
  },
});
