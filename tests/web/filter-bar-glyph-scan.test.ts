/**
 * C22 ratchet: the Filter bar / Display menu slice draws its marks from
 * Icons.tsx. No em or en dash, no emoji and none of the old text glyphs
 * (multiply sign, check mark, clock, carets, hourglass, up-down arrow) may
 * appear in code (comments are stripped first) of the files the slice owns,
 * the tab bar, the panel footer and mini-bar, and the toaster that shows the
 * slice's "Filters cleared" and "Tab bar hidden" toasts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../web/src');
const FILES = [
  'components/tasks/FilterMenu.tsx', 'components/tasks/FilterBar.tsx', 'components/tasks/FilterHome.tsx',
  'components/tasks/FilterValuesPage.tsx', 'components/tasks/FilterValueList.tsx', 'components/tasks/FilterTimeControls.tsx',
  'components/tasks/FilterSearchResults.tsx', 'components/tasks/filter-dim-icons.tsx', 'components/tasks/filter-home-model.ts',
  'components/tasks/FilterChipMenu.tsx', 'components/tasks/FilterOverflowMenu.tsx',
  'components/tasks/DisplayMenu.tsx', 'components/tasks/DisplaySections.tsx', 'components/tasks/DisplaySortRows.tsx',
  'components/tasks/TodoSectionTabs.tsx', 'components/tasks/TodoFilterFooter.tsx',
  'components/tasks/TodoProjectsMiniBar.tsx', 'components/tasks/TodoFilterEmpty.tsx',
  'components/tasks/filter-bar-model.ts', 'components/tasks/filter-bar-dims.ts', 'components/tasks/filter-recent.ts',
  'components/tasks/tab-bar-model.ts', 'components/tasks/TaskFilterChips.tsx',
  'components/common/NotificationToaster.tsx',
];

/** Drop block comments (JSX ones too) and line comments, keep string and JSX text. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const DASH = /[\u2013\u2014]/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const OLD_GLYPHS = /[\u00D7\u2713\u25F7\u2303\u2304\u29D7\u2195]/;

describe('slice files carry no dash, emoji or text glyph in code (C22)', () => {
  for (const rel of FILES) {
    it(rel, () => {
      const lines = codeOnly(readFileSync(join(ROOT, rel), 'utf8')).split('\n');
      const hits = lines
        .map((line, i) => ({ line: i + 1, text: line.trim() }))
        .filter(({ text }) => DASH.test(text) || EMOJI.test(text) || OLD_GLYPHS.test(text));
      expect(hits).toEqual([]);
    });
  }
});
