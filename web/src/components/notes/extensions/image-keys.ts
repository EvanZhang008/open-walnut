/**
 * Backspace or Delete next to a picture selects it first; the next press deletes it.
 *
 * A picture is an inline atom, usually alone in its paragraph. Backspace at the
 * start of the line below joined that line into the picture's paragraph or took
 * the picture with it in one press, with nothing shown first (2026-11-05 review);
 * every editor people know selects an object before deleting it.
 */
import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * Class on a selected picture's outer element. Set by a decoration from the
 * selection itself: TipTap's React node view (an `![[embed]]`) does not reliably
 * get ProseMirror's own selected class (in Chromium it never did, 2026-11-05),
 * so a selected embed looked unselected and Backspace deleted it unseen.
 */
export const PICTURE_SELECTED_CLASS = 'notes-picture-selected';

/** Node types drawn as a picture or file card. */
const PICTURE_TYPES = new Set(['image', 'wikiEmbed']);

const isPicture = (node: PMNode | null | undefined): node is PMNode => !!node && PICTURE_TYPES.has(node.type.name);

export const ImageKeys = Extension.create({
  name: 'imageKeys',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('pictureSelected'),
        props: {
          decorations(state) {
            const sel = state.selection;
            if (!(sel instanceof NodeSelection) || !isPicture(sel.node)) return null;
            return DecorationSet.create(state.doc, [Decoration.node(sel.from, sel.to, { class: PICTURE_SELECTED_CLASS })]);
          },
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    const selectBeside = (dir: -1 | 1) => {
      const { state, view } = this.editor;
      const sel = state.selection;
      if (!sel.empty) return false;
      const $pos = sel.$from;
      const parent = $pos.parent;
      if (!parent.isTextblock) return false;
      // Inside a line: a picture right beside the caret.
      const inline = dir < 0 ? $pos.nodeBefore : $pos.nodeAfter;
      if (isPicture(inline)) {
        const at = dir < 0 ? $pos.pos - inline.nodeSize : $pos.pos;
        view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)));
        return true;
      }
      // At the edge of a line: the picture that ends the line above (or starts the line below).
      const atEdge = dir < 0 ? $pos.parentOffset === 0 : $pos.parentOffset === parent.content.size;
      if (!atEdge || $pos.depth < 1) return false;
      const index = $pos.index($pos.depth - 1);
      const container = $pos.node($pos.depth - 1);
      const siblingIndex = index + dir;
      if (siblingIndex < 0 || siblingIndex >= container.childCount) return false;
      const sibling = container.child(siblingIndex);
      if (!sibling.isTextblock) return false;
      const edge = dir < 0 ? sibling.lastChild : sibling.firstChild;
      if (!isPicture(edge)) return false;
      const blockStart = dir < 0 ? $pos.before() - sibling.nodeSize : $pos.after();
      const at = dir < 0 ? blockStart + 1 + sibling.content.size - edge.nodeSize : blockStart + 1;
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, at)));
      return true;
    };
    return {
      Backspace: () => selectBeside(-1),
      Delete: () => selectBeside(1),
    };
  },
});
