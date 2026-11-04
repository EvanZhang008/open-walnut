/**
 * MathRender: typesets math in the notes editor with KaTeX, purely as decorations.
 *
 * The markdown on disk uses GitHub's two math forms, and both stay plain markdown
 * nodes in the document:
 *   - block: a fenced code block whose language is `math` (```math … ```),
 *   - inline: inline code with a `$` touching each side ($`e = mc^2`$).
 * A bare `$…$` is NOT math, so prose like "$5 and $10" stays text.
 *
 * Because nothing here changes the document, the saved bytes are exactly what was
 * loaded. While the selection is elsewhere, a formula's source is hidden and a
 * rendered widget shows in its place; once the selection touches it (a click on
 * the rendered formula puts the cursor there), the source shows and is edited as
 * usual. A math block keeps its rendered preview under the source while editing.
 *
 * KaTeX is loaded lazily (math-katex.ts) the first time a formula appears, so
 * notes without math and the rest of the app never fetch it.
 */

import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { loadMath, mathStatus, renderMath, shouldLoadMath, type MathStatus } from './math-katex';
import './math-render.css';

export interface MathRange {
  display: boolean;
  /** Start of the whole source: the code block node, or the opening `$`. */
  from: number;
  /** End of the whole source: after the code block node, or after the closing `$`. */
  to: number;
  latex: string;
}

function isCodeText(node: PMNode | undefined): boolean {
  return !!node && node.isText && node.marks.some((m) => m.type.name === 'code');
}

function isPlainText(node: PMNode | undefined): node is PMNode {
  return !!node && node.isText && !isCodeText(node);
}

/** Every formula in the doc, in document order. */
export function findMath(doc: PMNode): MathRange[] {
  const out: MathRange[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') {
      if (String(node.attrs.language ?? '').trim().toLowerCase() === 'math') {
        out.push({ display: true, from: pos, to: pos + node.nodeSize, latex: node.textContent });
      }
      return false;
    }
    if (!node.isTextblock) return true;
    const kids: { node: PMNode; pos: number }[] = [];
    node.forEach((child, offset) => kids.push({ node: child, pos: pos + 1 + offset }));
    let lastTo = -1;
    for (let i = 0; i < kids.length; i++) {
      if (!isCodeText(kids[i].node)) continue;
      // One code run can span several text nodes (another mark changes inside it).
      let j = i;
      while (j + 1 < kids.length && isCodeText(kids[j + 1].node)) j++;
      const prev = kids[i - 1];
      const next = kids[j + 1];
      if (isPlainText(prev?.node) && isPlainText(next?.node) && prev.node.text!.endsWith('$') && next.node.text!.startsWith('$')) {
        const from = prev.pos + prev.node.nodeSize - 1;
        const to = next.pos + 1;
        const latex = kids.slice(i, j + 1).map((k) => k.node.text).join('');
        // `$` can close one formula or open the next, not both.
        if (from >= lastTo && latex.trim()) {
          out.push({ display: false, from, to, latex });
          lastTo = to;
        }
      }
      i = j;
    }
    return false;
  });
  return out;
}

const HIDDEN = 'notes-math-source-hidden';

/** Fill a widget element with the formula, or its source while KaTeX is not ready. */
function paint(el: HTMLElement, latex: string, display: boolean, status: MathStatus) {
  if (status !== 'ready') {
    el.textContent = latex;
    el.classList.add(status === 'failed' ? 'notes-math-error' : 'notes-math-pending');
    if (status === 'failed') el.title = 'Math renderer failed to load';
    return;
  }
  const { html, error } = renderMath(latex, display);
  el.innerHTML = html;
  if (error) {
    el.classList.add('notes-math-error');
    el.title = error;
  }
}

function widget(range: MathRange, editing: boolean, status: MathStatus): Decoration {
  const { display, latex } = range;
  const span = range.to - range.from;
  return Decoration.widget(
    display ? range.to : range.from,
    (view: EditorView, getPos: () => number | undefined) => {
      const el: HTMLElement = document.createElement(display ? 'div' : 'span');
      el.className = display ? 'notes-math-block' : 'notes-math-inline';
      if (editing) el.classList.add('is-editing');
      el.contentEditable = 'false';
      el.setAttribute('data-math', display ? 'block' : 'inline');
      paint(el, latex, display, status);
      // A click on the rendered formula edits its source: the cursor goes to the end
      // of the latex (inside the block, or before the closing `$`).
      el.addEventListener('mousedown', (event: MouseEvent) => {
        if (event.button !== 0 || !view.editable) return;
        event.preventDefault();
        const at = getPos();
        if (at == null) return;
        const target = display ? at - 1 : at + span - 1;
        const { doc } = view.state;
        if (target < 0 || target > doc.content.size) return;
        view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, target)).scrollIntoView());
        view.focus();
      });
      return el;
    },
    {
      side: -1,
      // Same key, same DOM: a selection move elsewhere does not re-render the formula.
      key: `math:${display ? 'b' : 'i'}:${status}:${editing ? 1 : 0}:${latex}`,
      ignoreSelection: true,
      stopEvent: () => true,
    },
  );
}

/**
 * Decorations for every formula: rendered widget always for a block (under its source
 * while editing), and for inline math only while the selection is elsewhere; the source
 * is hidden while the selection is elsewhere. `selection` is undefined while the editor
 * is not focused or not editable, so every formula renders then.
 */
