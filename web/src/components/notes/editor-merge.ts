/**
 * A three-way merge shown in the open editor at once, without rebuilding it: the caret, the
 * selection and the undo history stay, and the next save carries the other writer's change.
 * One helper for both note editors that merge after a conflict: a plain note
 * (hooks/useNoteContent.ts mergeAfterConflict) and a locked one (useLockedNoteEditor.ts).
 */
import type { Editor } from '@tiptap/core';
import { threeWayMerge, type MergeResult } from '@open-walnut/three-way-merge';
import { splitFrontmatter } from './frontmatter';
import { loadsAs } from './editor-keep-source';
import { normalizeForEditor } from './notes-content-preprocess';
import { entityRefsToMarkdownLinks } from '@/utils/markdown';

/** Put `body` (Markdown, no frontmatter) in `editor` keeping the selection; nothing when it already shows that document. */
export function showInEditor(editor: Editor, body: string): void {
  // Saves keep the note's own bytes, so compare documents, not spellings.
  const shown = editor.storage.markdown.getMarkdown();
  if (body === shown || loadsAs(editor, body, shown)) return;
  const { from, to } = editor.state.selection;
  editor.commands.setContent(normalizeForEditor(entityRefsToMarkdownLinks(body)), { emitUpdate: false });
  const max = editor.state.doc.content.size;
  editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
}

export type EditorMerge =
  | { ok: true; merged: string; frontmatter: string; body: string }
  | Extract<MergeResult, { ok: false }>;

/**
 * Merge `ours` (the editor's text now, frontmatter included) with `theirs`, both made from `base`,
 * and show the merge in `editor` when it is open. Not ok when the two change the same lines.
 */
export function mergeIntoEditor(editor: Editor | null, base: string, ours: string, theirs: string): EditorMerge {
  const merge = threeWayMerge(base, ours, theirs, { idFrom: 'theirs' });
  if (!merge.ok) return merge;
  const { frontmatter, body } = splitFrontmatter(merge.merged);
  if (editor && !editor.isDestroyed) showInEditor(editor, body);
  return { ok: true, merged: merge.merged, frontmatter, body };
}
