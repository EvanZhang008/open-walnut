/**
 * The question map (the always-visible tree in the timeline's top-left corner):
 * its rows and its shape. Pure, unit tested.
 *
 * The rows are the tree drawer's `All` view without a search (one flatten, one
 * order, one set of titles and statuses), so the map and the drawer can never
 * disagree about what a conversation holds. The shape is decided by the scroll
 * box's own width: a labelled panel in a reserved gutter when the box can spare
 * one, else a rail of marks in the left padding. Both keep every row reachable
 * without hovering anything.
 */
import type { SessionPinnedMessage } from '@/types/session';
import type { ThreadDraftRow, ThreadPendingPage } from '@/components/sessions/thread-ui-contract';
import type { ThreadTree } from '@/utils/thread-tree';
import type { ThreadLiveState, ThreadMetaIndex } from '@/utils/thread-meta';
import { flattenTree, type TreeRow } from '@/utils/thread-tree-rows';
import { SECTIONS_GROUP_KEY, sectionKeyOf } from '@/utils/outline-sections';

export type ThreadMapShape = 'panel' | 'rail';

/** Below this box width the labelled panel would leave the text too little room
 *  (at 640 the text column keeps about 410px), so the map becomes the rail. */
export const MAP_PANEL_MIN_BOX = 640;
export const MAP_PANEL_MIN_W = 176;
export const MAP_PANEL_MAX_W = 260;
/** Vertical pitch of one rail mark. 10px reads as one shape (2026-10-02: at
 *  14px two marks sat apart like two unrelated dashes); the rail is one hit
 *  target, so the marks need no height of their own. */
export const MAP_RAIL_PITCH = 10;

const NO_KEYS: ReadonlySet<string> = new Set<string>();
/** A current key no page can have: nothing is current (no target chosen). */
const NO_PAGE = '\u0000no-page';

export function mapShapeFor(boxWidth: number, collapsed: boolean): ThreadMapShape {
  return !collapsed && boxWidth >= MAP_PANEL_MIN_BOX ? 'panel' : 'rail';
}

/** The panel's width: a quarter of the box, clamped. Whole pixels (the gutter pads by it). */
export function mapPanelWidth(boxWidth: number): number {
  return Math.round(Math.min(MAP_PANEL_MAX_W, Math.max(MAP_PANEL_MIN_W, boxWidth * 0.25)));
}

/** The rail's list over the text: 280px, or less in a box that cannot hold it
 *  (the list starts 4px in and the box clips sideways; 16px keeps it off the
 *  scrollbar). Never under 160px: below that no title reads at all. */
export function mapOverlayWidth(boxWidth: number): number {
  if (boxWidth <= 0) return 280;
  return Math.max(160, Math.min(280, Math.floor(boxWidth - 20)));
}

export interface MapRowsInput {
  tree: ThreadTree;
  index: ThreadMetaIndex;
  pins: readonly SessionPinnedMessage[];
  live?: ReadonlyMap<string, ThreadLiveState>;
  pending?: ThreadPendingPage;
  drafts?: readonly ThreadDraftRow[];
  /** The page on screen, or Conversation Mode's target; null when neither. */
  currentKey: string | null;
  /** Parents whose `<n> done` group the user opened in the map (and
   *  SECTIONS_GROUP_KEY once the sections group is open). */
  doneGroupsOpen: ReadonlySet<string>;
  /** The main conversation's sections (outline-sections.ts), in transcript order. */
  sections?: readonly MapSection[];
}

export interface MapSection { msgId: string; label: string }

export const sectionsGroupText = (n: number): string => `${n} sections`;

/** The sections as one `<n> sections` group closing the main conversation's
 *  rows (folded until opened: the map is about questions, the sections are
 *  one click away), and the root row says it has children. */
