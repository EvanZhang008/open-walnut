/**
 * The panels beside the Org page, as a strip of columns: the same column model as Home's
 * session columns (pages/sessionColumns.ts), with a panel count of one.
 *
 * 2026-10-31, the user: "a lock icon in the org section ... it just lock it in the org
 * section, and second one come it will open next to it". So the strip holds ONE free panel
 * (what `?open=` names: a link, a click, a phone's Back still drive it) plus every panel the
 * user locked; opening another task replaces the free panel and leaves the pins standing,
 * the way a pin on Home works with a panel count of one (panelBudget grants the free slot
 * beside the pins). Slot ids are the `?open=` strings, `task:<id>` / `session:<id>`. The
 * strip is a layout record field (`orgColumns`), so the pins survive a restart.
 *
 * Each pin belongs to the node it was locked under and stands only beside that node (2026-11-16,
 * the user: "the page I lock shows on every VP ... I locked it under this VP, it should only show
 * under this VP"): the record keeps every node's pins in one list, each slot naming its `node`.
 */
import type { Task } from '@open-walnut/core';
import { removeSessionColumn, replaceSessionColumn, toggleLockSlot, type SessionSlot } from '@/pages/sessionColumns';
import { isPlaceholderColumnId } from '@/utils/column-ids';
import { shownText, storedView, viewKey, writeView } from '@/utils/view-memory';
import { isStringArray } from '@/hooks/usePersistentState';

/** A pin of the Org page: a locked slot and the node (`ChannelRow.key`) it was locked under. */
export interface OrgPin extends SessionSlot { node?: string }

/** The pins that stand beside `node`, in their order. */
export function pinsOfNode(pins: readonly OrgPin[], node: string): OrgPin[] {
  return pins.filter((p) => p.node === node);
}

/**
 * Every pin with `node`'s replaced by `next`, where `node`'s stood (at the end when it had none): the
 * other nodes' stay as they are, so switching between nodes rewrites nothing.
 */
export function setNodePins(pins: readonly OrgPin[], node: string, next: readonly SessionSlot[]): OrgPin[] {
  const mine = next.map((s) => ({ id: s.id, locked: s.locked, node }));
  const rest = pins.filter((p) => p.node !== node);
  // Every pin before the node's first is another node's, so its index in `rest` is the same.
  const at = pins.findIndex((p) => p.node === node);
  const cut = at === -1 ? rest.length : at;
  return [...rest.slice(0, cut), ...mine, ...rest.slice(cut)];
}

/**
 * Pins whose node is unknown go to the node they belong to: one saved before pins had a node, or
 * locked under a node the page no longer has (a project renamed, a VP or a router removed), which
 * nothing could show or unlock. Each goes to the row that holds its task (`ownerOf`, the row the
 * list hangs its lock under), else `fallback` (the node selected now). One pin per node and id: two
 * windows, or an older build, can leave the same panel saved twice. Returns `pins` itself when
 * nothing changes.
 */
export function adoptLegacyPins(
  pins: readonly OrgPin[],
  ownerOf: (id: string) => string | undefined,
  fallback: string,
  known: (node: string) => boolean = () => true,
): readonly OrgPin[] {
  const seen = new Set<string>();
  let changed = false;
  const out: OrgPin[] = [];
  for (const p of pins) {
    const keep = !!p.node && known(p.node);
    const node = keep ? p.node! : ownerOf(p.id) ?? fallback;
    const key = `${node}\u0000${p.id}`;
    if (!keep) changed = true;
    if (seen.has(key)) { changed = true; continue; }
    seen.add(key);
    out.push(keep ? p : { ...p, node });
  }
  return changed ? out : pins;
}

/** Two slot ids that show the same session (`task:<id>` of a task whose session is `session:<sid>`). */
export type SameSession = (a: string, b: string) => boolean;

/** Find the slot that already shows `id` (itself, or another id for the same session). */
function slotFor(cols: readonly SessionSlot[], id: string, same: SameSession): SessionSlot | undefined {
  return cols.find((c) => c.id === id) ?? cols.find((c) => same(c.id, id));
}

/**
 * The strip after `?open=` moved from `prev` to `next`.
 *  - next set: it is the one free panel, leftmost, beside the pins (a pin it names stays where
 *    it is, under the URL's id). Every other free panel goes: the page shows one free panel.
 *  - next gone (× on the free panel, another node picked, Back): the panel `prev` named goes,
 *    unless it is locked.
 */
export function orgStripOnOpen(
  cols: readonly SessionSlot[],
  prev: string | null,
  next: string | null,
  same: SameSession = () => false,
): SessionSlot[] {
  let out = [...cols];
  if (next) {
    const shown = slotFor(out, next, same);
    // A pin keeps the id it was pinned under (a task stays pinned as the task, whichever
    // session it runs next); a free panel takes the URL's id.
    if (shown?.locked) return out.filter((c) => c.locked);
    if (shown && shown.id !== next) out = replaceSessionColumn(out, shown.id, next);
    const pins = out.filter((c) => c.locked);
    return [{ id: next, locked: false }, ...pins];
  }
  if (prev) {
    const shown = slotFor(out, prev, same);
    if (shown && !shown.locked) out = removeSessionColumn(out, shown.id);
  }
  return out;
}

