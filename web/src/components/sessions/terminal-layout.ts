/**
 * The layout of a session's terminals: tabs, and the panes split inside a tab.
 *
 * Each terminal is a slot (1 to MAX_TERMINAL_SLOTS, `@open-walnut/terminal-key`),
 * its own dtach session on the host. A tab shows one to MAX_PANES_PER_TAB of
 * them, split right or down as a tree (a pane split right, then the right one
 * split down). New slots come from the server (`terminal:reserve`), so two
 * windows of one session never take the same one. The layout
 * is per session and kept in localStorage, so a reload, a reconnect or a server
 * restart puts the same tabs back and each pane reattaches its own shell.
 *
 * Pure: every change returns a new layout, so the order rules are tested without
 * a browser (tests/web/terminal-layout.test.ts).
 */
import { MAX_TERMINAL_SLOTS, isTerminalSlot } from '@open-walnut/terminal-key';

export const MAX_PANES_PER_TAB = 4;

/** 'row': panes side by side (split right); 'col': stacked (split down). */
export type SplitDir = 'row' | 'col';

/**
 * How a tab's panes are split: a terminal, or a row / column of parts, each a
 * terminal or a split of its own (a pane split right, then the right one split
 * down, is a row of [1, column of [3, 4]]).
 */
export type PaneNode = { slot: number } | { dir: SplitDir; children: PaneNode[] };

export interface TerminalTab {
  id: string;
  root: PaneNode;
  /** The tab's terminals in reading order (kept in step with `root`). */
  slots: number[];
  /** The pane that had the focus last in this tab. */
  focus: number;
}

export interface TerminalLayout {
  tabs: TerminalTab[];
  /** The tab on screen. */
  active: string;
}

const tabId = (slot: number) => `tab${slot}`;

export function isPaneLeaf(node: PaneNode): node is { slot: number } {
  return 'slot' in node;
}

export function nodeSlots(node: PaneNode): number[] {
  return isPaneLeaf(node) ? [node.slot] : node.children.flatMap(nodeSlots);
}

function makeTab(id: string, root: PaneNode, focus: number): TerminalTab {
  const slots = nodeSlots(root);
  return { id, root, slots, focus: slots.includes(focus) ? focus : slots[0]! };
}

function newTabId(layout: TerminalLayout, slot: number): string {
  let id = tabId(slot);
  while (layout.tabs.some((t) => t.id === id)) id = `${id}x`;
  return id;
}

export function initialLayout(slot = 1): TerminalLayout {
  return { tabs: [makeTab(tabId(slot), { slot }, slot)], active: tabId(slot) };
}

export function allSlots(layout: TerminalLayout): number[] {
  return layout.tabs.flatMap((t) => t.slots);
}

/** The lowest slot no tab uses, or null when every slot is taken. */
export function freeSlot(layout: TerminalLayout): number | null {
  const used = new Set(allSlots(layout));
  for (let s = 1; s <= MAX_TERMINAL_SLOTS; s++) if (!used.has(s)) return s;
  return null;
}

export function activeTab(layout: TerminalLayout): TerminalTab | undefined {
  return layout.tabs.find((t) => t.id === layout.active) ?? layout.tabs[0];
}

/** The slot that has the focus: the active tab's focused pane. */
export function focusedSlot(layout: TerminalLayout): number | null {
  const tab = activeTab(layout);
  return tab ? (tab.slots.includes(tab.focus) ? tab.focus : tab.slots[0] ?? null) : null;
}

export function tabOfSlot(layout: TerminalLayout, slot: number): TerminalTab | undefined {
  return layout.tabs.find((t) => t.slots.includes(slot));
}

export function canAddTerminal(layout: TerminalLayout): boolean {
  return freeSlot(layout) !== null;
}

export function canSplit(layout: TerminalLayout): boolean {
  const tab = activeTab(layout);
  return !!tab && tab.slots.length < MAX_PANES_PER_TAB && canAddTerminal(layout);
}

/** `slot` when it is a slot no tab uses (a slot the server reserved), else the lowest free one. */
function pickSlot(layout: TerminalLayout, slot?: number): number | null {
  if (slot !== undefined && isTerminalSlot(slot) && !allSlots(layout).includes(slot)) return slot;
  return freeSlot(layout);
}

/** A new tab with a new terminal (in `slot` when given), shown and focused. Unchanged when every slot is taken. */
export function addTab(layout: TerminalLayout, slot?: number): TerminalLayout {
  const s = pickSlot(layout, slot);
  if (s === null) return layout;
  const id = newTabId(layout, s);
  return { tabs: [...layout.tabs, makeTab(id, { slot: s }, s)], active: id };
}

/**
 * Halve `target`: it and `slot` share its box, side by side or stacked. Only
 * that pane changes size; the others keep theirs.
 */
