/**
 * FileMarkdownEditor — the Files panel's WYSIWYG edit surface for markdown files.
 *
 * REUSES the Notes TipTap editor (NotesEditor) so editing a repo README feels
 * exactly like editing a note — but wired to the Files panel's EXPLICIT-save
 * contract instead of the vault's debounced autosave (an agent may be writing
 * the same repo in the same second; see web/src/AGENTS.md "Files panel").
 *
 * Contract — identical to FileSourceEditor, so FileContentView holds either
 * editor behind one ref:
 *  - `initialValue` seeds ONCE per mount; the parent remounts (via `key`) to
 *    reseed after a save or reload.
 *  - `getValue()` returns the FULL file bytes: the frontmatter block is split
 *    off before the editor sees the body and re-prepended VERBATIM at save time
 *    (same splitFrontmatter/joinFrontmatter as Notes — metadata is never edited
 *    or re-serialized).
 *  - `onDirtyChange(true)` on the first genuine user edit. NotesEditor.onDirty
 *    fires only for real edits (programmatic content syncs are guarded), so the
 *    first call IS a user keystroke. Unlike the CodeMirror editor we cannot
 *    cheaply compare against the seed — tiptap-markdown does not round-trip
 *    byte-clean — so dirtiness is sticky until the post-save remount.
 *  - Cmd/Ctrl+S saves via `onSave` (NotesEditor has no save keymap because the
 *    vault autosaves; the wrapper catches it before the browser's Save dialog).
 */
