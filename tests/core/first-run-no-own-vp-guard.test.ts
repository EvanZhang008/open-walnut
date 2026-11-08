/**
 * Nothing Walnut does by itself makes a VP named after the work it brought in.
 *
 * 2026-11-12, the user, on a new install's Org page: the first run's import of this Mac's
 * sessions had become a VP of its own, "Imported from this Mac", beside the CEO. "The import
 * should default under Others." The importer now puts a new import project under the VP of its
 * sibling import projects, else under the Others VP (src/core/sessions/import-project-vp.ts).
 *
 * The class is any automatic path that makes a VP. Every call that can make one is read from the
 * source: making a node (createOrgNode), making a project's lead (ensureProjectLead,
 * ensureLeadNow), a move that may make the target's lead (setProjectVp), and a task written with
 * `org_role: 'lead'`. Each file holding one is listed below with why it may; a new file fails
 * until it is listed, and the automatic one (the importer's placement) may only make the Others VP.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');

/** A call that can make a VP (a lead task). */
const MAKES_VP = /\b(createOrgNode|ensureProjectLead|ensureLeadNow|setProjectVp)\s*\(|org_role:\s*['"]lead['"]/g;

/** Every file that may make a VP, and why. */
const ALLOWED: Record<string, string> = {
  'src/core/org/org-store.ts': 'the primitives themselves: a project lead on first contact, a move the user or an agent asked for',
  'src/core/org/org-node-edit.ts': 'the Org page\'s New VP / New project, asked for by the user or an agent',
  'src/web/routes/org-v1.ts': 'the routes those asks go through',
  'src/core/sessions/import-project-vp.ts': 'the importer\'s placement: only under a sibling\'s VP or the Others VP',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** The source without comments, so a doc line naming a call never counts as one. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('only the listed paths make a VP', () => {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const calls = [...code(fs.readFileSync(file, 'utf8')).matchAll(MAKES_VP)].map((m) => m[1] ?? 'org_role: lead');
    if (calls.length) found.set(rel, calls);
  }

  it('every file that can make a VP is listed with its reason', () => {
    const unlisted = [...found.keys()].filter((f) => !(f in ALLOWED));
    expect(unlisted, `New code that can make a VP: ${unlisted.join(', ')}. An automatic path (first run, an import, a sync) must place work under an existing VP or the Others VP, never make one named after the work; list it in ALLOWED with why.`).toEqual([]);
  });

  it('the list holds no file that no longer makes one', () => {
    expect(Object.keys(ALLOWED).filter((f) => !found.has(f))).toEqual([]);
  });

  it('the importer itself makes no VP: it only calls the placement', () => {
    const importer = code(fs.readFileSync(path.join(SRC, 'core/sessions/external-session-import.ts'), 'utf8'));
    expect(importer.match(MAKES_VP) ?? []).toEqual([]);
    expect(importer).toMatch(/placeNewImportProject\(/);
  });

  it('the placement makes one VP only, the Others VP, by its constant name', () => {
    const placement = code(fs.readFileSync(path.join(SRC, 'core/sessions/import-project-vp.ts'), 'utf8'));
    const creates = [...placement.matchAll(/createOrgNode\(\s*\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(creates).toEqual(['name: OTHERS_VP_NAME']);
    expect(placement.match(/ensureProjectLead\(|ensureLeadNow\(/g) ?? []).toEqual([]);
    // Every move it makes refuses to make a lead for the target (noCreate).
    const moves = [...placement.matchAll(/setProjectVp\([^)]*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(moves.length).toBeGreaterThan(0);
    for (const guard of moves) expect(guard).toMatch(/noCreate:\s*true/);
  });
});
