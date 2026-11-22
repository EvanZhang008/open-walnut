/**
 * The UI standard (.claude/skills/walnut-ui-requirements/standard.md): one look per kind of control.
 *
 * 2026-11-21, the user, on one screen with a question card (grey rounded option buttons) and a
 * result card (filled blue Acknowledge, outlined Snooze, outlined pin): "why they are not even
 * consistent come on". Both were the shared `.btn`, each restyled by its own card's CSS.
 *
 * Three ways a second style gets in, counted per file (ui-standard-scan.ts):
 *   - restyledBtn: a rule that changes how `.btn` looks for one place (`.scope .btn`,
 *     `.btn.extra`, or a class the TSX writes beside `btn`). The card family's one home,
 *     components/actions/ask-card.css, is exempt (from ownControl too: it maps an approval's own
 *     buttons onto the family inside a card).
 *   - ownControl: a `*-btn` / `*-button` / `*-pill` / `*-chip` class with its own fill and corner.
 *   - rawAccent: a literal #007aff / #0a84ff where var(--accent) belongs.
 *   - the token kinds (ui-token-scan.ts): rawColour, radiusNotToken, pillRadius, fontSizeOffScale,
 *     shadowLiteral, zIndexLiteral, spacingOffGrid: a value written where a token belongs.
 * The counts that exist today are in ui-standard-baseline.json and may only go down. A new file or
 * a higher count fails: use the family the standard names. A lower count fails too until the
 * baseline is lowered with `UI_STANDARD_RECORD=1` on this file, so the ratchet stays tight.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countAll, restylesBtn, isOwnControl, TOKEN_KINDS, type Counts } from './ui-standard-scan';
import { tokenBreaks } from './ui-token-scan';
import type { Decl } from './css-scan';

const BASELINE = path.join(__dirname, 'ui-standard-baseline.json');
/** The one home of the card button family (standard.md, "The button family"). */
const FAMILY_HOME = 'components/actions/ask-card.css';
const STANDARD = '.claude/skills/walnut-ui-requirements/standard.md';

function current(): Counts {
  const c = countAll();
  // The family's home gives every card control the family's look, an approval's own buttons included.
  delete c.restyledBtn[FAMILY_HOME];
  delete c.ownControl[FAMILY_HOME];
  return c;
}

function compare(kind: keyof Counts, now: Record<string, number>, was: Record<string, number>) {
  const grew: string[] = [];
  const fell: string[] = [];
  for (const [file, n] of Object.entries(now)) {
    const before = was[file] ?? 0;
    if (n > before) grew.push(`${kind}: web/src/${file} has ${n} (was ${before})`);
  }
  for (const [file, before] of Object.entries(was)) {
    const n = now[file] ?? 0;
    if (n < before) fell.push(`${kind}: web/src/${file} has ${n} (baseline ${before})`);
  }
  return { grew, fell };
}

