/**
 * cm-search — in-file search for the CodeMirror surface, driven by Walnut's own
 * FileSearchBar (NOT @codemirror/search's built-in panel: its highlighter only
 * paints while its own panel is open, and we need one bar shared across every
 * render mode). Matches are computed with SearchCursor, decorated as
 * `.cm-searchMatch` / `.cm-searchMatch-selected` (same class names the stock
 * panel uses, so the CSS serves either).
 */
import { StateField, StateEffect, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { SearchCursor } from '@codemirror/search';

export interface CmSearchStatus { count: number; index: number }

const MAX_MATCHES = 5000;

interface SearchVal {
  query: string;
  caseSensitive: boolean;
  ranges: { from: number; to: number }[];
  active: number;
}

const setSearchEffect = StateEffect.define<{ query: string; caseSensitive: boolean } | null>();
const setActiveEffect = StateEffect.define<number>();

function computeRanges(doc: Text, query: string, caseSensitive: boolean): { from: number; to: number }[] {
  const norm = caseSensitive ? undefined : (s: string) => s.toLowerCase();
  const cursor = new SearchCursor(doc, query, 0, doc.length, norm);
  const out: { from: number; to: number }[] = [];
  while (out.length < MAX_MATCHES && !cursor.next().done) {
    out.push({ from: cursor.value.from, to: cursor.value.to });
  }
  return out;
}

const matchMark = Decoration.mark({ class: 'cm-searchMatch' });
const activeMark = Decoration.mark({ class: 'cm-searchMatch cm-searchMatch-selected' });

function buildDeco(v: SearchVal | null): DecorationSet {
  if (!v || !v.ranges.length) return Decoration.none;
  return Decoration.set(v.ranges.map((r, i) => (i === v.active ? activeMark : matchMark).range(r.from, r.to)));
}

const searchField = StateField.define<SearchVal | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSearchEffect)) {
        if (!e.value?.query) return null;
        const ranges = computeRanges(tr.newDoc, e.value.query, e.value.caseSensitive);
        return { ...e.value, ranges, active: ranges.length ? 0 : -1 };
      }
      if (e.is(setActiveEffect) && value) return { ...value, active: e.value };
    }
    // Live edits while the bar is open: recompute so highlights track the doc.
    if (value && tr.docChanged) {
      const ranges = computeRanges(tr.newDoc, value.query, value.caseSensitive);
      return { ...value, ranges, active: ranges.length ? Math.max(0, Math.min(value.active, ranges.length - 1)) : -1 };
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, buildDeco),
});

export function cmSearchExtension(): Extension {
  return searchField;
}

function statusOf(v: SearchVal | null): CmSearchStatus {
  if (!v) return { count: 0, index: 0 };
  return { count: v.ranges.length, index: v.active + 1 };
}

/** Set/replace the query. Scrolls the first match into view.
 *  `view.state` right after `dispatch` IS the post-effect state (CodeMirror
 *  applies transactions synchronously) — do not "fix" this into an async read. */
export function cmUpdateSearch(view: EditorView, query: string, caseSensitive: boolean): CmSearchStatus {
  view.dispatch({ effects: setSearchEffect.of(query ? { query, caseSensitive } : null) });
  const v = view.state.field(searchField);
  if (v && v.active >= 0) {
    view.dispatch({ effects: EditorView.scrollIntoView(v.ranges[v.active]!.from, { y: 'center' }) });
  }
  return statusOf(v);
}

/** Step to the next/previous match (wraps). */
export function cmNavSearch(view: EditorView, dir: 1 | -1): CmSearchStatus {
  const v = view.state.field(searchField);
  if (!v || !v.ranges.length) return { count: 0, index: 0 };
  const next = (v.active + dir + v.ranges.length) % v.ranges.length;
  view.dispatch({
    effects: [setActiveEffect.of(next), EditorView.scrollIntoView(v.ranges[next]!.from, { y: 'center' })],
  });
  return { count: v.ranges.length, index: next + 1 };
}

export function cmCloseSearch(view: EditorView): void {
  view.dispatch({ effects: setSearchEffect.of(null) });
}

// ── Jump flash — highlight the TERM you jumped to (go-to-definition landing) ──

const flashEffect = StateEffect.define<{ from: number; to: number } | null>();

const flashMark = Decoration.mark({ class: 'cm-jump-flash' });

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        return e.value ? Decoration.set([flashMark.range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    // Any edit invalidates the flash — don't try to map it across changes.
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function cmFlashExtension() {
  return flashField;
}

/**
 * Briefly highlight `term` on a 1-based line (the whole line when the term
 * isn't found there) — the "you landed HERE" cue after a reference jump.
 */
export function cmFlashTerm(view: EditorView, lineNum: number, term?: string): void {
  if (lineNum < 1 || lineNum > view.state.doc.lines) return;
  const lineObj = view.state.doc.line(lineNum);
  let from = lineObj.from;
  let to = lineObj.to;
  if (term) {
    const idx = lineObj.text.indexOf(term);
    if (idx >= 0) { from = lineObj.from + idx; to = from + term.length; }
  }
  if (from >= to) return;
  view.dispatch({ effects: flashEffect.of({ from, to }) });
  setTimeout(() => {
    try { view.dispatch({ effects: flashEffect.of(null) }); } catch { /* view destroyed */ }
  }, 2400);
}
