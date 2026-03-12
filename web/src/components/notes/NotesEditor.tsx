/**
 * Tiptap-based WYSIWYG markdown editor for global notes.
 * Renders markdown live as you type (like Notion).
 * Markdown is the storage format — tiptap handles the rendering.
 * Supports pasting images from clipboard (uploaded to server).
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { uploadNoteImage } from '@/api/notes';
import { SlashCommandExtension } from './slash-commands/SlashCommandExtension';
import { SlashCommandPortal } from './slash-commands/SlashCommandPortal';
import type { SlashCommandState } from './slash-commands/types';
import type { Task } from '@walnut/core';

interface NotesEditorProps {
  content: string;
  onDirty: (editor: Editor) => void;
  placeholder?: string;
  className?: string;
  /** Auto-focus when mounted */
  autoFocus?: boolean;
  /** When true, skip external content sync (editor is being actively edited) */
  editing?: boolean;
  /** Tasks for slash command /task search */
  tasks?: Task[];
  /** Currently focused task ID — pinned at top of search results */
  focusedTaskId?: string;
  /** Called when user clicks a task reference link in the editor */
  onTaskClick?: (taskId: string) => void;
}

/** Link extension: adds class="task-link" to /tasks/ hrefs, strips target for internal links */
const TaskAwareLink = Link.extend({
  renderHTML({ HTMLAttributes }) {
    const href = HTMLAttributes.href || '';
    if (!href.startsWith('/tasks/')) return ['a', HTMLAttributes, 0];
    // Strip target/rel for internal task links — we handle navigation ourselves
    const attrs = { ...HTMLAttributes, class: 'task-link' };
    delete attrs.target;
    delete attrs.rel;
    return ['a', attrs, 0];
  },
});

export function NotesEditor({ content, onDirty, placeholder, className, autoFocus, editing, tasks, focusedTaskId, onTaskClick }: NotesEditorProps) {
  const isExternalUpdate = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const [slashState, setSlashState] = useState<SlashCommandState>({ phase: 'closed' });
  // Ref so ProseMirror's handleClick closure always sees the latest callback
  const onTaskClickRef = useRef(onTaskClick);
  onTaskClickRef.current = onTaskClick;

  /** Upload a File (image blob) to server, insert into editor */
  const handleImageUpload = useCallback(async (file: File, editor: Editor) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dataUrl = reader.result as string;
        if (!dataUrl?.includes(',')) return;
        const [header, base64] = dataUrl.split(',');
        if (!base64) return;
        const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/png';
        const url = await uploadNoteImage(base64, mediaType);
        editor.chain().focus().setImage({ src: url }).run();
      } catch {
        // Upload failed — insert as inline data URL as fallback
        const dataUrl = reader.result as string;
        if (dataUrl) editor.chain().focus().setImage({ src: dataUrl }).run();
      }
    };
    reader.onerror = () => { /* silently skip — user can retry paste */ };
    reader.readAsDataURL(file);
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable built-in link — we use TaskAwareLink with custom renderHTML
        link: false,
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
      TaskAwareLink.configure({
        openOnClick: false, // we handle clicks ourselves
        autolink: false,
        linkOnPaste: false,
      }),
      SlashCommandExtension.configure({
        onStateChange: setSlashState,
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
      // Intercept clicks on task-link anchors at the ProseMirror level
      handleClick: (view, pos, event) => {
        const target = event.target as HTMLElement;
        const anchor = target.closest('a');
        const href = anchor?.getAttribute('href');
        if (href?.startsWith('/tasks/') && onTaskClickRef.current) {
          event.preventDefault();
          const taskId = href.slice('/tasks/'.length);
          if (taskId) onTaskClickRef.current(taskId);
          return true; // tell ProseMirror we handled it
        }
        return false;
      },
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

  const handleSlashClose = useCallback(() => {
    setSlashState({ phase: 'closed' });
  }, []);

  return (
    <>
      <EditorContent
        editor={editor}
        className={`notes-editor ${className ?? ''}`}
      />
      {editor && slashState.phase !== 'closed' && tasks && (
        <SlashCommandPortal
          editor={editor}
          state={slashState}
          tasks={tasks}
          focusedTaskId={focusedTaskId}
          onClose={handleSlashClose}
        />
      )}
    </>
  );
}