import { useRef, useMemo, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import type { Editor } from '@tiptap/core';
import { NotesEditor } from '@/components/notes/NotesEditor';
import { normalizeForEditor } from '@/components/notes/notes-content-preprocess';
import { splitFrontmatter, joinFrontmatter } from '@/components/notes/frontmatter';
import { entityRefsToMarkdownLinks } from '@/utils/markdown';
import type { FileSourceEditorHandle } from './FileSourceEditor';

interface FileMarkdownEditorProps {
  /** Full file bytes (frontmatter included). Only read on mount — see contract. */
  initialValue: string;
  /**
   * Absolute path of the file being edited. Only its DIRECTORY is used, and only
   * for rendering: a relative image reference (`![alt](diagram.png)`, which is how
   * markdown authors write one) has to resolve against the file, not against the
   * SPA origin, or the editor paints a broken-image box for a picture that sits
   * right next to the .md. The saved bytes keep the original relative path.
   */
  path: string;
  /** Exec host the file lives on (undefined = this Mac). */
  host?: string;
  /** Fired once, on the first genuine user edit. */
  onDirtyChange: (dirty: boolean) => void;
  /**
   * Fired on every doc change the parent's debounced draft writer should see.
   * Deliberately NOT every TipTap onUpdate: NotesEditor emits normalization
   * transactions right after seeding (list auto-join, trailing-newline trim),
   * and tiptap-markdown does not round-trip byte-clean — so those would persist
   * a "draft" for a file nobody touched and greet the next visit with a bogus
   * "Draft restored" receipt. Gated behind the same genuine-edit check that
   * arms `onDirtyChange`, then fires on every change after it.
   */
  onDocChange?: () => void;
  /** Cmd/Ctrl+S. */
  onSave: () => void;
  /** Quote-to-ask: adds an "Ask" action to the selection bubble menu. */
  onAskSelection?: (text: string) => void;
}

export const FileMarkdownEditor = forwardRef<FileSourceEditorHandle, FileMarkdownEditorProps>(
  function FileMarkdownEditor({ initialValue, path, host, onDirtyChange, onDocChange, onSave, onAskSelection }, ref) {
    // Mount-scoped split: the parent remounts (key) to reseed, mirroring
    // FileSourceEditor. The frontmatter half never enters the editor.
    const seedRef = useRef(splitFrontmatter(initialValue));
    // Directory of the file — the base a relative image src resolves against.
    // `/README.md` (a file at the filesystem root) has an empty prefix, so it
    // becomes `/`; a bare `README.md` with no directory at all stays undefined,
    // which the editor reads as "don't touch relative srcs".
    const imageBaseDir = useMemo(() => {
      const cut = path.lastIndexOf('/');
      if (cut > 0) return path.slice(0, cut);
      return cut === 0 ? '/' : undefined;
    }, [path]);
    const editorRef = useRef<Editor | null>(null);
    const dirtyRef = useRef(false);
    // Re-render channel for setValue when no editor has been captured yet — see
    // the handle below. Only the setter is needed; the count itself is never read.
    const [, bumpSeed] = useState(0);
    // Latest-callback refs — the TipTap instance outlives any one render.
    const onDirtyChangeRef = useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;
    const onDocChangeRef = useRef(onDocChange);
    onDocChangeRef.current = onDocChange;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;

    useImperativeHandle(ref, () => ({
      getValue: () => {
        const ed = editorRef.current;
        // No editor captured yet ⇒ no user edit happened ⇒ the seed is current.
        const body = ed && !ed.isDestroyed
          ? (ed.storage.markdown.getMarkdown() as string)
          : seedRef.current.body;
        return joinFrontmatter(seedRef.current.frontmatter, body);
      },
      focus: () => { editorRef.current?.commands.focus(); },
      /**
       * Replace the document in place (Live Edit's merge/pull path).
       *
       * The frontmatter half has to move with it: getValue() re-prepends
       * seedRef's frontmatter VERBATIM, so leaving it behind would write the old
       * metadata block on top of merged content.
       *
       * TWO paths because `editorRef` is only populated by `handleDirty` — i.e.
       * on the first real edit. Before that (a clean buffer, which is exactly
       * the agent-pull case) there is no editor to command, so the new seed goes
       * through NotesEditor's OWN external-content sync instead, which a
       * re-render triggers. `emitUpdate: false` on the imperative path is what
       * keeps a programmatic set from being reported as a user edit.
       */
      setValue: (text: string) => {
        seedRef.current = splitFrontmatter(text);
        const ed = editorRef.current;
        if (ed && !ed.isDestroyed) {
          ed.commands.setContent(
            normalizeForEditor(entityRefsToMarkdownLinks(seedRef.current.body)),
            { emitUpdate: false },
          );
          return;
        }
        bumpSeed((n) => n + 1);
      },
      markClean: () => {
        const ed = editorRef.current;
        if (ed && !ed.isDestroyed) {
          seedRef.current = {
            ...seedRef.current,
            body: ed.storage.markdown.getMarkdown() as string,
          };
        }
        if (dirtyRef.current) {
          dirtyRef.current = false;
          onDirtyChangeRef.current(false);
        }
      },
    }), []);

    const handleDirty = useCallback((editor: Editor) => {
      editorRef.current = editor;
      if (!dirtyRef.current) {
        // NotesEditor can emit a mount-time onDirty that is NOT a user edit —
        // TipTap normalization transactions (list auto-join, trailing-newline
        // trim) fire onUpdate right after seeding. Verified live: Save lit up
        // before any keystroke. So while clean, serialize and compare against
        // the seed (modulo trailing whitespace, which the serializer drops);
        // only a genuine difference arms dirty. Costs one serialize per event,
        // and only until the first real edit flips the sticky flag.
        let md: string;
        try { md = editor.storage.markdown.getMarkdown() as string; } catch { return; }
        if (md.replace(/\s+$/, '') === seedRef.current.body.replace(/\s+$/, '')) return;
        dirtyRef.current = true;
        onDirtyChangeRef.current(true);
      }
      onDocChangeRef.current?.();
    }, []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        // No-edit Cmd+S is a no-op ON PURPOSE: tiptap-markdown does not
        // round-trip byte-clean, so "saving" an untouched doc would still
        // rewrite the file with normalized markdown.
        if (dirtyRef.current) onSaveRef.current();
      }
    }, []);

    return (
      <div className="fv-wysiwyg-editor" onKeyDown={handleKeyDown}>
        <NotesEditor
          content={seedRef.current.body}
          onDirty={handleDirty}
          placeholder="Empty file — start writing…"
          enableBlockTools
          onAskSelection={onAskSelection}
          imageBaseDir={imageBaseDir}
          imageHost={host}
        />
      </div>
    );
  },
);
