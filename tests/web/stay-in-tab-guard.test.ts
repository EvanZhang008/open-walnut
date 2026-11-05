/**
 * The home task panel never changes the tab by itself (2026-11-04, the user: "if I click the
 * project name in one pin group, should keep in the same pin group, people can go to all if they
 * need, we don't auto go to all"). The tab changes only where the user picks one: the tab bar,
 * the Display menu's view list, and the button of the note on a task opened from outside that
 * the tab does not draw (OffViewNote). A project name click filters the tab it came from.
 *
 * Fails when a new call changes the tab from anywhere else.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PANEL = readFileSync(join(__dirname, '../../web/src/components/tasks/TodoPanel.tsx'), 'utf8');

/** Each line that changes the tab, with what the user did there. */
const ALLOWED: Array<[RegExp, string]> = [
  [/onSectionChange: \(id: string\) => handleSectionChange\(id as TodoSection\)/, 'the Display menu: the user picks a view'],
  [/onChange=\{handleSectionChange\}/, 'the tab bar: the user picks a tab'],
  [/^\s*handleSectionChange\(target\);$/, 'the off-view note: the user clicks Show in …'],
];

describe('the task panel changes the tab only where the user picks one', () => {
  it('every handleSectionChange call is a user pick', () => {
    const calls = PANEL.split('\n').filter((line) => /handleSectionChange[(}]|handleSectionChange\)/.test(line)
      && !/const handleSectionChange = /.test(line) && !/^\s*\/\//.test(line));
    const unexplained = calls.filter((line) => !ALLOWED.some(([re]) => re.test(line)));
    expect(unexplained, 'a new tab change: route it through the user (OffViewNote) or list it here with why').toEqual([]);
    for (const [re, why] of ALLOWED) expect(calls.some((line) => re.test(line)), why).toBe(true);
  });

  it('no other path writes the tab state', () => {
    // Besides handleSectionChange: a tab the user picked inside a project jump, kept when the
    // jump ends, and the stale custom tab's heal.
    const writes = PANEL.split('\n').filter((line) => /setActiveSection\(/.test(line));
    expect(writes.map((l) => l.trim())).toEqual([
      'const keepPickedTab = (section: TodoSection) => { startTransition(() => setActiveSection(section)); persistSection(section); };',
      'startTransition(() => setActiveSection(section));',
      "if (isDeleted(activeSection)) { setActiveSection('focus'); persistSection('focus'); }",
    ]);
    const kept = PANEL.split('\n').filter((line) => /keepPickedTab\(/.test(line) && !/const keepPickedTab/.test(line));
    expect(kept.map((l) => l.trim())).toEqual(['if (jumpPicked) keepPickedTab(jumpPicked as TodoSection);']);
  });

  it('a project jump shows the tab it came from', () => {
    expect(PANEL).toMatch(/projectJumpSection\(projectJump, activeSection\)/);
  });
});
