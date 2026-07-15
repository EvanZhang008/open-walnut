/**
 * Shared block-transform module — the SINGLE path for inserting / converting
 * blocks, used by the slash menu and the bubble toolbar "Turn into" (one
 * transform, shared across surfaces — §3.4 / §1 of 03-editor-architecture.md).
 * Each transform is ONE ProseMirror transaction so one user action maps to
 * exactly one Cmd+Z (the P0 editing-quality bar).
 *
 * Every command runs through `editor.chain()...run()`, which dispatches a
 * single transaction and fires `onUpdate` once — so reorder/insert/turn-into
 * all ride the existing isSourceRef save path (no out-of-band setContent).
 */

import type { Editor, Range } from '@tiptap/core';
import { log } from '@/utils/log';

/** Block kinds the slash menu / bubble toolbar can turn the current block into. */
export type BlockKind =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'codeBlock'
  | 'divider'
  | 'callout'
  | 'table'
  | 'image';

/** Callout kinds — FROZEN allow-set (§3.3 of IMPL-CONTRACT). */
export const CALLOUT_KINDS = ['note', 'tip', 'warning', 'danger', 'info'] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];

/**
 * Insert (or convert the current empty block into) a block of the given kind.
 * When `range` is provided (slash trigger), the `/query` text is deleted first
 * so insertion is byte-clean — no trailing slash text, no stray blank line.
 *
 * Returns true if a transform ran. Image is handled by the caller (needs a URL
 * picker) — we expose it in the catalog but `run` is a no-op fallback here.
 */
export function insertBlock(editor: Editor, kind: BlockKind, range?: Range): boolean {
  if (!editor) return false;
  try {
    const chain = editor.chain().focus();
    if (range) chain.deleteRange(range);

    switch (kind) {
      case 'paragraph':
        return chain.setParagraph().run();
      case 'h1':
        return chain.setHeading({ level: 1 }).run();
      case 'h2':
        return chain.setHeading({ level: 2 }).run();
      case 'h3':
        return chain.setHeading({ level: 3 }).run();
      case 'bulletList':
        return chain.toggleBulletList().run();
      case 'orderedList':
        return chain.toggleOrderedList().run();
      case 'taskList':
        return chain.toggleTaskList().run();
      case 'blockquote':
        return chain.toggleBlockquote().run();
      case 'codeBlock':
        return chain.toggleCodeBlock().run();
      case 'divider':
        // setHorizontalRule leaves the caret in a fresh paragraph after the rule.
        return chain.setHorizontalRule().run();
      case 'callout':
        return chain.setCallout({ kind: 'note' }).run();
      case 'table':
        // 3 columns x 3 rows WITH a header row (caret lands in the first cell).
        return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      case 'image':
        // Image needs a URL — caller opens a picker. No-op here keeps the menu honest.
        return false;
      default:
        return false;
    }
  } catch (err) {
    log.warn('notes', 'insertBlock failed', { kind, error: String(err) });
    return false;
  }
}

/**
 * Turn the current selection's block into another kind (bubble toolbar "Turn
 * into" / grip menu). No range delete — operates on the existing block. Marks
 * (bold/italic/strike/code/link) are toggled directly by the bubble UI via
 * editor.chain(), not here — this module only owns BLOCK-level conversion.
 */
export function turnInto(editor: Editor, kind: BlockKind): boolean {
  return insertBlock(editor, kind);
}

/** Whether the current selection sits inside the given block kind (for active state). */
export function isActiveBlock(editor: Editor | null, kind: BlockKind): boolean {
  if (!editor) return false;
  switch (kind) {
    case 'h1':
      return editor.isActive('heading', { level: 1 });
    case 'h2':
      return editor.isActive('heading', { level: 2 });
    case 'h3':
      return editor.isActive('heading', { level: 3 });
    case 'paragraph':
      return editor.isActive('paragraph');
    case 'bulletList':
      return editor.isActive('bulletList');
    case 'orderedList':
      return editor.isActive('orderedList');
    case 'taskList':
      return editor.isActive('taskList');
    case 'blockquote':
      return editor.isActive('blockquote');
    case 'codeBlock':
      return editor.isActive('codeBlock');
    case 'callout':
      return editor.isActive('callout');
    default:
      return false;
  }
}
