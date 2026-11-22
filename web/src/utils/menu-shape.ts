/**
 * The shape every big menu has (standard.md, "Big menus"), as a check: tests/web/menu-shape.test.ts
 * runs it over every ContextMenu item builder, tests/e2e/browser/big-menu-shape.spec.ts over the
 * hand-built menus as drawn (the task and session ⋮ menus, the composer + menu).
 *
 * 2026-11-22, the UI audit (Sol, on a copy of the user's data at 1512x920): the session ⋮ menu mixed
 * layout, task state, dates, moves, team, Delete and session tools in one list cut by seven thin
 * rules, with Delete above the session's own group; the task row menu had five rules and no order
 * of importance; the + menu cut five kinds of row apart with four rules.
 *
 * The shape: the everyday rows first, then the rest as collapsed groups or under a named heading,
 * and the danger rows (Delete…) last, alone under one rule.
 */
import type { ContextMenuItem } from './context-menu';

export type MenuShapeRow = {
  kind: 'item' | 'group' | 'heading' | 'divider' | 'info';
  danger?: boolean;
  label?: string;
};

/** From this many first-level rows on, a menu is a big menu and must have the shape. */
export const BIG_MENU_ROWS = 8;
/** At most this many first-level rows (groups closed); more go into a group or a flyout. */
export const MAX_MENU_ROWS = 16;
/** At most this many bare rules between sections (the danger section's own rule not counted);
 *  more sections are named with a heading instead. */
export const MAX_BARE_RULES = 3;

const actionable = (r: MenuShapeRow) => r.kind === 'item' || r.kind === 'group';

/** What is wrong with a menu's first level, in words a failing test can print; [] when nothing.
 *  `minRows`: check a menu from this many rows on (a host that wants the shape at any length). */
export function menuShapeProblems(rows: MenuShapeRow[], { minRows = BIG_MENU_ROWS }: { minRows?: number } = {}): string[] {
  const problems: string[] = [];
  const count = rows.filter(actionable).length;
  if (count < minRows) return problems;
  const name = (r?: MenuShapeRow) => (r?.label ? `"${r.label}"` : r?.kind ?? 'the end');
  if (count > MAX_MENU_ROWS) problems.push(`${count} first-level rows (at most ${MAX_MENU_ROWS}): fold the rarer ones into a group`);

  const firstDanger = rows.findIndex((r) => actionable(r) && r.danger);
  if (firstDanger >= 0) {
    const after = rows.slice(firstDanger).filter((r) => actionable(r) && !r.danger);
    if (after.length) problems.push(`the danger row ${name(rows[firstDanger])} comes before ${after.map(name).join(', ')}: danger rows go last`);
    const before = rows.slice(0, firstDanger).filter(actionable).length;
    if (before > 0 && rows[firstDanger - 1]?.kind !== 'divider') problems.push(`the danger row ${name(rows[firstDanger])} has no rule above it: it stands alone under one rule`);
  }

  let bare = 0;
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    if (r.kind === 'divider' && next?.kind === 'heading') problems.push(`a rule above the heading ${name(next)}: a heading names its section, so no rule above it`);
    if (r.kind === 'heading' && (!next || !actionable(next))) problems.push(`the heading ${name(r)} has no row under it`);
    // A rule above an info line that names the group under it (Mail's "Walnut") names that section.
    if (r.kind === 'divider' && i + 1 !== firstDanger && next?.kind !== 'heading' && next?.kind !== 'info') bare += 1;
  });
  if (bare > MAX_BARE_RULES) problems.push(`${bare} bare rules between sections (at most ${MAX_BARE_RULES}): name the sections with headings or fold them into groups`);
  return problems;
}

/** A ContextMenu's items as the shape sees them (after the menu's own normalizing). */
export function contextMenuShape(items: ContextMenuItem[]): MenuShapeRow[] {
  const rows: MenuShapeRow[] = [];
  let lastPillGroup: string | null = null;
  for (const item of items) {
    const label = typeof item.label === 'string' ? item.label : undefined;
    if (item.divider) { rows.push({ kind: 'divider' }); lastPillGroup = null; continue; }
    if (item.section) { rows.push({ kind: 'heading', label }); lastPillGroup = null; continue; }
    if (item.info) { rows.push({ kind: 'info', label }); lastPillGroup = null; continue; }
    // A run of pills of one group is ONE row (the Pinned row).
    if (item.pill) {
      if (item.pill.group === lastPillGroup) continue;
      lastPillGroup = item.pill.group;
      rows.push({ kind: 'item', label: item.pill.label });
      continue;
    }
    lastPillGroup = null;
    rows.push({ kind: item.value !== undefined ? 'group' : 'item', danger: !!item.danger, label });
  }
  return rows;
}
