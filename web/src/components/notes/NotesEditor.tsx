/**
 * Tiptap-based WYSIWYG markdown editor for global notes.
 * Renders markdown live as you type (like Notion).
 * Markdown is the storage format — tiptap handles the rendering.
 * Supports pasting images from clipboard (uploaded to server).
 */

import { useEffect, useRef, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import { Markdown } from 'tiptap-markdown';
import { uploadNoteImage } from '@/api/notes';

interface NotesEditorProps {
  content: string;
  onDirty: (editor: Editor) => void;
  placeholder?: string;
  className?: string;
  /** Auto-focus when mounted */
  autoFocus?: boolean;
  /** When true, skip external content sync (editor is being actively edited) */
  editing?: boolean;
}

export function NotesEditor({ content, onDirty, placeholder, className, autoFocus, editing }: NotesEditorProps) {
  const isExternalUpdate = useRef(false);
  const editorRef = useRef<Editor | null>(null);

  /** Upload a File (image blob) to server, insert into editor */
  const handleImageUpload = useCallback(async (file: File, editor: Editor) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = reader.result as string;
        // dataUrl = "data:image/png;base64,iVBOR..."
        const [header, base64] = dataUrl.split(',');
        const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/png';
        const url = await uploadNoteImage(base64, mediaType);
        editor.chain().focus().setImage({ src: url }).run();
      } catch {
        // Fallback: insert as inline data URL (works but bloats markdown)
        const dataUrl = reader.result as string;
        editor.chain().focus().setImage({ src: dataUrl }).run();
      }
    };
    reader.readAsDataURL(file);
  }, []);

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
      Image.configure({
        inline: true,
        allowBase64: true,
      }),
      Markdown.configure({
        html: true, // needed for <img> tags in markdown
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
    editorProps: {
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file && editorRef.current) {
              handleImageUpload(file, editorRef.current);
            }
            return true;
          }
        }
        return false; // let tiptap handle non-image pastes
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files?.length) return false;
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            event.preventDefault();
            if (editorRef.current) {
              handleImageUpload(file, editorRef.current);
            }
            return true;
          }
        }
        return false;
      },
    },
  });

  // Keep editorRef in sync
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // Sync external content changes (e.g. initial load, popup/sidebar sync after save)
  // Skip when `editing` is true — the editor owns the source of truth during active editing
  useEffect(() => {
    if (!editor || editing) return;
    const currentMd = editor.storage.markdown.getMarkdown();
    if (currentMd !== content) {
      isExternalUpdate.current = true;
      editor.commands.setContent(content);
      isExternalUpdate.current = false;
    }
  }, [content, editor, editing]);

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
