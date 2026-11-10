/**
 * Every start that takes a pick of the engine split reads its entries through splitBuildersFor,
 * which leaves out a task in a project the split does not share (2026-11-10: a lead's org demo in
 * another project was given Codex, though the user meant the split for Walnut's own work). Fails
 * on a new caller of pickSplitEngine, or of the unscoped splitBuilders, until it is listed here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...sourceFiles(p)); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

/** Calls of the unscoped reader, per file, and why each picks nothing. */
const UNSCOPED: Record<string, { calls: number; why: string }> = {
  'src/core/sessions/task-start.ts': { calls: 1, why: 'names another entry in a failed start\'s message; it picks nothing' },
  'src/core/usage/engine-compare.ts': { calls: 2, why: 'labels and lists the entries for the comparison; it picks nothing' },
};

describe('engine split project scope', () => {
  const files = [...sourceFiles(path.join(ROOT, 'src')), ...sourceFiles(path.join(ROOT, 'web/src'))]
    .filter((f) => !f.endsWith(path.join('core', 'agents', 'engine-split.ts')));
  const texts = new Map(files.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8')]));

  it('only task-start picks, and it reads its entries through splitBuildersFor', () => {
    const pickers = [...texts].filter(([, t]) => /\bpickSplitEngine\(/.test(t)).map(([f]) => f);
    expect(pickers).toEqual(['src/core/sessions/task-start.ts']);
    const t = texts.get('src/core/sessions/task-start.ts')!;
    expect(t).toMatch(/const builders = splitBuildersFor\(await getConfig\(\), task\);/);
    expect(t).toMatch(/pickSplitEngine\(builders,/);
  });

  it('every call of the unscoped splitBuilders is listed, with why it picks nothing', () => {
    const found: Record<string, number> = {};
    for (const [f, t] of texts) {
      const n = count(t, /\bsplitBuilders\(/g);
      if (n) found[f] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(UNSCOPED).map(([f, v]) => [f, v.calls])));
  });
});
