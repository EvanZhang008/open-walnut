import type { Editor } from '@tiptap/core';

/**
 * The editor's DOM once its view is mounted, else null. tiptap's `editor.view` throws until
 * EditorContent has mounted the view, so anything that may run while a just-made editor renders
 * reads it through here (tests/web/editor-view-in-render-guard.test.ts).
 */
export function editorDomOf(editor: Editor): HTMLElement | null {
  if (editor.isDestroyed) return null;
  try { return editor.view.dom as HTMLElement; } catch { return null; }
}

/** A ref to the editor's DOM read when used, never when made: module level, so it keeps no render. */
export function editorRefOf(editor: Editor): { readonly current: HTMLElement | null } {
  return { get current() { return editorDomOf(editor); } };
}
