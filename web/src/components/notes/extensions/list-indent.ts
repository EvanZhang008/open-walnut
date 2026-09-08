/**
 * Per-line list indent / outdent — the ONE implementation behind the Tab key
 * (NotesEditor.handleKeyDown) and the format toolbar's → / ← buttons.
 *
 * "Per-line" is the deliberate departure from ProseMirror's default: sinking an
 * item normally drags its nested children along; here only the current item
 * moves and its children become its siblings, which is how Notion/Workflowy
 * feel. The join-then-sink fallback handles the very common case where a blank
 * line in the markdown split one logical list into two ProseMirror lists, so
 * "first item of a list" (which cannot sink) is really "item after a gap".
 */

import type { Editor } from '@tiptap/core';
import { canJoin } from '@tiptap/pm/transform';
import { log } from '@/utils/log';

const LIST_TYPES = new Set(['taskList', 'bulletList', 'orderedList']);

/** The list item type ('taskItem' | 'listItem') the selection sits in, or null. */
export function findListItemType(editor: Editor): 'taskItem' | 'listItem' | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name;
    if (name === 'taskItem' || name === 'listItem') return name;
  }
  return null;
}

/** Indent the current list item one level (per-line: children stay put). */
export function indentListItem(editor: Editor, listItemType: string): boolean {
  const sunk = editor.commands.sinkListItem(listItemType);
  if (sunk) {
    detachListItemChildren(editor);
    return true;
  }
  // Sink failed — item is likely first in a split list. Join with the previous
  // same-type list, then retry.
  return tryJoinPreviousListAndSink(editor, listItemType);
}

/** Outdent the current list item one level. */
export function outdentListItem(editor: Editor, listItemType: string): boolean {
  return editor.commands.liftListItem(listItemType);
}

/**
 * When sinkListItem fails (item is first in its list), try joining the
 * current list with the nearest previous same-type list — removing any
 * empty paragraphs between them — then retry sink.
 */
function tryJoinPreviousListAndSink(editor: Editor, listItemType: string): boolean {
  try {
    const { state } = editor;
    const { $from } = state.selection;

    // Find the containing list node
    let listDepth = 0;
    for (let d = $from.depth; d > 0; d--) {
      if (LIST_TYPES.has($from.node(d).type.name)) {
        listDepth = d;
        break;
      }
    }
    if (!listDepth || $from.index(listDepth) !== 0) return false;

    const listType = $from.node(listDepth).type;
    const parent = $from.node(listDepth - 1);
    const listIdx = $from.index(listDepth - 1);
    if (listIdx === 0) return false;

    // Only join with the IMMEDIATELY previous sibling if it's the same list type,
    // or if there's exactly one empty block between them (single blank line).
    // Multiple empty blocks = intentional separation, don't join.
    const prevSibling = parent.child(listIdx - 1);
    let prevListIdx: number;

    if (prevSibling.type === listType) {
      prevListIdx = listIdx - 1;
    } else if (
      prevSibling.content.size === 0 &&
      listIdx >= 2 &&
      parent.child(listIdx - 2).type === listType
    ) {
      prevListIdx = listIdx - 2;
    } else {
      return false;
    }

    // Calculate gap: from end of prevList to start of our list
    const contentStart = $from.start(listDepth - 1);
    let offset = 0;
    for (let i = 0; i <= prevListIdx; i++) offset += parent.child(i).nodeSize;
    const gapStart = contentStart + offset; // right after prevList

    let listOffset = 0;
    for (let i = 0; i < listIdx; i++) listOffset += parent.child(i).nodeSize;
    const gapEnd = contentStart + listOffset; // right before our list

    const { tr } = state;

    // Delete empty paragraphs between the two lists
    if (gapStart < gapEnd) tr.delete(gapStart, gapEnd);

    // Join the now-adjacent same-type lists
    const joinAt = tr.mapping.map(gapStart);
    // canJoin is a free function in prosemirror-transform, not a Node method.
    if (!canJoin(tr.doc, joinAt)) return false;
    tr.join(joinAt);
    editor.view.dispatch(tr);

    // Retry sink — now the item has a previous sibling
    const sunk = editor.commands.sinkListItem(listItemType);
    if (sunk) detachListItemChildren(editor);
    return sunk;
  } catch (err) {
    log.warn('notes', 'tryJoinPreviousListAndSink failed', { error: String(err) });
    return false;
  }
}

/**
 * Detach nested child list from the list item at cursor,
 * making them siblings after the current item.
 */
function detachListItemChildren(editor: Editor): boolean {
  try {
    const { state } = editor;
    const { $from } = state.selection;

    let depth = $from.depth;
    while (depth > 0) {
      const name = $from.node(depth).type.name;
      if (name === 'taskItem' || name === 'listItem') break;
      depth--;
    }
    if (depth === 0) return false;

    const item = $from.node(depth);
    const itemPos = $from.before(depth);
    const itemEnd = $from.after(depth);

    // Find nested list (taskList, bulletList, orderedList) within this item
    let nestedList: ReturnType<typeof item.child> | null = null;
    let offsetInItem = 1; // +1 for item open tag

    for (let i = 0; i < item.childCount; i++) {
      const child = item.child(i);
      if (LIST_TYPES.has(child.type.name)) {
        nestedList = child;
        break;
      }
      offsetInItem += child.nodeSize;
    }

    if (!nestedList || nestedList.childCount === 0) return false;

    const children: ReturnType<typeof item.child>[] = [];
    nestedList.forEach(child => children.push(child));

    const nestedPos = itemPos + offsetInItem;
    const { tr } = state;

    // Validate positions before mutating
    if (nestedPos < 0 || nestedPos + nestedList.nodeSize > state.doc.content.size + 2) {
      log.warn('notes', 'detachListItemChildren: position out of bounds', {
        nestedPos, nestedSize: nestedList.nodeSize, docSize: state.doc.content.size,
      });
      return false;
    }

    // Remove nested list from inside the item
    tr.delete(nestedPos, nestedPos + nestedList.nodeSize);

    // Insert children as siblings after the (now shorter) item
    let insertPos = tr.mapping.map(itemEnd);
    for (const child of children) {
      tr.insert(insertPos, child);
      insertPos += child.nodeSize;
    }

    // Validate resulting document before dispatch
    try { tr.doc.check(); } catch (checkErr) {
      log.warn('notes', 'detachListItemChildren: invalid doc after transform, aborting', {
        error: String(checkErr),
      });
      return false;
    }

    editor.view.dispatch(tr);
    return true;
  } catch (err) {
    log.warn('notes', 'detachListItemChildren failed', { error: String(err) });
    return false;
  }
}
