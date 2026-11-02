/**
 * The ::highlight paint rules of this document, installed only for the highlight
 * names that are registered (styles/highlights.css says why: Blink resolves a style
 * for every highlight name with a rule, on every element, on every style recalc, so
 * ~90 linked rules made each push and pop of a Question stack recalc style 3 to 5
 * times slower; C38, 2026-11-01).
 *
 * The rules are grouped by family (a hue's open, resolved and live marks; a paint
 * and its `-active` / `-flash` twin), so a mark that changes state never waits for
 * its next rule. `CSS.highlights.set` installs a family at once, in the same task,
 * so the first paint of a highlight always has its colours; a family nothing has
 * painted under for a minute leaves, so a name dropped and set again (a search per
 * key, a page swap) never rewrites the sheet.
 */
import highlightsCss from '@/styles/highlights.css?raw';

export interface HighlightRuleBlock {
  family: string;
  css: string;
}

/** The family a highlight name's rules belong to. */
export function highlightFamily(name: string): string {
  // thread-mark-<hue>, thread-mark-done-<hue>, thread-mark-live-<hue>; and every
  // thread-mark-<state>-neutral with thread-mark-neutral.
  const mark = /^thread-mark-(?:[a-z]+-)?(\d+|neutral)$/.exec(name);
  if (mark) return `thread-mark-${mark[1]}`;
  return name.replace(/-(?:active|flash|current|sent)$/, '');
}

const NAME_RE = /::highlight\(\s*([\w-]+)\s*\)/g;

/** The families a selector paints. */
function familiesOf(selector: string): string[] {
  const out = new Set<string>();
  for (const m of selector.matchAll(NAME_RE)) out.add(highlightFamily(m[1]!));
  return [...out];
}

/**
 * Split a sheet of ::highlight rules into one block per style rule, in order,
 * each tagged with its family. Handles comments, plain rules and one level of
 * @media around them (the shape highlights.css keeps). A rule that names no
 * highlight is reported under the family `''`, which the guard test refuses.
 */
export function splitHighlightRules(cssText: string): HighlightRuleBlock[] {
  const text = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: HighlightRuleBlock[] = [];
  let i = 0;
  const readRule = (from: number): { selector: string; body: string; end: number } | null => {
    const open = text.indexOf('{', from);
    if (open < 0) return null;
    const close = text.indexOf('}', open);
    if (close < 0) return null;
    return { selector: text.slice(from, open).trim(), body: text.slice(open + 1, close).trim(), end: close + 1 };
  };
  const push = (selector: string, body: string, media?: string) => {
    const rule = `${selector} { ${body} }`;
    const css = media ? `${media} { ${rule} }` : rule;
    const fams = familiesOf(selector);
    if (fams.length === 0) blocks.push({ family: '', css });
    for (const family of fams) blocks.push({ family, css });
  };
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (i >= text.length) break;
    if (text.startsWith('@media', i)) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const media = text.slice(i, open).trim();
      let j = open + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j]!)) j++;
        if (j >= text.length || text[j] === '}') { j++; break; }
        const r = readRule(j);
        if (!r) { j = text.length; break; }
        push(r.selector, r.body, media);
        j = r.end;
      }
      i = j;
      continue;
    }
    const r = readRule(i);
    if (!r) break;
    push(r.selector, r.body);
    i = r.end;
  }
  return blocks;
}

interface RegistryLike {
  set(name: string, value: unknown): unknown;
  delete(name: string): boolean;
  clear(): void;
  keys(): IterableIterator<string>;
}

export interface HighlightRuleGate {
  /** The families whose rules are installed now. */
  installed: () => ReadonlySet<string>;
  /** Drop the families nothing is registered under (normally on a short timer). */
  prune: () => void;
}

const INSTALLED = Symbol.for('walnut.highlightRules');
/**
 * How long a family keeps its rules after its last name went. Rewriting the sheet
 * restyles the whole document under the rules it then holds, so a family must not
 * leave and come back with every page of a Question stack (a page shows a few hues,
 * the main conversation all of them): with a 2 s delay the last pop of C38 paid
 * that restyle on top of its own, 76 ms instead of 56.
 */
export const PRUNE_DELAY_MS = 60_000;

