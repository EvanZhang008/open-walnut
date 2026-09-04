import { useState, useEffect, useRef, useCallback } from 'react';
import type { Editor } from '@tiptap/core';

/**
 * useFieldContent — a save/load adapter that lets ANY flat markdown field (a task
 * description/note, a memory .md file) drive the shared MarkdownEditorPanel with
 * the same {content, onEditorUpdate, saveStatus} contract that useNoteContent
 * exposes for vault notes.
 *
 * Unlike useNoteContent it has NO frontmatter handling. Save is debounced
 * autosave (matches /notes), replacing the old manual Edit/Save button flow.
 *
 * OPTIMISTIC LOCK (opt-in, via `opts.contentHash`): a field that is ALSO editable
 * somewhere else — a memory .md file, reachable both from /memory and from the
 * Files panel — is not safe as last-write-wins, because the loser of the race is
 * a change this editor never showed. When the caller supplies the hash of the
 * bytes it loaded, it rides every write; the server answers 409 on a mismatch and
 * `opts.onConflict` is called so the page can re-read. Without it the old
 * last-write-wins behaviour is unchanged (a task description has one writer).
 *
 * @param key      stable identity of the field (taskId+':desc', memory path…). A
 *                 change re-loads. Null = nothing to edit (renders nothing).
 * @param initial  the current value (caller already has it loaded). Re-seeds when
 *                 `key` changes; ignored while the user has unsaved local edits.
 * @param save     persists the new body. May take the lock token and return the
 *                 next one.
 */
export function useFieldContent(
  key: string | null,
  initial: string,
  save: (body: string, expectedHash?: string) => Promise<{ contentHash?: string } | unknown>,
  opts: {
    /** Lock token of `initial`. Absent ⇒ last-write-wins (unchanged behaviour). */
    contentHash?: string | null;
    /** The write was refused because the file moved under us — re-read upstream. */
    onConflict?: () => void;
  } = {},
): {
  content: string | null;
  saveStatus: 'saved' | 'saving' | 'error' | 'idle';
  onEditorUpdate: (editor: Editor) => void;
} {
  const [content, setContent] = useState<string | null>(key ? initial : null);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error' | 'idle'>('idle');
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const keyRef = useRef(key);
  const savedRef = useRef<string>(initial); // last value we persisted / loaded
  /** Lock token for what is on disk: the caller's on load, ours after a write. */
  const hashRef = useRef<string | undefined>(opts.contentHash ?? undefined);
  const onConflictRef = useRef(opts.onConflict);
  onConflictRef.current = opts.onConflict;

  const DEBOUNCE_MS = 500;

  // Re-seed when the field identity changes (and not mid-edit on the same key).
  useEffect(() => {
    if (key === keyRef.current && dirtyRef.current) return;
    keyRef.current = key;
    dirtyRef.current = false;
    savedRef.current = initial;
    hashRef.current = opts.contentHash ?? undefined;
    setContent(key ? initial : null);
    setSaveStatus('idle');
  }, [key, initial, opts.contentHash]);

  const onEditorUpdate = useCallback((editor: Editor) => {
    editorRef.current = editor;
    dirtyRef.current = true;
    setSaveStatus('saving');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const ed = editorRef.current;
      if (!ed || ed.isDestroyed) { setSaveStatus('idle'); return; }
      let md: string;
      try { md = ed.storage.markdown.getMarkdown(); } catch { setSaveStatus('idle'); return; }
      if (md === savedRef.current) { dirtyRef.current = false; setSaveStatus('saved'); return; }
      save(md, hashRef.current)
        .then((res) => {
          savedRef.current = md;
          dirtyRef.current = false;
          const next = (res as { contentHash?: string } | undefined)?.contentHash;
          if (next) hashRef.current = next;
          setSaveStatus('saved');
          // Adopt what we just wrote as the content STATE, even though the editor
          // already shows it. The shared editor skips ONE incoming `content` change
          // after a local edit (its "was I the source?" flag stays set until some
          // change consumes it), so leaving state on the pre-edit seed meant the
          // FIRST write from another surface was applied here and then swallowed by
          // the editor — stale text that the next autosave wrote back over it.
          setContent(md);
        })
        .catch((err) => {
          setSaveStatus('error');
          // 409: the bytes on disk are not the bytes we edited. Same frozen
          // policy as vault notes — the OTHER writer wins, and what is lost is at
          // most this one debounce window of typing. Deliberately do NOT adopt
          // the server's currentHash: that would arm the next keystroke as a
          // silent overwrite of bytes the user has never seen. Clearing dirty is
          // what lets the caller's re-read (onConflict) re-seed the editor.
          if ((err as { status?: number } | undefined)?.status === 409) {
            dirtyRef.current = false;
            onConflictRef.current?.();
          }
        });
    }, DEBOUNCE_MS);
  }, [save]);

  // Flush a pending edit on unmount (field closed / page left).
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const ed = editorRef.current;
      if (dirtyRef.current && ed && !ed.isDestroyed) {
        try {
          const md = ed.storage.markdown.getMarkdown();
          if (md !== savedRef.current) void save(md, hashRef.current).catch(() => {});
        } catch { /* editor gone */ }
      }
    };
  }, [save]);

  return { content, saveStatus, onEditorUpdate };
}