describe('UI standard: one look per kind of control', () => {
  const now = current();

  if (process.env.UI_STANDARD_RECORD === '1') {
    fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  }
  const recorded = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Partial<Counts>;
  const was = Object.fromEntries(Object.keys(now).map((k) => [k, recorded[k as keyof Counts] ?? {}])) as Counts;

  for (const kind of ['restyledBtn', 'ownControl', 'rawAccent', ...TOKEN_KINDS] as const) {
    it(`${kind}: no new second style`, () => {
      const { grew } = compare(kind, now[kind], was[kind]);
      expect(grew, `A second style of a shared control. Use the family in ${STANDARD} instead:\n${grew.join('\n')}`).toEqual([]);
    });
    it(`${kind}: the baseline follows every fix`, () => {
      const { fell } = compare(kind, now[kind], was[kind]);
      expect(fell, `Fewer exceptions than recorded: good. Lower the baseline with\nUI_STANDARD_RECORD=1 bun --bun vitest run tests/web/ui-standard-ratchet.test.ts\n${fell.join('\n')}`).toEqual([]);
    });
  }

  it('finds each shape of a second style', () => {
    const companions = new Set(['org-ask-tool']);
    expect(restylesBtn('.ask-card-answer .btn')).toBe(true);
    expect(restylesBtn('.btn.org-thread-pin-btn')).toBe(true);
    expect(restylesBtn('.org-ask-tool', companions)).toBe(true);
    expect(restylesBtn('.org-ask-tool:hover', companions)).toBe(true);
    expect(restylesBtn('.btn')).toBe(false);
    expect(restylesBtn('.btn.btn-sm.btn-primary:hover')).toBe(false);
    expect(restylesBtn('.something-else')).toBe(false);
    expect(isOwnControl('.kanban-icon-btn')).toBe(true);
    expect(isOwnControl('.row .pr-pill:hover')).toBe(true);
    expect(isOwnControl('.card-title')).toBe(false);
  });

  it('finds each value that is not a token', () => {
    const d = (prop: string, value: string, selectors = ['.x']): Decl => ({ file: 'x.css', line: 1, prop, value, selectors, atRules: [] });
    expect(tokenBreaks(d('color', '#1d1d1f'))).toEqual(['rawColour']);
    expect(tokenBreaks(d('border', '1px solid rgba(0, 0, 0, 0.1)'))).toEqual(['rawColour']);
    expect(tokenBreaks(d('color', 'var(--fg, #1d1d1f)'))).toEqual([]);
    expect(tokenBreaks(d('--my-ink', '#333'))).toEqual(['rawColour']);
    expect(tokenBreaks(d('--fg', '#1d1d1f', [':root[data-theme="dark"]']))).toEqual([]);
    expect(tokenBreaks(d('border-radius', '6px'))).toEqual(['radiusNotToken']);
    expect(tokenBreaks(d('border-radius', 'var(--radius-sm) var(--radius-sm) 0 0'))).toEqual([]);
    expect(tokenBreaks(d('border-radius', '50%'))).toEqual([]);
    expect(tokenBreaks(d('border-radius', '999px'))).toEqual(['pillRadius']);
    expect(tokenBreaks(d('font-size', '12.5px'))).toEqual(['fontSizeOffScale']);
    expect(tokenBreaks(d('font-size', 'var(--font-size-sm)'))).toEqual([]);
    expect(tokenBreaks(d('font', '500 12px/1.4 var(--font-sans)'))).toEqual(['fontSizeOffScale']);
    expect(tokenBreaks(d('font', '500 var(--font-size-sm)/18px var(--font-sans)'))).toEqual([]);
    expect(tokenBreaks(d('box-shadow', '0 8px 24px rgba(0, 0, 0, 0.16)'))).toEqual(['shadowLiteral']);
    expect(tokenBreaks(d('box-shadow', '0 0 0 2px var(--accent)'))).toEqual([]);
    expect(tokenBreaks(d('box-shadow', 'inset 0 1px 3px rgba(0, 0, 0, 0.2)'))).toEqual([]);
    expect(tokenBreaks(d('box-shadow', 'var(--shadow-sm), 0 0 0 1px var(--border)'))).toEqual([]);
    expect(tokenBreaks(d('box-shadow', '0 10px 30px color-mix(in srgb, var(--fg) 20%, transparent)'))).toEqual(['shadowLiteral']);
    expect(tokenBreaks(d('box-shadow', 'rgb(0 0 0 / 20%) 0 4px 12px'))).toEqual(['shadowLiteral']);
    expect(tokenBreaks(d('color', 'red'))).toEqual(['rawColour']);
    expect(tokenBreaks(d('border-color', 'var(--red-ish)'))).toEqual([]);
    expect(tokenBreaks(d('z-index', '1000'))).toEqual(['zIndexLiteral']);
    expect(tokenBreaks(d('z-index', '1'))).toEqual([]);
    expect(tokenBreaks(d('padding', '5px 8px'))).toEqual(['spacingOffGrid']);
    expect(tokenBreaks(d('padding', '1px 6px'))).toEqual([]);
  });

  it('the standard it enforces exists and names this test', () => {
    const text = fs.readFileSync(path.join(__dirname, '../..', STANDARD), 'utf8');
    expect(text).toContain('tests/web/ui-standard-ratchet.test.ts');
    expect(text).toContain(FAMILY_HOME.replace('components/', 'web/src/components/'));
  });
});
