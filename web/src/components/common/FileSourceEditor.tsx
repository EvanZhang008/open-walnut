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
import { highlightSelectionMatches } from '@codemirror/search';
import {
  cmSearchExtension, cmUpdateSearch, cmNavSearch, cmCloseSearch,
  cmFlashExtension, cmFlashTerm, type CmSearchStatus,
} from '@/utils/cm-search';
import { SYMBOL_RE } from '@/utils/dom-text-search';
import { log } from '@/utils/log';

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
  /**
   * Replace the WHOLE document in place — Live Edit's merge/pull path.
   *
   * Deliberately not a remount: the parent's remount key is what reseeds an
   * editor, and reseeding while the user is typing yanks the caret to line 1.
   * `getValue()` returns the new text immediately after this call, and the
   * caller (not this editor) decides whether the result counts as clean.
   */
  setValue: (text: string) => void;
  /** Scroll a 1-based line into view (centered) — reference-jump target.
   *  `term` flashes the landed-on keyword so the eye finds it instantly.
   *  Optional: the WYSIWYG editor shares this handle type and has no lines. */
  scrollToLine?: (line: number, term?: string) => void;
  /** In-file search (the shared FileSearchBar drives these; CM surface only). */
  searchUpdate?: (query: string, caseSensitive: boolean) => CmSearchStatus;
  searchNav?: (dir: 1 | -1) => CmSearchStatus;
  searchClose?: () => void;
}