function splitNode(node: PaneNode, target: number, dir: SplitDir, slot: number): PaneNode {
  if (isPaneLeaf(node)) return node.slot === target ? { dir, children: [node, { slot }] } : node;
  return { ...node, children: node.children.map((c) => splitNode(c, target, dir, slot)) };
}

/**
 * A new terminal beside the focused one, in the active tab, focused: right of it
 * ('row') or under it ('col'). Only the focused pane is split, in half; the
 * others keep their place and size.
 */
export function splitActive(layout: TerminalLayout, dir: SplitDir, slot?: number): TerminalLayout {
  const tab = activeTab(layout);
  const s = pickSlot(layout, slot);
  if (!tab || s === null || tab.slots.length >= MAX_PANES_PER_TAB) return layout;
  const target = focusedSlot(layout) ?? tab.slots[tab.slots.length - 1]!;
  const root = splitNode(tab.root, target, dir, s);
  return { ...layout, tabs: layout.tabs.map((t) => (t.id === tab.id ? makeTab(t.id, root, s) : t)) };
}

/** Where a pane sits in its tab, as fractions of the tab's box (0 to 1). */
export interface PaneRect { slot: number; x: number; y: number; w: number; h: number }

/**
 * Every pane's box in a tab: each split shares its box equally among its parts.
 * The panes are laid out flat by these boxes (not nested elements), so a split
 * that regroups the tree never moves a pane to another parent: its xterm stays.
 */
export function paneRects(root: PaneNode): PaneRect[] {
  const out: PaneRect[] = [];
  const walk = (node: PaneNode, x: number, y: number, w: number, h: number) => {
    if (isPaneLeaf(node)) { out.push({ slot: node.slot, x, y, w, h }); return; }
    const n = node.children.length;
    node.children.forEach((c, i) => {
      if (node.dir === 'row') walk(c, x + (w * i) / n, y, w / n, h);
      else walk(c, x, y + (h * i) / n, w, h / n);
    });
  };
  walk(root, 0, 0, 1, 1);
  return out;
}

export function focusSlot(layout: TerminalLayout, slot: number): TerminalLayout {
  const tab = tabOfSlot(layout, slot);
  if (!tab) return layout;
  if (layout.active === tab.id && tab.focus === slot) return layout;
  return { active: tab.id, tabs: layout.tabs.map((t) => (t.id === tab.id ? { ...t, focus: slot } : t)) };
}

export function activateTab(layout: TerminalLayout, id: string): TerminalLayout {
  return layout.tabs.some((t) => t.id === id) && layout.active !== id ? { ...layout, active: id } : layout;
}

/** The tree without `slot`; a split left with one part becomes that part. */
function removeNode(node: PaneNode, slot: number): PaneNode | null {
  if (isPaneLeaf(node)) return node.slot === slot ? null : node;
  const children = node.children.map((c) => removeNode(c, slot)).filter((c): c is PaneNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children };
}

/**
 * Take a terminal out. Its tab keeps the others (focus to the pane before it);
 * an emptied tab goes, and the tab after it (else before) is shown. No tabs left
 * means no terminals: the caller closes the view.
 */
export function removeSlot(layout: TerminalLayout, slot: number): TerminalLayout {
  const tab = tabOfSlot(layout, slot);
  if (!tab) return layout;
  const root = removeNode(tab.root, slot);
  if (root) {
    const at = tab.slots.indexOf(slot);
    const rest = tab.slots.filter((s) => s !== slot);
    const focus = tab.focus === slot ? rest[Math.max(0, at - 1)]! : tab.focus;
    return { ...layout, tabs: layout.tabs.map((t) => (t.id === tab.id ? makeTab(t.id, root, focus) : t)) };
  }
  const index = layout.tabs.findIndex((t) => t.id === tab.id);
  const tabs = layout.tabs.filter((t) => t.id !== tab.id);
  if (tabs.length === 0) return { tabs: [], active: '' };
  const active = layout.active === tab.id ? tabs[Math.min(index, tabs.length - 1)]!.id : layout.active;
  return { tabs, active };
}

/**
 * Bring the layout in line with the terminals the host runs now (`terminal:list`).
 * A slot running on the host that no tab shows (opened on another device, or
 * before this page's storage was lost) gets a tab of its own. A slot the layout
 * held when the list was asked for (`asked`) that no longer runs (its shell
 * exited, a plain shell died with the server) goes. A slot added after the list
 * was asked for stays: its open may still be on the way. Never leaves the layout
 * empty: with nothing running it is one fresh terminal.
 */
