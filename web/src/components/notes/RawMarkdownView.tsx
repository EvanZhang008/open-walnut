/**
 * Raw markdown source view (Feature 2) — a real source editor (CodeMirror 6),
 * not a bare <textarea>. Shows the note's CURRENT markdown BODY (frontmatter is
 * intentionally NOT shown — consistent with the rendered TipTap editor, which the
 * useNoteContent hook also feeds a frontmatter-stripped body; the hook re-attaches
 * the frontmatter on save, so neither surface ever touches the metadata block).
 *
 * Save model (single source of truth): this component does NOT call the save API
 * itself. Instead it lifts every raw edit up via `onChange`; NotesEditorPanel feeds
 * that text into the (still-mounted, hidden) TipTap editor instance, whose update
 * then flows through the normal `onEditorUpdate` → useNoteContent debounced save
 * (which re-attaches frontmatter + carries the contentHash). This avoids a second,
 * divergent save path and keeps frontmatter handling in one place.
 *
 * Controlled contract: `value` is the external source of truth. Internal edits
 * flow up through the update listener; an external `value` change (prop differs
 * from the CM doc) dispatches a single full-doc replace with a length-clamped
 * selection restore so the caret doesn't jump to 0 on reseed.
 */

import { useEffect, useRef } from 'react';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { cmSearchExtension } from '@/utils/cm-search';
import { cmNoDragEdits } from '@/utils/cm-no-drag-edit';

interface RawMarkdownViewProps {
  /** The note's current markdown body (frontmatter stripped) — the seed value. */
  value: string;
  /** Lifted on every edit so the parent can flush it into the rendered editor. */
  onChange: (raw: string) => void;
}

/**
 * Borderless, app-themed chrome: the source surface should read as part of the
 * editor pane (transparent background, muted gutter, no focus ring), not as a
 * boxed widget. Height 100% + internal .cm-scroller so it fills the pane and
 * scrolls itself.
 */
const rawViewTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    fontSize: '13.5px',
    color: 'var(--fg)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily:
      "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace)",
    lineHeight: '1.6',
  },
  /* Padding lives on .cm-content (not the scroller — gutters are sticky inside
     it, and scroller bottom-padding is unreliable while scrolled). */
  '.cm-content': { padding: '16px 0 80px', caretColor: 'var(--fg)' },
  '.cm-line': { padding: '0 12px 0 6px' },
  // The gutter is sticky over a sideways-scrolled line, so it needs a solid surface;
  // opacity on it would let the line show through, so it dims only the numbers.
  '.cm-gutters': {
    backgroundColor: 'var(--bg)',
    border: 'none',
    color: 'var(--fg-muted)',
  },
  '.cm-gutter': { opacity: '0.7' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover, rgba(127, 127, 127, 0.06))' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
});

export function RawMarkdownView({ value, onChange }: RawMarkdownViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest-callback ref: the update listener lives inside a once-created view,
  // so it must read the CURRENT onChange, not the mount-time closure.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Mount-time seed only — later value changes go through the replace effect.
  const initialValueRef = useRef(value);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        rawViewTheme,
        // The page find searches this view through CodeMirror (utils/find-doc.ts):
        // its off-screen lines are not in the DOM.
        cmSearchExtension(),
        // A drag selects, never moves text: this view auto-saves, so a stray drag rewrote the note.
        cmNoDragEdits(),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    // Focus on mount (entering raw mode) so the user can type immediately.
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // External value change (prop differs from the CM doc) → one full-doc replace.
  // Internal edits round-trip through onChange → parent state → identical prop,
  // so this is a no-op while typing (cursor untouched).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    const head = Math.min(view.state.selection.main.head, value.length);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: head },
      // Not the reader's edit: the view mounts before the note's text arrives, and
      // an undoable load made one Ctrl+Z empty the note (and save it empty).
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  return <div ref={hostRef} className="notes-raw-view" />;
}
