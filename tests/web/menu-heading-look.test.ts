/**
 * One heading look in every menu: a section name of a menu is the shared MenuHeading
 * (`.wn-menu-heading`, overlay-family.css): sentence case, 11 px, weight 600, --fg-secondary
 * (standard.md, Big menus).
 *
 * 2026-11-26, the UI audit at 1512 and 390 wide: the mode menu drew "PERMISSION MODE" and the model
 * picker "MODEL" and "EFFORT" in capitals, beside menus whose sections read "Session", "Shortcuts"
 * and "Filter". The class held twelve menus, each with its own heading class that set capitals,
 * letter spacing, size and colour: the mode and model pickers, the trigger picker, the quick bar,
 * the mic's retry menu, the path selector, the notes chat switcher, the slash menu, the Tasks
 * columns menu, the batch menu, the snooze rows and the @ palette.
 *
 * Found from the source, so a new heading in capitals fails here: every class set in capitals by a
 * stylesheet, used by a file that draws a menu, is named below with why it is not a menu's heading.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scanCss, walk } from './css-scan';

const WEB_SRC = path.join(__dirname, '../../web/src');
const rel = (f: string) => path.relative(WEB_SRC, f).split(path.sep).join('/');

/** Classes a stylesheet sets in capitals (the class the rule's last compound names). */
function capitalised(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of walk(WEB_SRC, ['.css'])) {
    for (const d of scanCss(f, fs.readFileSync(f, 'utf8'))) {
      if (d.prop !== 'text-transform' || !/uppercase/.test(d.value)) continue;
      for (const sel of d.selectors) {
        const last = sel.trim().split(/\s+/).pop() ?? '';
        const c = /\.([\w-]+)/.exec(last)?.[1];
        if (c) out.set(c, `${rel(f)}:${d.line}`);
      }
    }
  }
  return out;
}

/** Drawn in capitals inside a file that also draws a menu, and not a menu's section name. */
const NOT_A_MENU_HEADING: Record<string, string> = {
  'draft-v6-field-key': "a field's key on the draft launch bar, not in a menu",
  'draft-decisions-key': "a key on the draft launch bar's decisions line, not in a menu",
  'draft-quick-key': "a key on the draft launch bar's quick line, not in a menu",
  'session-taskbar-recent-label': "the taskbar's own Recent label on the bar, not in its menu",
  'latest-update-label': "a hover card's kicker over the latest update, not a menu's section",
  'trigger-jobs-state': "a state badge on a trigger's job, not a heading",
  'mic-history-alt-engine': 'a badge on a recent voice input row, naming its engine',
  'org-list-section': "a section of the Org page's channel list, a page, not a menu",
  'tp-th': "the Tasks page table's column heads, a table, not a menu",
  'usage-daterange-field': "a field's label in the usage date range form",
  'ext-relay-label': "a label in the extension relay panel, not a menu",
};

const DRAWS_MENU = /\bwn-menu(?![\w-])|useMenuPlacement|role="(?:menu|listbox)"|<MenuHeading\b/;

describe('menus: one heading look', () => {
  it('the shared heading is sentence case', () => {
    const family = fs.readFileSync(path.join(WEB_SRC, 'styles/overlay-family.css'), 'utf8');
    const rule = /html \.wn-menu-heading \{([^}]*)\}/.exec(family)?.[1] ?? '';
    expect(rule).toMatch(/font-weight: 600;/);
    expect(rule).toMatch(/color: var\(--fg-secondary\);/);
    expect(capitalised().has('wn-menu-heading')).toBe(false);
  });

  it('no menu draws a heading in capitals', () => {
    const caps = capitalised();
    const off: string[] = [];
    for (const f of walk(WEB_SRC, ['.tsx'])) {
      const src = fs.readFileSync(f, 'utf8');
      if (!DRAWS_MENU.test(src)) continue;
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
        for (const c of (m[1] ?? m[2] ?? m[3]).split(/[\s$]+/)) {
          if (caps.has(c) && !(c in NOT_A_MENU_HEADING)) off.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length} .${c} (capitals at ${caps.get(c)})`);
        }
      }
    }
    expect(off, "a menu's section name is <MenuHeading> / .wn-menu-heading in sentence case; else name it in NOT_A_MENU_HEADING with why").toEqual([]);
  });

  it('the exceptions are still drawn in capitals', () => {
    const caps = capitalised();
    for (const c of Object.keys(NOT_A_MENU_HEADING)) expect(caps.has(c), c).toBe(true);
  });

  it('the menus of the 2026-11-26 audit use the shared heading', () => {
    for (const [file, cls] of [
      ['components/sessions/PermissionModeMenu.tsx', 'model-picker-col-title'],
      ['components/sessions/ModelPicker.tsx', 'model-picker-col-title'],
      ['components/tasks/SnoozeChoices.tsx', 'snooze-rows-head'],
      ['components/sessions/TriggerPickerPopover.tsx', 'trigger-picker-section-title'],
    ]) {
      const src = fs.readFileSync(path.join(WEB_SRC, file), 'utf8');
      expect(src, file).toMatch(new RegExp(`className="${cls} wn-menu-heading"`));
    }
  });
});