/**
 * Wrap the set / delete / clear that `registry` answers to so the rules of every
 * registered family are in `style`, and a family nothing has painted under for
 * PRUNE_DELAY_MS leaves. `target` is the object the methods are replaced on: the
 * registry's prototype in a page (WebKit drops a platform object's JS wrapper
 * when no script holds it, and the next one it hands out has none of the first's
 * own properties, so a patch on the instance was lost: every highlight painted
 * nothing), the registry itself in a test. Idempotent per target.
 */
export function gateHighlightRules(
  registry: RegistryLike,
  style: { textContent: string | null },
  blocks: readonly HighlightRuleBlock[],
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  now: () => number = Date.now,
  target: object = registry,
): HighlightRuleGate {
  const tagged = target as RegistryLike & { [INSTALLED]?: HighlightRuleGate };
  if (tagged[INSTALLED]) return tagged[INSTALLED];
  const known = new Set(blocks.map((b) => b.family));
  const live = new Set<string>();
  /** Installed families with no registered name, since when. */
  const goneAt = new Map<string, number>();
  const render = () => {
    style.textContent = blocks.filter((b) => live.has(b.family)).map((b) => b.css).join('\n');
  };
  const registered = () => {
    const out = new Set<string>();
    for (const name of registry.keys()) out.add(highlightFamily(name));
    return out;
  };
  const ensure = (name: string) => {
    const family = highlightFamily(name);
    goneAt.delete(family);
    if (!known.has(family) || live.has(family)) return;
    live.add(family);
    render();
  };
  let pruneArmed = false;
  const arm = (ms: number) => {
    if (pruneArmed) return;
    pruneArmed = true;
    schedule(prune, ms);
  };
  function prune() {
    pruneArmed = false;
    const wanted = registered();
    const t = now();
    let changed = false;
    let next = Infinity;
    for (const [family, at] of [...goneAt]) {
      if (wanted.has(family)) { goneAt.delete(family); continue; }
      const left = at + PRUNE_DELAY_MS - t;
      if (left > 0) { next = Math.min(next, left); continue; }
      goneAt.delete(family);
      if (live.delete(family)) changed = true;
    }
    if (changed) render();
    if (next !== Infinity) arm(next);
  }
  const noteGone = () => {
    const wanted = registered();
    const t = now();
    for (const family of live) if (!wanted.has(family) && !goneAt.has(family)) goneAt.set(family, t);
    if (goneAt.size) arm(PRUNE_DELAY_MS);
  };
  // The methods as `target` sees them now (its own, or the prototype's), called
  // on whichever wrapper the call came through.
  const set = tagged.set;
  const del = tagged.delete;
  const clear = tagged.clear;
  tagged.set = function (this: RegistryLike, name: string, value: unknown) {
    const out = set.call(this, name, value);
    ensure(name);
    return out;
  };
  tagged.delete = function (this: RegistryLike, name: string) {
    const out = del.call(this, name);
    if (out) noteGone();
    return out;
  };
  tagged.clear = function (this: RegistryLike) {
    clear.call(this);
    noteGone();
  };
  for (const name of registry.keys()) ensure(name);
  const gate: HighlightRuleGate = { installed: () => live, prune };
  tagged[INSTALLED] = gate;
  return gate;
}

/**
 * Install the gate on this document (main.tsx, before the first render). Without
 * the Custom Highlight API there is nothing to paint and nothing to install; if
 * the sheet cannot be split, every rule goes in, as before the gate.
 */
export function installHighlightRules(doc: Document = document, css: string = highlightsCss): void {
  const win = doc.defaultView as (Window & { CSS?: { highlights?: RegistryLike } }) | null;
  const registry = win?.CSS?.highlights;
  if (!registry || typeof registry.set !== 'function') return;
  const style = doc.createElement('style');
  style.dataset.walnutHighlights = '';
  doc.head.appendChild(style);
  let blocks: HighlightRuleBlock[];
  try {
    blocks = splitHighlightRules(css);
  } catch {
    style.textContent = css;
    return;
  }
  gateHighlightRules(registry, style, blocks, setTimeout, Date.now, Object.getPrototypeOf(registry) as object);
}
