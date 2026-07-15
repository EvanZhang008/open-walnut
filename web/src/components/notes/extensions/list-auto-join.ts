/**
 * Auto-join adjacent same-type lists.
 *
 * Editing can leave two sibling lists of the same type touching (e.g. typing
 * "1. " in the paragraph right after a list, or deleting the paragraph that
 * separated two lists). That renders as numbering restarting at 1 mid-section
 * — which reads as broken (user-reported). One visually continuous list should
 * BE one list, so we join touching same-type siblings eagerly.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { canJoin } from '@tiptap/pm/transform';
import type { Node as PMNode } from '@tiptap/pm/model';

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/** First boundary position where two same-type sibling lists touch, or null. */
function findJoinPoint(doc: PMNode): number | null {
  let found: number | null = null;
  const scan = (node: PMNode, base: number) => {
    let pos = base;
    for (let i = 0; i < node.childCount; i++) {
      if (found !== null) return;
      const child = node.child(i);
      if (i > 0 && LIST_TYPES.has(child.type.name) && node.child(i - 1).type === child.type) {
        found = pos;
        return;
      }
      if (child.childCount > 0) scan(child, pos + 1);
      pos += child.nodeSize;
    }
  };
  scan(doc, 0);
  return found;
}

export const ListAutoJoin = Extension.create({
  name: 'listAutoJoin',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('listAutoJoin'),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          const tr = newState.tr;
          let joined = false;
          // A join can bring another pair together — loop (bounded) until clean.
          for (let guard = 0; guard < 25; guard++) {
            const at = findJoinPoint(tr.doc);
            if (at === null || !canJoin(tr.doc, at)) break;
            tr.join(at);
            joined = true;
          }
          return joined ? tr : null;
        },
      }),
    ];
  },
});