export function buildMathDecorations(
  doc: PMNode,
  selection: { from: number; to: number } | undefined,
  status: MathStatus,
  ranges: MathRange[] = findMath(doc),
): DecorationSet {
  const decos: Decoration[] = [];
  for (const r of ranges) {
    if (r.display) {
      // Strictly inside: a selection that only ends at the block's edge (a node selected
      // just before it) is not editing it.
      const editing = !!selection && selection.from < r.to && selection.to > r.from;
      if (!editing) decos.push(Decoration.node(r.from, r.to, { class: HIDDEN }));
      decos.push(widget(r, editing, status));
    } else {
      // A cursor right at either `$` counts, so the source shows as the caret reaches it.
      const editing = !!selection && selection.from <= r.to && selection.to >= r.from;
      if (!editing) {
        decos.push(Decoration.inline(r.from, r.to, { class: HIDDEN }));
        decos.push(widget(r, false, status));
      }
    }
  }
  return DecorationSet.create(doc, decos);
}

interface MathPluginState {
  decorations: DecorationSet;
  ranges: MathRange[];
  /** Focused, editable and acted in: only then does the selection open a formula's source. */
  active: boolean;
}

interface MathMeta {
  /** KaTeX finished loading (or failed): repaint. */
  repaint?: boolean;
  /** The editor gained or lost focus, or became editable or read-only. */
  active?: boolean;
}

const MATH_RENDER_KEY = new PluginKey<MathPluginState>('mathRender');

function computeState(doc: PMNode, selection: { from: number; to: number }, active: boolean, ranges = findMath(doc)): MathPluginState {
  return {
    decorations: buildMathDecorations(doc, active ? selection : undefined, mathStatus(), ranges),
    ranges,
    active,
  };
}

/**
 * The math code block a vertical or horizontal arrow would skip over: its source is hidden
 * (display: none), so the browser's caret jumps past it. Returns the position to put the
 * caret at inside it, or null.
 */
function hiddenBlockAcross(view: EditorView, dir: 'up' | 'down' | 'left' | 'right'): number | null {
  const { selection, doc } = view.state;
  if (!selection.empty || !view.endOfTextblock(dir)) return null;
  const $head = selection.$head;
  if ($head.depth < 1) return null;
  const forward = dir === 'down' || dir === 'right';
  const edge = forward ? $head.after() : $head.before();
  const $edge = doc.resolve(edge);
  const node = forward ? $edge.nodeAfter : $edge.nodeBefore;
  if (!node || node.type.name !== 'codeBlock') return null;
  if (String(node.attrs.language ?? '').trim().toLowerCase() !== 'math') return null;
  return forward ? edge + 1 : edge - 1;
}

const ARROWS: Record<string, 'up' | 'down' | 'left' | 'right'> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

export const MathRender = Extension.create({
  name: 'mathRender',

  addProseMirrorPlugins() {
    return [
      new Plugin<MathPluginState>({
        key: MATH_RENDER_KEY,
        state: {
          init: (_config, state) => computeState(state.doc, state.selection, false),
          apply: (tr, old, _before, after) => {
            const meta = tr.getMeta(MATH_RENDER_KEY) as MathMeta | undefined;
            const active = meta?.active ?? old.active;
            if (tr.docChanged) return computeState(after.doc, after.selection, active);
            if (tr.selectionSet || meta) return computeState(after.doc, after.selection, active, old.ranges);
            return old;
          },
        },
        props: {
          decorations(state) {
            return MATH_RENDER_KEY.getState(state)?.decorations;
          },
          handleKeyDown(view, event) {
            const dir = ARROWS[event.key];
            if (!dir || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey || !view.editable) return false;
            const target = hiddenBlockAcross(view, dir);
            if (target == null) return false;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)).scrollIntoView());
            return true;
          },
        },
        view(view) {
          // A focused editor opens the source under the caret only once the user acts in it:
          // autofocus parks the caret at the start, which may be inside a math block, and the
          // note should still open rendered.
          let interacted = false;
          const setActive = (v: EditorView) => {
            const active = interacted && v.editable && v.hasFocus();
            if (MATH_RENDER_KEY.getState(v.state)?.active === active) return;
            v.dispatch(v.state.tr.setMeta(MATH_RENDER_KEY, { active } satisfies MathMeta).setMeta('addToHistory', false));
          };
          const onFocusChange = (event?: Event) => {
            if (view.isDestroyed) return;
            if (event?.type === 'blur') interacted = false;
            setActive(view);
          };
          const onInteract = () => {
            if (interacted) return;
            interacted = true;
            onFocusChange();
          };
          view.dom.addEventListener('focus', onFocusChange);
          view.dom.addEventListener('blur', onFocusChange);
          // Capture, so this runs before ProseMirror (and a formula widget) handles the event.
          view.dom.addEventListener('mousedown', onInteract, true);
          view.dom.addEventListener('touchstart', onInteract, { capture: true, passive: true });
          view.dom.addEventListener('keydown', onInteract, true);

          // Load KaTeX the first time this editor holds math, then repaint once.
          let waiting = false;
          const ensureLoaded = () => {
            if (waiting || !shouldLoadMath()) return;
            if (!MATH_RENDER_KEY.getState(view.state)?.ranges.length) return;
            waiting = true;
            void loadMath().then(() => {
              waiting = false;
              if (view.isDestroyed) return;
              view.dispatch(view.state.tr.setMeta(MATH_RENDER_KEY, { repaint: true } satisfies MathMeta).setMeta('addToHistory', false));
            });
          };
          ensureLoaded();
          return {
            update(v, prevState) {
              if (v.state.doc !== prevState.doc) ensureLoaded();
              // setEditable() does not fire focus or blur.
              setActive(v);
            },
            destroy() {
              view.dom.removeEventListener('focus', onFocusChange);
              view.dom.removeEventListener('blur', onFocusChange);
              view.dom.removeEventListener('mousedown', onInteract, true);
              view.dom.removeEventListener('touchstart', onInteract, true);
              view.dom.removeEventListener('keydown', onInteract, true);
            },
          };
        },
      }),
    ];
  },
});
