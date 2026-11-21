/**
 * What the UI standard (.claude/skills/walnut-ui-requirements/standard.md) calls a second style,
 * counted per file. Used by ui-standard-ratchet.test.ts.
 *
 * 2026-11-21: one screen showed a question card with grey rounded option buttons and a result card
 * with a filled blue Acknowledge and an outlined Snooze. Both were `.btn`, each restyled by its
 * card's own CSS. Each counter below is one way that happens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss, type Decl } from './css-scan';
import { tokenBreaks, TOKEN_KINDS, type TokenKind } from './ui-token-scan';

export { TOKEN_KINDS };

export const WEB_SRC = path.join(__dirname, '../../web/src');

/** The button family: a compound made only of these classes is the family itself. */
export const FAMILY = new Set(['btn', 'btn-primary', 'btn-sm', 'btn-ghost', 'btn-icon', 'btn-danger', 'btn-danger-outline', 'btn-xs', 'btn-lg']);

/** Properties that change how a control looks (layout-only ones like margin or order are fine). */
const LOOK = /^(background|background-color|border|border-color|border-width|border-style|border-radius|padding|padding-inline|padding-block|font-size|font-weight|min-height|height|color|box-shadow)$/;

const classesOf = (compound: string) => [...compound.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);

/** Compounds of one selector, without pseudo-classes and pseudo-elements. */
function compounds(selector: string): string[] {
  const bare = selector.replace(/::?[A-Za-z-]+(\((?:[^()]|\([^()]*\))*\))?/g, '').replace(/\[[^\]]*\]/g, '');
  return bare.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
}

/**
 * Classes the TSX writes next to `btn` (`className="btn btn-sm org-ask-tool"`): a CSS rule on one of
 * them restyles the shared button even though its selector never names `.btn`.
 */
export function btnCompanions(): Set<string> {
  const out = new Set<string>();
  for (const file of walk(WEB_SRC, ['.tsx', '.ts'])) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/className=\{?\s*[`'"]([^`'"]*)[`'"]/g)) {
      const words = m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
      if (!words.includes('btn')) continue;
      for (const w of words) if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(w) && !FAMILY.has(w)) out.add(w);
    }
  }
  return out;
}

/** `.scope .btn`, `.btn.my-card-btn`, `.my-card-btn` written beside `btn`: the shared button restyled for one place. */
export function restylesBtn(selector: string, companions: Set<string> = new Set()): boolean {
  const parts = compounds(selector);
  const at = parts.findIndex((c) => classesOf(c).includes('btn'));
  if (at < 0) return classesOf(parts[parts.length - 1] ?? '').some((c) => companions.has(c));
  if (at > 0) return true; // an ancestor scope
  return classesOf(parts[at]).some((c) => !FAMILY.has(c)) || parts.length > 1;
}

/** `.my-thing-btn { background; border-radius }`: a button, pill or chip with a look of its own. */
export function isOwnControl(selector: string): boolean {
  const parts = compounds(selector);
  const last = parts[parts.length - 1] ?? '';
  const cls = classesOf(last);
  if (cls.includes('btn')) return false; // counted by restylesBtn
  return cls.some((c) => /(-btn|-button|-pill|-chip)$/.test(c));
}

export type Counts = { restyledBtn: Record<string, number>; ownControl: Record<string, number>; rawAccent: Record<string, number> } & Record<TokenKind, Record<string, number>>;

/** Rules (one per file and selector list) in each file that break each rule of the standard. */
export function countAll(): Counts {
  const out = { restyledBtn: {}, ownControl: {}, rawAccent: {}, ...Object.fromEntries(TOKEN_KINDS.map((k) => [k, {}])) } as Counts;
  const bump = (m: Record<string, number>, f: string) => { m[f] = (m[f] ?? 0) + 1; };
  const companions = btnCompanions();
  for (const file of walk(WEB_SRC, ['.css']).sort()) {
    const rel = path.relative(WEB_SRC, file);
    const rules = new Map<string, Decl[]>();
    for (const d of scanCss(rel, fs.readFileSync(file, 'utf8'))) {
      const key = d.selectors.join(', ');
      rules.set(key, [...(rules.get(key) ?? []), d]);
      for (const kind of tokenBreaks(d)) bump(out[kind], rel);
    }
    for (const [, decls] of rules) {
      const sels = decls[0].selectors;
      const sets = (re: RegExp) => decls.some((d) => re.test(d.prop));
      if (decls.some((d) => LOOK.test(d.prop)) && sels.some((x) => restylesBtn(x, companions))) bump(out.restyledBtn, rel);
      else if (sets(/^background(-color)?$/) && sets(/^border-radius$/) && sels.some(isOwnControl)) bump(out.ownControl, rel);
    }
  }
  for (const file of walk(WEB_SRC, ['.css', '.ts', '.tsx']).sort()) {
    const n = (fs.readFileSync(file, 'utf8').match(/#(?:007aff|0a84ff)\b/gi) ?? []).length;
    if (n) out.rawAccent[path.relative(WEB_SRC, file)] = n;
  }
  return out;
}
