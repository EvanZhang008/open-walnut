/**
 * FileSourceEditor — the Files panel's edit surface: a real CodeMirror 6 source
 * editor for ANY file the viewer can read as text, not just markdown.
 *
 * Sibling of notes/RawMarkdownView.tsx, deliberately NOT a reuse of it: that one
 * is hard-wired to markdown, is frontmatter-aware, and lifts every keystroke to a
 * debounced auto-save. A code file has neither frontmatter nor a safe auto-save
 * (an agent may be mid-turn in the same repo), so this one is EXPLICIT-save only
 * and resolves its grammar from the file extension.
 *
 * Contract:
 *  - `initialValue` seeds the doc ONCE per mount. The parent remounts (via `key`)
 *    when it wants a reseed — so a save/reload can't yank the caret mid-edit.
 *  - Every edit lifts through `onDirtyChange` (is it different from the seed?)
 *    and `getValue()` (pulled by the parent only when saving). Not a controlled
 *    component: round-tripping every keystroke through React state made long
 *    files stutter, and the caret-restore dance it needs exists only to undo the
 *    damage that design causes.
 *  - Cmd/Ctrl+S saves via `onSave` (also the toolbar button's handler).
 */
import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { EditorState, StateEffect, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, keymap, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentUnit, LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export interface FileSourceEditorHandle {
  /** Current editor text — pulled by the parent at save time. */
  getValue: () => string;
  focus: () => void;
  /**
   * Re-baseline "clean" at the CURRENT text — called by the parent after a
   * successful save INSTEAD of remounting. A remount would reseed the doc and
   * yank the caret/scroll to the top on every ⌘S; markClean keeps the instance
   * (and its undo history) alive while making dirty-tracking correct again.
   */
  markClean: () => void;
}

/** A completed mouse selection inside the editor (for the quote-to-ask pill). */
export interface EditorSelection {
  text: string;
  /** 1-based line of the selection start. */
  line: number;
  /** Viewport coordinates of the selection start (pill anchor). */
  x: number;
  y: number;
}

interface FileSourceEditorProps {
  /** Seed text. Only read on mount — see the contract note above. */
  initialValue: string;
  /** File path; its extension picks the syntax grammar. */
  path: string;
  /** Fired when the doc's dirtiness (differs from seed) changes. */
  onDirtyChange: (dirty: boolean) => void;
  /** Cmd/Ctrl+S. */
  onSave: () => void;
  /** Scroll this 1-based line into view (centered) on mount — deep links. */
  initialLine?: number;
  /**
   * Mouse selection reporting for the quote-to-ask pill. Called with the
   * selection on mouseup (line resolved from the CodeMirror doc, which the
   * old DOM `data-line` walk can't do here), and with null when the
   * selection collapses or the doc changes (typing replaces the selection).
   */
  onSelectText?: (sel: EditorSelection | null) => void;
}

/**
 * Chrome matched to the read-only `<pre class="file-viewer-code">` it replaces,
 * so toggling Edit doesn't visually jump: same mono font, same line height, same
 * transparent background inside the pane. Height 100% + internal .cm-scroller so
 * it fills the preview pane and scrolls itself.
 */
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    fontSize: '12.5px',
    color: 'var(--fg)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace)",
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '8px 0 120px', caretColor: 'var(--fg)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--fg-muted)',
    opacity: '0.65',
  },
  '.cm-activeLine': { backgroundColor: 'var(--bg-hover, rgba(127, 127, 127, 0.06))' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg)' },
  '.cm-cursor': { borderLeftColor: 'var(--fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--accent-soft, rgba(80, 140, 255, 0.25))',
  },
});

