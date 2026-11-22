/**
 * Empty, loading and unavailable states drawn outside the one shared component
 * (web/src/components/common/EmptyState.tsx), counted per file. Used by empty-state-ratchet.test.ts.
 *
 * 2026-11-21 UI audit: 124 hand-made empty classes (11 to 15 px, centred or left, 0 to 48 px of
 * padding) and 107 bare "No ..." lines in 94 files; a session with no history showed one grey
 * "No conversation history found" in a huge white pane that did not say whether it was new,
 * lost or still loading.
 *
 * Two counters:
 *  - ownEmptyClass: a CSS rule whose subject is an empty/loading/unavailable class of its own
 *    (`.todo-empty-board`, `.mail-reader-empty`, `.x-loading-line`) and gives it a look (type,
 *    colour, padding, alignment). Modifiers on another component (`.chat-input.is-empty`) and the
 *    `:empty` pseudo-class are not states and do not count.
 *  - bareEmptyText: TSX that writes an empty or loading line as bare text (`<p>No tasks</p>`,
 *    `{list.length ? ... : 'Nothing here'}`, `>Loading…<`) or a word-less `<LoadingSpinner />`,
 *    instead of `<EmptyState title="..." />`, or a failure that shows its raw error as the hint
 *    (`<UnavailableState hint={error} />`: the error goes in `detail`). A line that is not a state (an option labelled
 *    "No limit") carries `empty-state-ok` in a comment on that line.
 */
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss, type Decl } from './css-scan';

export const WEB_SRC = path.join(__dirname, '../../web/src');
/** The component's own stylesheet: the one look. */
export const HOME_CSS = 'components/common/empty-state.css';
export const HOME_TSX = 'components/common/EmptyState.tsx';

/** A class that names a state of "nothing to show". */
export const STATE_CLASS = /(?:^|-)(?:empty|nothing|no-results|noresults|none|unavailable|placeholder-state)(?:-|$)|(?:^|-)loading(?:-(?:state|line|row|text|msg|message|hint|note|wrap|box|pane|placeholder))?$/i;
/** Properties that give a state its own look. */
const LOOK = /^(font-size|font-weight|color|padding|padding-inline|padding-block|padding-top|padding-bottom|padding-left|padding-right|text-align|line-height|font-style)$/;

const classesOf = (compound: string) => [...compound.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);

function subject(selector: string): string {
  const bare = selector.replace(/::?[A-Za-z-]+(\((?:[^()]|\([^()]*\))*\))?/g, '').replace(/\[[^\]]*\]/g, '');
  const parts = bare.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** `.todo-empty-board` or `.panel .mail-empty-title`: the subject's first class is a state of its own. */
export function isOwnEmptyClass(selector: string): boolean {
  const first = classesOf(subject(selector))[0];
  return !!first && STATE_CLASS.test(first);
}

/** A line of TSX that writes a state's words by hand. */
const BARE_TEXT: RegExp[] = [
  // JSX text: >No tasks<, >Nothing here yet.<, >Loading…<
  />\s*(?:No|Nothing)\s+[A-Za-z][^<{}]*/,
  />\s*Loading\b[^<{}]*/,
  // A string chosen inside JSX: {x ? 'No tasks' : null}, {!n && 'Nothing yet'}, : `No ${kind}`
  /(?:\?|:|&&|\|\|)\s*\(?\s*['"`](?:No|Nothing)\s+[A-Za-z][^'"`]*['"`]/,
  /(?:\?|:|&&|\|\|)\s*\(?\s*['"`]Loading\b[^'"`]*['"`]/,
  // Another component's label: <SettingsRow label="No secret yet" />
  /\blabel=\{?\s*['"`](?:No|Nothing)\s+[A-Za-z]/,
  // A string written as JSX: {'No tasks'}, {`Loading ${what}`}
  /\{\s*['"`](?:No|Nothing)\s+[A-Za-z]/,
  /\{\s*['"`]Loading\b/,
  // JSX text on a line of its own (no code on it): `  No tasks match this filter`
  /^\s*(?:No|Nothing)\s+[a-z][^{}<>=;()'"`]*$/,
  // A spinner with no words.
  /<LoadingSpinner\b/,
];

/** Lines of one TSX source that write a state by hand. Exported for the self-test. */
export function bareEmptyLines(text: string): number[] {
  const out: number[] = [];
  text.split('\n').forEach((line, i) => {
    if (/empty-state-ok/.test(line)) return;
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    // Words handed to the component (title=, hint=, an action's label:) are the component's. A
    // `label="No secret yet"` on another component (a settings row) is a state drawn by hand.
    // A failure whose hint is the raw error (`hint={error}`): the error goes in `detail`, which
    // shows it when it reads as a plain sentence and folds it behind "Details" otherwise.
    if (/<UnavailableState\b[^\n]*\bhint=\{[A-Za-z_][\w.]*\}/.test(line)) { out.push(i + 1); return; }
    const scrubbed = line.replace(/\bstateWords\([^)]*\)/g, '').replace(/\b(?:title|hint|aria-label|placeholder|tooltip)=\{[^}]*\}/g, '').replace(/\b(?:title|hint|aria-label|placeholder)=["'][^"']*["']/g, '').replace(/\b(?:title|hint|label):\s*(['"`])[^'"`]*\1/g, '');
    if (BARE_TEXT.some((re) => re.test(scrubbed))) out.push(i + 1);
  });
  return out;
}

export interface EmptyCounts { ownEmptyClass: Record<string, number>; bareEmptyText: Record<string, number> }

export function countEmpty(): EmptyCounts {
  const out: EmptyCounts = { ownEmptyClass: {}, bareEmptyText: {} };
  for (const file of walk(WEB_SRC, ['.css']).sort()) {
    const rel = path.relative(WEB_SRC, file);
    if (rel === HOME_CSS) continue;
    const rules = new Map<string, Decl[]>();
    for (const d of scanCss(rel, fs.readFileSync(file, 'utf8'))) {
      const key = d.selectors.join(', ');
      rules.set(key, [...(rules.get(key) ?? []), d]);
    }
    let n = 0;
    for (const [, decls] of rules) {
      if (decls.some((d) => LOOK.test(d.prop)) && decls[0].selectors.some(isOwnEmptyClass)) n++;
    }
    if (n) out.ownEmptyClass[rel] = n;
  }
  for (const file of walk(WEB_SRC, ['.tsx']).sort()) {
    const rel = path.relative(WEB_SRC, file);
    if (rel === HOME_TSX || /\.test\.tsx$/.test(rel)) continue;
    const n = bareEmptyLines(fs.readFileSync(file, 'utf8')).length;
    if (n) out.bareEmptyText[rel] = n;
  }
  return out;
}