/** A completed mouse selection inside the editor (for the quote-to-ask pill). */
export interface EditorSelection {
  text: string;
  /** 1-based line of the selection start. */
  line: number;
  /** Viewport coordinates of the POINTER at mouseup (pill anchor). */
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
  /**
   * Fired on EVERY doc change, unlike the transition-only onDirtyChange. The
   * parent's debounced draft writer needs each keystroke, not just the moment
   * the file became dirty — including edits made back TOWARDS the seed, which
   * are what let it delete a draft that no longer differs from disk.
   */
  onDocChange?: () => void;
  /** Cmd/Ctrl+S. */
  onSave: () => void;
  /** Scroll this 1-based line into view (centered) on mount — deep links. */
  initialLine?: number;
  /** Flash this term on initialLine after mount (reference-jump landing).
   *  Lives HERE, not only on the imperative handle: a cross-file jump mounts a
   *  fresh editor, and a flash dispatched at any earlier instance dies with it. */
  initialFlashTerm?: string;
  /**
   * Mouse selection reporting for the quote-to-ask pill. Called with the
   * selection on mouseup (line resolved from the CodeMirror doc, which the
   * old DOM `data-line` walk can't do here), and with null when the
   * selection collapses or the doc changes (typing replaces the selection).
   */
  onSelectText?: (sel: EditorSelection | null) => void;
  /** Cmd/Ctrl+click on an identifier → reference lookup. 1-based line. */
  onSymbolClick?: (symbol: string, line: number) => void;
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
  function FileSourceEditor({ initialValue, path, onDirtyChange, onDocChange, onSave, initialLine, initialFlashTerm, onSelectText, onSymbolClick }, ref) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Latest-callback refs: the listeners live inside a once-created view and must
    // read the CURRENT callbacks, not the mount-time closures.
    const onDirtyChangeRef = useRef(onDirtyChange);
    onDirtyChangeRef.current = onDirtyChange;
    const onDocChangeRef = useRef(onDocChange);
    onDocChangeRef.current = onDocChange;
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    const onSelectTextRef = useRef(onSelectText);
    onSelectTextRef.current = onSelectText;
    const onSymbolClickRef = useRef(onSymbolClick);
    onSymbolClickRef.current = onSymbolClick;
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
      setValue: (text: string) => {
        const view = viewRef.current;
        // No view yet ⇒ the seed IS the document; move it so the mount uses it.
        if (!view) { seedRef.current = text; return; }
        const doc = view.state.doc;
        if (doc.toString() === text) return;
        const sel = view.state.selection.main;
        view.dispatch({
          changes: { from: 0, to: doc.length, insert: text },
          // The selection is CLAMPED, not mapped: a whole-document replacement
          // maps every position to the end of the change, so mapping would park
          // the caret at EOF on every merge. Clamping the original offsets keeps
          // it where the user was typing (the merged text is mostly the same
          // lines, so the offset is still close to the right place).
          selection: { anchor: Math.min(sel.anchor, text.length), head: Math.min(sel.head, text.length) },
        });
      },
      scrollToLine: (line: number, term?: string) => {
        const view = viewRef.current;
        if (!view || line < 1 || line > view.state.doc.lines) return;
        view.dispatch({
          effects: EditorView.scrollIntoView(view.state.doc.line(line).from, { y: 'center' }),
        });
        cmFlashTerm(view, line, term);
      },
      searchUpdate: (query, caseSensitive) =>
        viewRef.current ? cmUpdateSearch(viewRef.current, query, caseSensitive) : { count: 0, index: 0 },
      searchNav: (dir) =>
        viewRef.current ? cmNavSearch(viewRef.current, dir) : { count: 0, index: 0 },
      searchClose: () => { if (viewRef.current) cmCloseSearch(viewRef.current); },
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
        // Select a word → every exact match lights up (VS Code behavior).
        // minSelectionLength keeps a 1-2 char selection from confetti-ing the file.
        highlightSelectionMatches({ minSelectionLength: 3, maxMatches: 2000 }),
        cmSearchExtension(),
        cmFlashExtension(),
        editorTheme,
        EditorView.updateListener.of((u) => {
          // Any doc change or selection collapse retracts a reported selection —
          // the pill must not float over text that no longer matches it.
          if (onSelectTextRef.current && (u.docChanged || (u.selectionSet && u.state.selection.main.empty))) {
            onSelectTextRef.current(null);
          }
          if (!u.docChanged) return;
          onDocChangeRef.current?.();
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
          mouseup: (e, view) => {
            const cb = onSelectTextRef.current;
            if (!cb) return false;
            const range = view.state.selection.main;
            if (range.empty) { cb(null); return false; }
            const text = view.state.sliceDoc(range.from, range.to).trim();
            if (!text) { cb(null); return false; }
            const line = view.state.doc.lineAt(range.from).number;
            // Anchor = the pointer at release — the pill hugs the cursor
            // (drag down → below the selection, drag up → above; the side is
            // decided by SelectionAskPill from this point).
            cb({ text, line, x: e.clientX, y: e.clientY });
            return false;
          },
          // Cmd/Ctrl+click on an identifier → reference lookup (VS Code jump).
          // mousedown (not click): returning true here stops CM's own handling,
          // so the caret doesn't move out from under the reader.
          mousedown: (e, view) => {
            const cb = onSymbolClickRef.current;
            if (!cb || !(e.metaKey || e.ctrlKey) || e.button !== 0) return false;
            const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos == null) return false;
            const lineObj = view.state.doc.lineAt(pos);
            const text = lineObj.text;
            const col = pos - lineObj.from;
            const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch);
            let start = col;
            let end = col;
            // Caret may land just right of the glyph — step back onto the word.
            if (!isWord(text[start] ?? '') && start > 0 && isWord(text[start - 1]!)) { start -= 1; end -= 1; }
            if (!isWord(text[start] ?? '')) return false;
            while (start > 0 && isWord(text[start - 1]!)) start -= 1;
            while (end < text.length && isWord(text[end]!)) end += 1;
            const word = text.slice(start, end);
            if (!SYMBOL_RE.test(word)) return false;
            e.preventDefault();
            cb(word, lineObj.number);
            return true;
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
            // Landing cue for reference jumps: flash the jumped-to term (or
            // line). Runs on THIS instance, so a remount can't strand it.
            cmFlashTerm(view, initialLine, initialFlashTerm);
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
        }).catch((err: unknown) => {
          // Plain text is an acceptable outcome, a SILENT one is not: the usual
          // cause is a chunk from a build the server has already replaced (a
          // deploy landed while this tab was open), which looked exactly like
          // "Walnut doesn't highlight Go". stale-assets.ts reloads on the same
          // signal; this line is how you tell the two apart in the log.
          log.warn('file-editor', 'syntax grammar failed to load — plain text', {
            path, language: desc.name, error: String((err as Error)?.message ?? err),
          });
        });
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