export const FileSourceEditor = forwardRef<FileSourceEditorHandle, FileSourceEditorProps>(
  function FileSourceEditor({ initialValue, path, onDirtyChange, onSave, initialLine, onSelectText }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Latest-callback refs: the listeners live inside a once-created view and must
    // read the CURRENT callbacks, not the mount-time closures.
    const onDirtyChangeRef = useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const onSelectTextRef = useRef(onSelectText);
    onSelectTextRef.current = onSelectText;
    // Seed + last-reported dirtiness, both mount-scoped (the parent remounts to reseed).
    const seedRef = useRef(initialValue);
    const dirtyRef = useRef(false);

    useImperativeHandle(ref, () => ({
      getValue: () => viewRef.current?.state.doc.toString() ?? seedRef.current,
      focus: () => viewRef.current?.focus(),
      markClean: () => {
        seedRef.current = viewRef.current?.state.doc.toString() ?? seedRef.current;
        if (dirtyRef.current) {
          dirtyRef.current = false;
          onDirtyChangeRef.current(false);
        }
      },
    }), []);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const extensions: Extension[] = [
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        history(),
        // indentWithTab last: it must not shadow the defaults' Tab handling for
        // completion/escape, and Cmd/Ctrl+S is bound ahead of everything so the
        // browser's own Save dialog never opens over the app.
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { onSaveRef.current(); return true; },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        indentUnit.of('  '),
        editorTheme,
        EditorView.updateListener.of((u) => {
          // Any doc change or selection collapse retracts a reported selection —
          // the pill must not float over text that no longer matches it.
          if (onSelectTextRef.current && (u.docChanged || (u.selectionSet && u.state.selection.main.empty))) {
            onSelectTextRef.current(null);
          }
          if (!u.docChanged) return;
          const dirty = u.state.doc.toString() !== seedRef.current;
          // Fire only on TRANSITIONS — a per-keystroke setState in the parent
          // would re-render the whole preview pane on every character.
          if (dirty !== dirtyRef.current) {
            dirtyRef.current = dirty;
            onDirtyChangeRef.current(dirty);
          }
        }),
        // Quote-to-ask: report a completed mouse selection with its 1-based
        // line. DOM-level handler (not a CM extension) so the browser's own
        // selection has settled by the time we read state.
        EditorView.domEventHandlers({
          mouseup: (_e, view) => {
            const cb = onSelectTextRef.current;
            if (!cb) return false;
            const range = view.state.selection.main;
            if (range.empty) { cb(null); return false; }
            const text = view.state.sliceDoc(range.from, range.to).trim();
            if (!text) { cb(null); return false; }
            const line = view.state.doc.lineAt(range.from).number;
            const coords = view.coordsAtPos(range.from);
            if (!coords) { cb(null); return false; }
            cb({ text, line, x: coords.left, y: coords.top });
            return false;
          },
        }),
      ];

      const view = new EditorView({
        state: EditorState.create({ doc: seedRef.current, extensions }),
        parent: host,
      });
      viewRef.current = view;
      // NO auto-focus: the editor now mounts as the default view of every
      // readable file (Files pane, "@" mention preview) — stealing focus there
      // would yank the caret out of the chat input the user is typing in.
      // Deep-link line: scroll it into view centered, like the read view did.
      // Next frame — the view hasn't measured line heights at construction.
      let lineRaf = 0;
      if (initialLine && initialLine > 0 && initialLine <= view.state.doc.lines) {
        const pos = view.state.doc.line(initialLine).from;
        lineRaf = requestAnimationFrame(() => {
          if (viewRef.current === view) {
            view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
          }
        });
      }

      // Grammar loads ASYNC (language-data code-splits each grammar), so it is
      // appended after mount rather than blocking first paint. An unknown
      // extension simply stays plain text — never an error.
      let cancelled = false;
      const desc = LanguageDescription.matchFilename(languages, path.split('/').pop() ?? path);
      if (desc) {
        void desc.load().then((support) => {
          if (cancelled || viewRef.current !== view) return;
          // appendConfig is CodeMirror's supported way to install an extension
          // that wasn't known at EditorState.create time (there is no "add
          // extension" API), which is what a lazily-loaded grammar needs.
          view.dispatch({ effects: StateEffect.appendConfig.of(support.extension) });
        }).catch(() => { /* grammar unavailable — plain text is fine */ });
      }

      return () => {
        cancelled = true;
        cancelAnimationFrame(lineRaf);
        view.destroy();
        viewRef.current = null;
      };
      // Mount-scoped by design: the parent remounts (key=path+reload) to reseed.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return <div ref={hostRef} className="fv-source-editor" />;
  },
);