/**
 * One panel per session: two slots that show the same session (a `task:` and a `session:` id,
 * known only once the tasks have loaded) become one, locked when either was, under the id the
 * URL opens when it is one of them, else the first. Returns `cols` itself when nothing merges.
 */
export function orgStripDedupe(cols: readonly SessionSlot[], same: SameSession, open: string | null): readonly SessionSlot[] {
  const out: SessionSlot[] = [];
  let merged = false;
  for (const c of cols) {
    const at = out.findIndex((o) => o.id !== c.id && same(o.id, c.id));
    if (at === -1) { out.push(c); continue; }
    merged = true;
    const o = out[at];
    out[at] = { id: c.id === open ? c.id : o.id, locked: o.locked || c.locked };
  }
  return merged ? out : cols;
}

/** Lock or unlock one panel (a lock sends it to the pins on the right, as on Home). */
export function orgStripToggleLock(cols: readonly SessionSlot[], id: string): SessionSlot[] {
  return toggleLockSlot([...cols], id);
}

/**
 * What the strip shows: the panel `?open=` names, leftmost, beside the pins (one per session).
 * The page keeps only the pins as state and works this out on every render, never a strip
 * state that follows the URL: an update made while React rendered a new URL went away with a
 * render React threw away, and the free panel stayed on screen beside the pin the URL now
 * named (2026-10-31, caught by tests/e2e/browser/layout-record-restart.spec.ts, about 1 run in 5).
 * Picking another node clears `?open=`, so its free panel goes with it and the pins stay.
 */
export function orgStripView(pins: readonly SessionSlot[], open: string | null, same: SameSession = () => false): SessionSlot[] {
  const locked = pins.filter((c) => c.locked);
  return orgStripOnOpen(orgStripDedupe(locked, same, open), null, open, same);
}

/**
 * The panels locked on Home that belong to one node of the Org page, as its locked panels (2026-11-04,
 * the user, on a VP: "the lock view is not there, the lock should always show for that vp"): in
 * Home's order, each a `session:<id>` / `task:<id>` slot, the node's own chat and the ones taken off
 * here (`off`) left out. `rowKeyOf` places a task under its row (org-task-tabs taskRowKey).
 */
export function homeLocksFor(
  rowKey: string,
  homeSlots: readonly { id: string; locked?: boolean }[],
  tasks: readonly Task[],
  rowKeyOf: (t: Task) => string | undefined,
  off: ReadonlySet<string> = new Set(),
): SessionSlot[] {
  const bySession = new Map<string, Task>();
  const byId = new Map<string, Task>();
  for (const t of tasks) {
    byId.set(t.id, t);
    for (const sid of [t.session_id, t.exec_session_id, t.plan_session_id, ...(t.session_ids ?? []), ...(t.legacy_session_ids ?? [])]) {
      if (sid && !bySession.has(sid)) bySession.set(sid, t);
    }
  }
  const out: SessionSlot[] = [];
  for (const s of homeSlots) {
    if (!s.locked || isPlaceholderColumnId(s.id)) continue;
    const task = s.id.startsWith('task:') ? byId.get(s.id.slice(5)) : bySession.get(s.id.startsWith('session:') ? s.id.slice(8) : s.id);
    if (!task || task.org_role || task.plugin_only || rowKeyOf(task) !== rowKey) continue;
    const id = s.id.startsWith('task:') || s.id.startsWith('session:') ? s.id : `session:${s.id}`;
    if (off.has(id) || out.some((c) => c.id === id)) continue;
    out.push({ id, locked: true });
  }
  return out;
}

/** The Org page's view name for the Home locks taken off it (OrgPage homeOff). */
export const HOME_OFF_VIEW = 'homeLocksOff';
/** The takings-off kept, newest last: one Home closed since never lapses, so the list is capped. */
export const HOME_OFF_MAX = 64;

/**
 * Home's lock button was pressed on `columnId`: a taking-off on the Org page lapses, so a panel
 * locked on Home again (in this browser or any other, the views are synced) stands beside its node
 * again. Unlocking lapses it too, as Home no longer locks it (2026-11-05, round 23: one unlock on
 * the Org page kept it away for good, whatever Home did after).
 */
export function releaseHomeTakeoff(columnId: string): void {
  const id = columnId.startsWith('task:') || columnId.startsWith('session:') ? columnId : `session:${columnId}`;
  const key = viewKey('org', HOME_OFF_VIEW);
  const off = storedView(shownText(key), null, isStringArray) ?? [];
  if (off.includes(id)) writeView(key, null, off.filter((x) => x !== id));
}
