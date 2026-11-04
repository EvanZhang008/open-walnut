/**
 * Every status fold the web app draws opens and folds by the one rule in
 * web/src/components/tasks/section-fold-rule.ts (2026-11-04, the user: Working, Waiting /
 * snoozed and Completed fold by default and again 15 minutes after opening; Watching and Needs
 * you follow the user's choice). This fails when a file draws a status fold without reading its
 * open state from useFoldStore, keeps a fold store in localStorage by hand, or draws a fold
 * element the busy check cannot find.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const SRC = join(ROOT, 'web/src');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = sources(SRC).map((p) => ({ path: relative(ROOT, p), text: readFileSync(p, 'utf8') }));
const RULE_FILES = new Set([
  'web/src/components/tasks/section-fold-rule.ts',
  'web/src/components/tasks/useFoldStore.ts',
]);

describe('status folds go through the one fold rule', () => {
  it('a file that draws a status fold reads its open state from the fold store', () => {
    const drawers = files.filter((f) => /<(StatusSectionGroup|StatusSectionHeading|ProjectStatusFolds)\b/.test(f.text)
      && !f.path.endsWith('/StatusSections.tsx') && !f.path.endsWith('/PanelDesignParts.tsx'));
    expect(drawers.map((f) => f.path)).toContain('web/src/components/tasks/TodoPanel.tsx');
    const off = drawers.filter((f) => !/\buse(FoldStore|ProjectFolds)\(/.test(f.text)).map((f) => f.path);
    expect(off, 'draws a status fold without useFoldStore / useProjectFolds').toEqual([]);
  });

  it('nobody but useFoldStore reads or writes a fold store in localStorage', () => {
    const keys = /LS_STATUS_SECTIONS_KEY|LS_PROJECT_FOLDS_KEY|walnut-todo-status-sections|walnut-todo-project-status-folds/;
    const off = files
      .filter((f) => !RULE_FILES.has(f.path) && keys.test(f.text) && /localStorage\.(get|set|remove)Item/.test(f.text))
      .filter((f) => f.text.split('\n').some((line) => keys.test(line) && /localStorage/.test(line)))
      .map((f) => f.path);
    expect(off).toEqual([]);
  });

  it('every fold toggle names its fold for the busy check', () => {
    // A status fold toggle: a button with aria-expanded titled from the status section words.
    const toggles = files.filter((f) => /aria-expanded/.test(f.text) && /STATUS_SECTION_(TITLES|LABELS)|statusFoldTooltip/.test(f.text));
    expect(toggles.length).toBeGreaterThan(0);
    const off = toggles.filter((f) => !f.text.includes('FOLD_KEY_ATTR')).map((f) => f.path);
    expect(off, 'a status fold element without FOLD_KEY_ATTR: the 15-minute fold would close it under the pointer').toEqual([]);
  });

  it('every status section has a fold kind', () => {
    const rule = readFileSync(join(ROOT, 'web/src/components/tasks/section-fold-rule.ts'), 'utf8');
    const model = readFileSync(join(ROOT, 'web/src/components/tasks/status-sections.ts'), 'utf8');
    const order = /STATUS_SECTION_ORDER[^=]*=\s*\[([^\]]+)\]/.exec(model)?.[1] ?? '';
    const keys = [...order.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(rule, `section ${k} has no fold kind`).toMatch(new RegExp(`\\b${k}: '(sticky|auto)'`));
  });
});