export function reconcileLayout(layout: TerminalLayout, running: readonly number[], asked: readonly number[]): TerminalLayout {
  const live = new Set(running.filter(isTerminalSlot));
  const askedSet = new Set(asked);
  let next = layout;
  for (const slot of allSlots(layout)) {
    if (askedSet.has(slot) && !live.has(slot)) next = removeSlot(next, slot);
  }
  const shown = new Set(allSlots(next));
  for (const slot of [...live].sort((a, b) => a - b)) {
    if (shown.has(slot)) continue;
    const id = newTabId(next, slot);
    next = { tabs: [...next.tabs, makeTab(id, { slot }, slot)], active: next.tabs.length === 0 ? id : next.active };
  }
  if (next.tabs.length === 0) return initialLayout(asked.length > 0 ? Math.min(...asked) : 1);
  if (!next.tabs.some((t) => t.id === next.active)) next = { ...next, active: next.tabs[0]!.id };
  return next;
}

/**
 * A stored split tree, its slots claimed in `seen` (a slot two places claim
 * goes from the second), or null when nothing valid is left.
 */
function parseNode(raw: unknown, seen: Set<number>, depth: number): PaneNode | null {
  if (!raw || typeof raw !== 'object' || depth > 6) return null;
  const o = raw as { slot?: unknown; dir?: unknown; children?: unknown };
  if (o.slot !== undefined) {
    if (!isTerminalSlot(o.slot) || seen.has(o.slot)) return null;
    seen.add(o.slot);
    return { slot: o.slot };
  }
  if (!Array.isArray(o.children)) return null;
  const children = o.children.map((c) => parseNode(c, seen, depth + 1)).filter((c): c is PaneNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { dir: o.dir === 'col' ? 'col' : 'row', children };
}

/** The tree with only the terminals in `keep`; a split left with one part becomes that part. */
function trimNode(node: PaneNode, keep: Set<number>): PaneNode | null {
  if (isPaneLeaf(node)) return keep.has(node.slot) ? node : null;
  const children = node.children.map((c) => trimNode(c, keep)).filter((c): c is PaneNode => c !== null);
  if (children.length === 0) return null;
  return children.length === 1 ? children[0]! : { ...node, children };
}

/**
 * A stored layout, or null when it is missing or not one (a stale shape, a hand
 * edit). A layout kept before tabs had a split tree (`slots` and one `dir`)
 * reads as a split of that direction.
 */
export function parseLayout(raw: unknown): TerminalLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { tabs?: unknown; active?: unknown };
  if (!Array.isArray(o.tabs) || typeof o.active !== 'string') return null;
  const seen = new Set<number>();
  const tabs: TerminalTab[] = [];
  for (const t of o.tabs as unknown[]) {
    if (!t || typeof t !== 'object') return null;
    const tab = t as { id?: unknown; root?: unknown; slots?: unknown; dir?: unknown; focus?: unknown };
    if (typeof tab.id !== 'string') return null;
    let rawRoot: unknown = tab.root;
    if (rawRoot === undefined) {
      if (!Array.isArray(tab.slots)) return null;
      rawRoot = { dir: tab.dir === 'col' ? 'col' : 'row', children: tab.slots.map((slot) => ({ slot })) };
    }
    // Claimed for later tabs only once kept: a slot trimmed off here may show in another tab.
    let root = parseNode(rawRoot, new Set(seen), 0);
    if (!root) continue;
    const slots = nodeSlots(root);
    if (slots.length > MAX_PANES_PER_TAB) root = trimNode(root, new Set(slots.slice(0, MAX_PANES_PER_TAB)))!;
    const made = makeTab(tab.id, root, typeof tab.focus === 'number' ? tab.focus : -1);
    made.slots.forEach((s) => seen.add(s));
    tabs.push(made);
  }
  if (tabs.length === 0) return null;
  return { tabs, active: tabs.some((t) => t.id === o.active) ? o.active : tabs[0]!.id };
}

// An `open-walnut-` key: the browser's layout prefs are mirrored to the server
// (ui-prefs-sync), so another browser or device opens the same tabs and splits.
const storageKey = (sessionId: string) => `open-walnut-terminal-layout:${sessionId}`;
// Where the layout was kept before it synced: read once, then moved.
const oldStorageKey = (sessionId: string) => `walnut.terminal-layout.${sessionId}`;

export function loadLayout(sessionId: string): TerminalLayout | null {
  try {
    const raw = localStorage.getItem(storageKey(sessionId)) ?? localStorage.getItem(oldStorageKey(sessionId));
    localStorage.removeItem(oldStorageKey(sessionId));
    return raw ? parseLayout(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveLayout(sessionId: string, layout: TerminalLayout): void {
  try {
    if (layout.tabs.length === 0) localStorage.removeItem(storageKey(sessionId));
    else localStorage.setItem(storageKey(sessionId), JSON.stringify(layout));
  } catch { /* storage full or unavailable: the layout lives for this page only */ }
}
