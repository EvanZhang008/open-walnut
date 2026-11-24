/**
 * Source guards of the v6 new task draft (experiment project_first_start), one per class a
 * review found (round 1, 2026-11-22). Each scans the source, so a NEW member of the class (another
 * place the isolated-workspace choice is mounted or read, another clickable non-button in the
 * row, another per-draft module store) fails here, not only the case that was reported. The
 * behaviour itself is in tests/e2e/browser/project-first-start*.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SESSIONS = 'web/src/components/sessions';
/** The v6 draft's own files (DraftV6Body and everything it lays out). */
const V6_FILES = fs.readdirSync(path.join(ROOT, SESSIONS))
  .filter((f) => /^(DraftV6Body|DraftV6Panel|DraftWhere\w*|DraftLowerRow|DraftProjectMenu|DraftModeTiles|DraftSourcePackages|useDraftWhere|useDraftMoreMenu)\.tsx?$/.test(f))
  .map((f) => `${SESSIONS}/${f}`);

/** A JSX opening tag from `<` to its `>`, skipping `>` inside `{...}` (arrow functions) and quotes. */
function openingTag(src: string, at: number): string {
  let depth = 0;
  let quote = '';
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

describe('the isolated workspace choice: shown exactly where Start reads it (H1)', () => {
  it('every v6 mount of the workspace row, its chip and its More item is gated on where.readsWorkspace', () => {
    const mounts: string[] = [];
    for (const file of V6_FILES) {
      const src = read(file);
      const re = /<(DraftWorkspaceRow|DraftWorkspaceAutoChip|DraftWorkspaceMenuItem)\b/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        // The JSX expression that holds the element: from the last `{` before it.
        const before = src.slice(Math.max(0, m.index - 260), m.index);
        mounts.push(`${file}:${m[1]}`);
        expect(before.slice(before.lastIndexOf('{')), `${file}: <${m[1]}> mounted without where.readsWorkspace`).toMatch(/where\.readsWorkspace/);
        expect(before.slice(before.lastIndexOf('{')), `${file}: <${m[1]}> gated on autoCurrent (the H1 bug)`).not.toMatch(/autoCurrent/);
      }
    }
    expect(mounts.length).toBeGreaterThanOrEqual(3);
  });

  it('Start reads the choice only under the same rule', () => {
    const main = read('web/src/pages/MainPage.tsx');
    const reads = main.match(/draftWorkspaceRequest\(/g) ?? [];
    expect(reads.length).toBe(1);
    expect(main).toMatch(/startReadsDraftWorkspace\(projectStart\) \? draftWorkspaceRequest\(draftId\) : null/);
    expect(read(`${SESSIONS}/useDraftWhere.ts`)).toMatch(/readsWorkspace: startReadsDraftWorkspace\(ps\)/);
  });
});

describe('the v6 row is reached by keyboard (M6) and its send label never starts on nothing (H3)', () => {
  it('no element of the v6 files takes a click unless it is a button, an input or a menu option row', () => {
    for (const file of V6_FILES) {
      const src = read(file);
      const re = /<(div|span|section|li)\b/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const tag = openingTag(src, m.index);
        if (!/\sonClick=/.test(tag)) continue;
        // A listbox option row is reached by the menu's own keys (↑↓ Enter on its search).
        expect(tag, `${file}: a <${m[1]}> takes a click (make it a button): ${tag.slice(0, 100)}`).toMatch(/role="option"|rowProps\(/);
      }
    }
    const row = read(`${SESSIONS}/DraftWhereRow.tsx`);
    // Each field (Project, Where) is one real button of the family under its parts.
    expect(row).toMatch(/<button type="button" className="btn btn-link draft-v6-field-open"/);
    expect(row).toMatch(/<FieldOpen testId="draft-v6-project-open"/);
    expect(row).toMatch(/<FieldOpen testId="draft-v6-where-open"/);
  });

  it('the v6 draft has no send words: the arrow alone starts it (Evan crossed out "Start task", 2026-11-23)', () => {
    expect(read(`${SESSIONS}/DraftV6Panel.tsx`)).not.toMatch(/draft-v6-send-label/);
    expect(read(`${SESSIONS}/DraftSessionPanel.tsx`)).toMatch(/sendSlot=\{v6 \? null/);
  });
});

describe('per-draft module stores are emptied with the draft (M7)', () => {
  it('every module-level Map keyed by draft in the v6 files has a forget that MainPage calls on close and launch', () => {
    const forgetBody = (() => {
      const main = read('web/src/pages/MainPage.tsx');
      const at = main.indexOf('const forgetDraft = useLeanCallback(');
      return main.slice(at, main.indexOf('}, []);', at));
    })();
    for (const file of V6_FILES) {
      const src = read(file);
      if (!/^const \w+ = new Map</m.test(src)) continue;
      const forget = /export function (forget\w+)\(draftId: string\)/.exec(src);
      expect(forget, `${file} keeps per-draft Maps with no exported forget(draftId)`).not.toBeNull();
      expect(forgetBody, `MainPage's forgetDraft does not call ${forget![1]}`).toContain(`${forget![1]}(draftId)`);
    }
  });
});

describe('the v6 additions stay out of the draft panel (review round 2)', () => {
  // Main's file before v6 was 1256 lines (it grew under us): the experiment never makes it bigger.
  it('DraftSessionPanel.tsx is no bigger than main\'s before v6 (1256 lines)', () => {
    expect(read(`${SESSIONS}/DraftSessionPanel.tsx`).split('\n').length).toBeLessThanOrEqual(1257);
  });
});
