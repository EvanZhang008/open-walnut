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
 *    or re-serialized). The body keeps the file's own bytes on every line the
 *    user did not edit (keepUntouchedSource): the serializer's spelling reaches
 *    disk only where the user typed.
 *  - `onDirtyChange(true)` on the first genuine user edit. NotesEditor.onDirty
 *    fires only for real edits (programmatic content syncs are guarded), so the
 *    first call IS a user keystroke. Unlike the CodeMirror editor we cannot
 *    cheaply compare against the seed — tiptap-markdown does not round-trip
 *    byte-clean — so dirtiness is sticky until the post-save remount.
 *  - Cmd/Ctrl+S saves via `onSave` (NotesEditor has no save keymap because the
 *    vault autosaves; the wrapper catches it before the browser's Save dialog).
 */
import { useRef, useMemo, useState, useCallback, useImperativeHandle, forwardRef } from 'react';
import { createDocument, type Editor } from '@tiptap/core';
import { NotesEditor } from '@/components/notes/NotesEditor';
import { normalizeForEditor } from '@/components/notes/notes-content-preprocess';
import { splitFrontmatter, joinFrontmatter } from '@/components/notes/frontmatter';
import { entityRefsToMarkdownLinks } from '@/utils/markdown';
import { keepUntouchedSource } from '@/utils/markdown-keep-source';
import type { FileSourceEditorHandle } from './FileSourceEditor';

/** The Markdown the editor would make of `body` with nobody touching it: the same
 *  parse setContent runs, then the serializer. */
function serializeUntouched(ed: Editor, body: string): string {
  const html = ed.storage.markdown.parser.parse(normalizeForEditor(entityRefsToMarkdownLinks(body))) as string;
  return ed.storage.markdown.serializer.serialize(createDocument(html, ed.schema, ed.options.parseOptions)) as string;
}


interface FileMarkdownEditorProps {
  /** Full file bytes (frontmatter included). Only read on mount — see contract. */
  initialValue: string;
  /** The disk bytes `initialValue` is based on — see FileSourceEditorHandle.getBase. */
  baseValue?: string;
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
  /** Reload generation for embedded image URLs — the parent's reload token. */
  imageVersion?: string | number;
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
  /** `Ask here` on the bubble menu: a question answered beside the passage. */
  onAskHere?: (range: Range) => void;
  /** `Comment`: a doc comment on the selection (its range and its text). */
  onComment?: (range: Range, text: string) => void;
}

export const FileMarkdownEditor = forwardRef<FileSourceEditorHandle, FileMarkdownEditorProps>(
  function FileMarkdownEditor({ initialValue, baseValue, path, host, imageVersion, onDirtyChange, onDocChange, onSave, onAskSelection, onAskHere, onComment }, ref) {
    // Mount-scoped split: the parent remounts (key) to reseed, mirroring
    // FileSourceEditor. The frontmatter half never enters the editor.
    const seedRef = useRef(splitFrontmatter(initialValue));
    /** WHOLE-FILE bytes the content is a modification of — see
     *  FileSourceEditorHandle.getBase. Kept as one string (frontmatter included)
     *  because a write is whole-file. */
    const baseRef = useRef(baseValue ?? initialValue);
    /** Seeded with text that is NOT the disk bytes (a restored version, a
     *  replayed draft): unsaved from the first frame, so ⌘S must write it even
     *  before a keystroke. Cleared once a save or a reseed lines them up. */
    const seededUnsavedRef = useRef(baseValue != null && baseValue !== initialValue);
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
    const appliedRef = useRef<{ text: string; body: string } | null>(null);
    const dirtyRef = useRef(false);
    /** serializeUntouched(seed body), computed once per seed: the merge base that
     *  lets a save keep every line the user did not edit (keepUntouchedSource). */
    const untouchedRef = useRef<{ body: string; md: string } | null>(null);
    const untouchedOf = (ed: Editor, body: string): string | null => {
      if (untouchedRef.current?.body === body) return untouchedRef.current.md;
      try {
        const md = serializeUntouched(ed, body);
        untouchedRef.current = { body, md };
        return md;
      } catch { return null; }
    };
    /** The last body handed out and what it became, so a draft capture and the
     *  write that follows it do not merge the same text twice. */
    const keptRef = useRef<{ seed: string; body: string; text: string } | null>(null);
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

    /** `body` with every line the user did not edit put back to the seed's own
     *  bytes. Used only when the editor loads the result as the same document as
     *  `body` (both load and serialize to the same text: loading also collapses
     *  runs of spaces, which typing can leave in `body`); anything else writes
     *  `body` as it is, the editor's own spelling. Not "renders to the same HTML":
     *  the serializer is lossy (inline code ending in a space loses the space after
     *  it), so the file's own bytes can render better than the editor's spelling,
     *  and that check threw the whole merge away (2026-11-07, a 153-line note). */
    const keepSource = (ed: Editor, body: string): string => {
      const seed = seedRef.current.body;
      if (keptRef.current?.body === body && keptRef.current.seed === seed) return keptRef.current.text;
      let text = body;
      try {
        const untouched = untouchedOf(ed, seed);
        if (untouched != null) {
          const kept = keepUntouchedSource(seed, untouched, body);
          if (kept === body || serializeUntouched(ed, kept) === serializeUntouched(ed, body)) text = kept;
        }
      } catch { /* the editor's spelling is always a correct save */ }
      keptRef.current = { seed, body, text };
      return text;
    };

    useImperativeHandle(ref, () => ({
      getValue: () => {
        const ed = editorRef.current;
        // No editor captured yet ⇒ no user edit happened ⇒ the seed is current.
        const body = ed && !ed.isDestroyed
          ? (ed.storage.markdown.getMarkdown() as string)
          : seedRef.current.body;
        // 程序装入后尚未编辑的正文保留原始字节，避免格式化被当成保存期间的新输入。
        if (appliedRef.current?.body === body) return appliedRef.current.text;
        return joinFrontmatter(seedRef.current.frontmatter, ed && !ed.isDestroyed ? keepSource(ed, body) : body);
      },
      getBase: () => baseRef.current,
      /** See FileSourceEditorHandle.setBase — base moves, document does not. */
      setBase: (text: string) => { baseRef.current = text; },
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
      setValue: (text: string, base?: string) => {
        // See FileSourceEditor.setValue: a merge's text is not the disk bytes, an
        // adopt's is.
        baseRef.current = base ?? text;
        seededUnsavedRef.current = false;
        seedRef.current = splitFrontmatter(text);
        appliedRef.current = null;
        const ed = editorRef.current;
        if (ed && !ed.isDestroyed) {
          ed.commands.setContent(
            normalizeForEditor(entityRefsToMarkdownLinks(seedRef.current.body)),
            { emitUpdate: false },
          );
          appliedRef.current = { text, body: ed.storage.markdown.getMarkdown() as string };
          return;
        }
        bumpSeed((n) => n + 1);
      },
      markClean: (diskText: string) => {
        // The disk bytes become the seed the next edit is kept against: seeding
        // with the serializer's spelling would let the next save rewrite the file.
        seedRef.current = splitFrontmatter(diskText);
        // 序列化会规范化 Markdown 格式，不能用它替换磁盘的原始字节基线。
        baseRef.current = diskText;
        seededUnsavedRef.current = false;
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
        const seed = seedRef.current.body;
        if (md.replace(/\s+$/, '') === seed.replace(/\s+$/, '')) return;
        if (md === untouchedOf(editor, seed)) return;
        dirtyRef.current = true;
        onDirtyChangeRef.current(true);
      }
      appliedRef.current = null;
      onDocChangeRef.current?.();
    }, []);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        // No-edit Cmd+S is a no-op ON PURPOSE: tiptap-markdown does not
        // round-trip byte-clean, so "saving" an untouched doc would still
        // rewrite the file with normalized markdown.
        if (dirtyRef.current || seededUnsavedRef.current) onSaveRef.current();
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
          onAskHere={onAskHere}
          onComment={onComment}
          imageBaseDir={imageBaseDir}
          imageHost={host}
          imageVersion={imageVersion}
        />
      </div>
    );
  },
);
