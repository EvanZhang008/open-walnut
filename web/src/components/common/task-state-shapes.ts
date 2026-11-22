/**
 * The seven shapes of a task's status icon, on a 16x16 grid: the ONE source both ways a status mark is
 * drawn. TaskStateIcon (TaskStateIcon.tsx) draws them inline as SVG; the marks CSS draws before text it
 * does not render (a task pill in a message, the Brief's headings: styles/task-state.css) are the same
 * shapes as masks, installed once as `--tsi-mask-<state>` (installTaskStateMasks). There is no second,
 * smaller vocabulary of dots and rings (2026-11-22, a review on the user's data: the Org rail drew a
 * Waiting task as a thin grey ring where its Tasks panel drew the clock).
 *
 * `body` is painted in the state's colour; `cut` is cut out of it (To read's lines, Completed's tick), a
 * real hole, so whatever is behind the row shows through; `mark` is painted on it in --on-accent inline
 * (Needs you's "!") and cut out in the mask form, which has one colour. Working's breathing centre is no
 * SVG part inline (TaskStateIcon stacks it over the ring, so its fade composites); the mask form has it.
 */
import { createElement, type ReactNode } from 'react';
import type { TaskIconState } from '@/utils/task-icon-state';

/** One SVG element: its tag, its attributes in React's names (strokeWidth), its children. */
type SvgNode = readonly [tag: string, attrs: Readonly<Record<string, string>>, children?: readonly SvgNode[]];
interface StateShape { body: readonly SvgNode[]; cut?: readonly SvgNode[]; mark?: readonly SvgNode[] }

const ROUND = { strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const ring = (r: string, w: string, extra: Record<string, string> = {}): SvgNode =>
  ['circle', { cx: '8', cy: '8', r, fill: 'none', stroke: 'currentColor', strokeWidth: w, ...extra }];
const disc = (r: string): SvgNode => ['circle', { cx: '8', cy: '8', r, fill: 'currentColor' }];

export const TASK_STATE_SHAPES: Record<TaskIconState, StateShape> = {
  needs: {
    body: [disc('7')],
    mark: [['rect', { x: '7.1', y: '3.6', width: '1.8', height: '5.6', rx: '.9' }], ['circle', { cx: '8', cy: '11.6', r: '1.05' }]],
  },
  read: {
    body: [['path', { d: 'M4 1.8h5.4L12.6 5v8.4a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V2.6a.8.8 0 0 1 .8-.8Z', fill: 'currentColor' }]],
    cut: [['path', { d: 'M5.6 7.4h4.8M5.6 10h4.8', fill: 'none', strokeWidth: '1.4', strokeLinecap: 'round' }]],
  },
  working: { body: [ring('6.2', '2')] },
  waiting: {
    body: [ring('6.3', '1.6'), ['path', { d: 'M8 4.6V8l2.4 1.6', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', ...ROUND }]],
  },
  snoozed: { body: [['path', { d: 'M10.9 2.2A6.2 6.2 0 1 0 13.8 10.4 5 5 0 0 1 10.9 2.2Z', fill: 'none', stroke: 'currentColor', strokeWidth: '1.6', strokeLinejoin: 'round' }]] },
  todo: { body: [ring('6.3', '1.6', { strokeDasharray: '2.6 2.4' })] },
  done: {
    body: [disc('7')],
    cut: [['path', { d: 'M4.8 8.2l2.2 2.2 4.2-4.6', fill: 'none', strokeWidth: '1.8', ...ROUND }]],
  },
};

/**
 * One icon's elements. `cut`: its own mask id (a list draws many icons, and a mask id shared between
 * them would cut through the first one's only). `oneColour`: the mask form, where the mark is a hole
 * too and Working's centre is drawn.
 */
function iconNodes(state: TaskIconState, cut: string, oneColour: boolean): SvgNode[] {
  const s = TASK_STATE_SHAPES[state];
  const body = oneColour && state === 'working' ? [...s.body, disc('3.6')] : [...s.body];
  const holes = [...(s.cut ? [['g', { stroke: '#000' }, s.cut] as const] : []), ...(oneColour && s.mark ? [['g', { fill: '#000' }, s.mark] as const] : [])];
  const out: SvgNode[] = holes.length
    ? [
      ['mask', { id: cut, maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: '16', height: '16' }, [['rect', { width: '16', height: '16', fill: '#fff' }], ...holes]],
      ['g', { mask: `url(#${cut})` }, body],
    ]
    : body;
  return !oneColour && s.mark ? [...out, ['g', { className: 'tsi-mark' }, s.mark]] : out;
}

const toReact = ([tag, attrs, children = []]: SvgNode, key: number): ReactNode =>
  createElement(tag, { key, ...attrs }, ...children.map(toReact));

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const toSvg = ([tag, attrs, children = []]: SvgNode): string => {
  const a = Object.entries(attrs).map(([k, v]) => ` ${kebab(k)}="${v}"`).join('');
  return children.length ? `<${tag}${a}>${children.map(toSvg).join('')}</${tag}>` : `<${tag}${a}/>`;
};

/** The inline SVG's children (TaskStateIcon). */
export function shapeElements(state: TaskIconState, cut: string): ReactNode[] {
  return iconNodes(state, cut, false).map(toReact);
}

/** The shape as a standalone one-colour SVG, for a CSS mask: what is cut or marked is a hole. */
export function shapeMaskSvg(state: TaskIconState): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${iconNodes(state, 'c', true).map(toSvg).join('')}</svg>`;
}

/** Every state's mask as CSS custom properties on :root (`--tsi-mask-needs: url("data:...")`). */
export function taskStateMaskCss(): string {
  const props = (Object.keys(TASK_STATE_SHAPES) as TaskIconState[])
    .map((st) => `--tsi-mask-${st}: url("data:image/svg+xml,${encodeURIComponent(shapeMaskSvg(st))}");`);
  return `:root { ${props.join(' ')} }`;
}

/** Put the masks on the page once (main.tsx, before the first render). A style element of its own, so
 *  nothing that writes the root element's inline style can drop them. */
export function installTaskStateMasks(doc: Document = document): void {
  if (doc.getElementById('task-state-masks')) return;
  const el = doc.createElement('style');
  el.id = 'task-state-masks';
  el.textContent = taskStateMaskCss();
  doc.head.appendChild(el);
}
