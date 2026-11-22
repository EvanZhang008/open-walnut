/**
 * One set of choice controls (.claude/skills/walnut-ui-requirements/standard.md, "Choice
 * controls"): every tab bar, segmented control, switch, selectable chip, checkbox, radio and
 * disclosure is one of the shared components in web/src/components/controls/ (Tabs, SegmentedControl,
 * ToggleSwitch, Chip, Checkbox / Radio, DisclosureButton), drawn by styles/choice-controls.css.
 *
 * 2026-11-21 audit: 14 segmented controls, 14 tab bars with 5 active-state hooks, 9 switches in 6
 * sizes, 49 native checkboxes with 16 accent-color rules. The user: "why the ui still not
 * consistent ... come on" and, on round controls, "什么鬼东西都要是圆形的呀".
 *
 * choice-controls-scan.ts finds each hand-built one, per file and kind. The ones left are in
 * choice-controls-baseline.json and may only go down: a new file or a higher count fails (build it
 * from the shared component), and a lower count fails until the baseline is lowered with
 * `CHOICE_CONTROLS_RECORD=1` on this file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countAll, kindsOf, members, KINDS, type Counts } from './choice-controls-scan';

const BASELINE = path.join(__dirname, 'choice-controls-baseline.json');
const STANDARD = '.claude/skills/walnut-ui-requirements/standard.md';
const ALL = [...KINDS, 'ownLook'] as const;

describe('choice controls: one component per kind', () => {
  const now = countAll();
  if (process.env.CHOICE_CONTROLS_RECORD === '1') fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  const was = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Counts;

  for (const kind of ALL) {
    it(`${kind}: no new hand-built control`, () => {
      const grew = Object.entries(now[kind]).filter(([f, n]) => n > (was[kind]?.[f] ?? 0)).map(([f, n]) => f);
      const where = members().filter((m) => m.kind === kind && grew.includes(m.file)).map((m) => `web/src/${m.file}:${m.line} <${m.tag}> ${m.what}`);
      const detail = kind === 'ownLook' ? grew.map((f) => `web/src/${f}: ${now.ownLook[f]} (was ${was.ownLook?.[f] ?? 0})`) : where;
      expect(detail, `A ${kind} built by hand. Use the shared component from web/src/components/controls (${STANDARD}, "Choice controls"):\n${detail.join('\n')}`).toEqual([]);
    });
    it(`${kind}: the baseline follows every fix`, () => {
      const fell = Object.entries(was[kind] ?? {}).filter(([f, n]) => (now[kind][f] ?? 0) < n).map(([f, n]) => `web/src/${f}: ${now[kind][f] ?? 0} (baseline ${n})`);
      expect(fell, `Fewer hand-built controls than recorded: good. Lower the baseline with\nCHOICE_CONTROLS_RECORD=1 bun --bun vitest run tests/web/choice-controls-ratchet.test.ts\n${fell.join('\n')}`).toEqual([]);
    });
  }

  it('finds each shape of a hand-built control', () => {
    const k = (tag: string, attrs: string) => kindsOf(tag, attrs).map((x) => x.kind);
    expect(k('button', ' role="tab" aria-selected={on}')).toEqual(['tab']);
    expect(k('div', ' className="team-card-tabs"')).toEqual(['tab']);
    expect(k('button', ' className={`pw-seg${on ? " on" : ""}`}')).toEqual(['segment']);
    expect(k('button', ' role="switch" aria-checked={on}')).toEqual(['switch']);
    expect(k('span', ' className="pr-card-switch-track"')).toEqual([]);
    expect(k('label', ' className="draft-workspace-switch"')).toEqual(['switch']);
    // A wrapper around a shared switch is not one; a clickable span is.
    expect(k('span', ' className="apps-card-switch" title="x"')).toEqual([]);
    expect(k('span', ' className="row-switch" onClick={flip}')).toEqual(['switch']);
    expect(k('input', ' type="checkbox" checked={on}')).toEqual(['check']);
    expect(k('input', ' type="text"')).toEqual([]);
    expect(k('button', ' className="org-threads-chip" aria-pressed={on}')).toEqual(['chip']);
    expect(k('span', ' className="task-group-chip"')).toEqual([]);
    expect(k('button', ' aria-pressed={on} className={on ? "is-on" : ""}')).toEqual(['pressed']);
    expect(k('button', ' aria-pressed={on} className="notes-format-btn"')).toEqual([]);
    expect(k('button', ' className={`team-tab-bar-item ${a ? "team-tab-bar-item-active" : ""}`}')).toEqual(['tab']);
    expect(k('button', ' className="routine-fold-toggle" aria-expanded={open}')).toEqual(['disclose']);
    expect(k('button', ' className="menu-trigger" aria-expanded={open}')).toEqual([]);
    // The shared components themselves never count.
    expect(k('Tab', ' className="team-tab" selected')).toEqual([]);
    expect(k('Chip', ' className="org-threads-chip" pressed={on}')).toEqual([]);
    expect(k('Checkbox', ' checked={on}')).toEqual([]);
    expect(k('div', ' role="radio" data-choice-exempt="a menu row that runs a command"')).toEqual([]);
    expect(k('div', ' role="radio" data-choice-exempt="x"')).toEqual(['segment']);
  });

  it('the standard names the components and this test', () => {
    const text = fs.readFileSync(path.join(__dirname, '../..', STANDARD), 'utf8');
    expect(text).toContain('tests/web/choice-controls-ratchet.test.ts');
    for (const c of ['Tabs', 'SegmentedControl', 'Chip', 'ToggleSwitch', 'Checkbox', 'Radio', 'DisclosureButton']) expect(text).toContain(`\`${c}\``);
  });
});