function withSections(rows: TreeRow[], sections: readonly MapSection[], open: boolean): TreeRow[] {
  const rootAt = rows.findIndex((r) => r.kind === 'root');
  if (rootAt < 0 || sections.length === 0) return rows;
  const root = rows[rootAt];
  const out = rows.slice();
  out[rootAt] = { ...root, hasChildren: true };
  // After the root's own subtree (the map has no hidden group after it).
  let end = rootAt + 1;
  while (end < out.length && out[end].depth > 0) end += 1;
  const groupId = 'sections';
  const added: TreeRow[] = [{
    id: groupId, kind: 'section-group', key: SECTIONS_GROUP_KEY, depth: 1, parentRowId: root.id, hue: root.hue,
    title: sectionsGroupText(sections.length), hasChildren: true, expanded: open, disclosureDisabled: false,
    matched: true, ancestorOnly: false, current: false, openBelow: 0, groupCount: sections.length,
  }];
  if (open) {
    for (const s of sections) {
      added.push({
        id: `s:${s.msgId}`, kind: 'section', key: root.key, depth: 2, parentRowId: groupId, hue: root.hue,
        title: s.label, tooltip: s.label, msgId: s.msgId, pinKey: sectionKeyOf(s.msgId),
        hasChildren: false, expanded: false, disclosureDisabled: true, matched: true, ancestorOnly: false,
        current: false, openBelow: 0,
      });
    }
  }
  out.splice(end, 0, ...added);
  return out;
}

/** The map's rows: the drawer's All view (root, questions, pins, done groups,
 *  the pending page and drafts). Hidden questions and their pins never appear. */
export function mapRows(input: MapRowsInput): TreeRow[] {
  const rows = flattenTree(input.tree, input.index, input.pins, input.live, {
    filter: 'all',
    query: '',
    collapsed: NO_KEYS,
    doneGroupsOpen: input.doneGroupsOpen,
    showHidden: false,
    ...(input.pending ? { pending: input.pending } : {}),
    ...(input.drafts ? { drafts: input.drafts } : {}),
    currentKey: input.currentKey ?? NO_PAGE,
  }).rows;
  return input.sections?.length
    ? withSections(rows, input.sections, input.doneGroupsOpen.has(SECTIONS_GROUP_KEY))
    : rows;
}

/** Rows that are a question (or hold one): a pin alone is not. */
const QUESTION_KINDS: ReadonlySet<TreeRow['kind']> = new Set(['thread', 'done-group', 'pending', 'draft']);

/** A map is worth drawing only with a question in it. Pins alone sit under the
 *  main conversation, and a session with only pins keeps the outline it had. */
export function mapHasContent(rows: readonly TreeRow[]): boolean {
  return rows.some((r) => QUESTION_KINDS.has(r.kind));
}

/**
 * Rows on the path from the root to the current page (the current row included):
 * they read in full foreground, the rest in secondary. A pending page counts its
 * parent's path.
 */
export function onPathIds(rows: readonly TreeRow[]): Set<string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Set<string>();
  let row = rows.find((r) => r.current);
  while (row && !out.has(row.id)) {
    out.add(row.id);
    row = row.parentRowId ? byId.get(row.parentRowId) : undefined;
  }
  return out;
}

/**
 * The rail's marks for `room` px of height: every row when they fit, else the
 * first ones plus a `+<n>` mark (which opens the full list). The current row is
 * never cut: when it would fall past the cut it takes the last slot.
 */
export function railMarks<T extends { current: boolean }>(rows: readonly T[], room: number): { marks: T[]; more: number } {
  const fit = Math.max(1, Math.floor(room / MAP_RAIL_PITCH));
  if (rows.length <= fit) return { marks: [...rows], more: 0 };
  const keep = Math.max(1, fit - 1);
  const marks = rows.slice(0, keep);
  const current = rows.findIndex((r) => r.current);
  if (current >= keep) marks[keep - 1] = rows[current];
  return { marks, more: rows.length - keep };
}

/** Roving focus: the next row id for a key, or undefined when the key is not ours. */
export function mapStep(ids: readonly string[], at: string | undefined, key: string): string | undefined {
  if (ids.length === 0) return undefined;
  const i = at ? ids.indexOf(at) : -1;
  switch (key) {
    case 'ArrowDown': return ids[Math.min(ids.length - 1, i + 1)];
    case 'ArrowUp': return ids[Math.max(0, i - 1)];
    case 'Home': return ids[0];
    case 'End': return ids[ids.length - 1];
    default: return undefined;
  }
}
