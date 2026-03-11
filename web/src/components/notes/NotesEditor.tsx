/**
 * Tiptap-based WYSIWYG markdown editor for global notes.
 * Renders markdown live as you type (like Notion).
 * Markdown is the storage format — tiptap handles the rendering.
 */

import { useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';

interface NotesEditorProps {
  content: string;
  onDirty: (editor: Editor) => void;
  placeholder?: string;
  className?: string;
  /** Auto-focus when mounted */
  autoFocus?: boolean;
}

export function NotesEditor({ content, onDirty, placeholder, className, autoFocus }: NotesEditorProps) {
  const isExternalUpdate = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Keep defaults for heading, bold, italic, code, blockquote, lists, etc.
      }),
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? 'Write your notes here... (Markdown supported)',
      }),
      Markdown.configure({
        html: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content,
    autofocus: autoFocus ? 'end' : false,
    onUpdate: ({ editor }) => {
      if (isExternalUpdate.current) return;
      // Signal dirty — no serialization here
      onDirty(editor);
    },
  });

  // Sync external content changes (e.g. after save syncs content state)
  useEffect(() => {
    if (!editor) return;
    const currentMd = editor.storage.markdown.getMarkdown();
    if (currentMd !== content) {
      isExternalUpdate.current = true;
      editor.commands.setContent(content);
      isExternalUpdate.current = false;
    }
  }, [content, editor]);

  // Cleanup
  useEffect(() => {
    return () => {
      editor?.destroy();
    };
  }, [editor]);

  return (
    <EditorContent
      editor={editor}
      className={`notes-editor ${className ?? ''}`}
    />
  );
}
