/**
 * What a session panel's header shows at the width it has.
 *
 * A narrow column (three columns side by side, or the Mac app zoomed in) used to
 * wrap the tool row one chip per line, draw the window buttons over the chip
 * text, and run the title row's pills past the panel edge over the phase circle
 * (2026-10-02 report). Both rows now keep ONE line, the composer controls row's
 * way (composer-controls-fit.ts): the decision is a pure function of the room
 * and of every item's natural width, never of what is currently shown, so a
 * resize cannot make it oscillate.
 *
 * Tool row: the view chips leave in priority order into the row's own "..."
 * menu (Terminal before Board before Files before Changed; Fork and Plan leave
 * last). They follow a STRICT priority prefix, so a narrower row never shows a
 * chip that a wider one hid. The two movable window buttons (Locate, Open in new
 * tab) are small and come after: they take whatever room the chips leave, each
 * if it fits, so a wide chip that just missed the cut never leaves a
 * button-sized hole beside the "..." menu (2026-10-04: a hidden Heavy pill,
 * 90px wide, kept 60px of empty row and three buttons in the menu). The
 * activity time just hides (the kebab shows it) and takes what is left last. Pin, Expand and Close never
 * leave: a cramped column is the moment to go full screen, and the user asked for
 * Expand and Close (2026-10-03) and for Pin (2026-10-04) to stay whatever the
 * width. Nothing from this row goes into the title row's kebab, which is the
 * task's menu.
 *
 * Title row: the title keeps TITLE_MIN_WIDTH for its text. The pills beside it
 * step down together: full words → the status badge shrinks to its dot → every
 * pill shows one letter (TRIGGER → T, WORKER → W, LEADER → L, CRON → C; the
 * counts go, the hover text keeps them). Only when even the letters do not fit
 * are pills hidden, lowest priority first.
 */

export type ToolItemKind = 'chip' | 'window' | 'info' | 'fixed';

export interface ToolRowItem {
  id: string;
  kind: ToolItemKind;
  /** 1 leaves last; higher leaves sooner. Ignored for `fixed`. */
  priority: number;
  /** Natural width in px; undefined before the first measurement. */
  width?: number;
}

export interface ToolRowFit {
  /** Ids shown on the row, in the caller's order (fixed items included). */
  visible: string[];
  /** Hidden chips and window buttons, listed in the "..." menu, in the caller's order. */
  inMore: string[];
  /** Hidden info items (the time); nowhere, their facts live elsewhere. */
  dropped: string[];
}

export interface ToolRowOptions {
  /** Gap between chips (`.session-meta-row-2-chips`). */
  chipGap: number;
  /** Gap between window buttons (`.session-panel-window-controls`). */
  windowGap: number;
  /** The least room kept between the two groups (`.session-meta-row-2`). */
  groupGap: number;
  /** The "..." button, priced only while a chip or a window button is hidden. */
  moreWidth: number;
}

/** A chip that has never been measured: one short chip. */
export const ASSUMED_TOOL_WIDTH = 44;
/** A window button that has not been measured yet (Locate waits for the task to load): a 20px ghost button
 *  with a 14px icon and 5px of padding each side. Priced like a chip it would cost 44 instead of 24. */
export const ASSUMED_WINDOW_WIDTH = 24;

const widthOf = (item: ToolRowItem) => {
  if (item.width != null && item.width > 0) return item.width;
  return item.kind === 'window' || item.kind === 'fixed' ? ASSUMED_WINDOW_WIDTH : ASSUMED_TOOL_WIDTH;
};

/** The row's cost with `items` on it; the "..." button (in the chip group) is added only when `moreShown`. */
export function toolRowWidth(items: ToolRowItem[], moreShown: boolean, opts: ToolRowOptions): number {
  const left = items.filter((i) => i.kind === 'chip' || i.kind === 'info');
  const right = items.filter((i) => i.kind === 'window' || i.kind === 'fixed');
  const leftSlots = left.length + (moreShown ? 1 : 0);
  const leftWidth = left.reduce((sum, i) => sum + widthOf(i), 0)
    + (moreShown ? opts.moreWidth : 0)
    + Math.max(0, leftSlots - 1) * opts.chipGap;
  const rightWidth = right.reduce((sum, i) => sum + widthOf(i), 0) + Math.max(0, right.length - 1) * opts.windowGap;
  const groups = (leftSlots > 0 ? 1 : 0) + (right.length > 0 ? 1 : 0);
  return leftWidth + rightWidth + (groups === 2 ? opts.groupGap : 0);
}

export function fitToolRow(items: ToolRowItem[], availableWidth: number, opts: ToolRowOptions): ToolRowFit {
  const order = items.map((i) => i.id);
  const byOrder = (set: Set<string>) => order.filter((id) => set.has(id));
  const all = { visible: [...order], inMore: [], dropped: [] };
  // A row that has not been laid out reports no width; the hooks skip those
  // frames, so a non-positive width here is a real "no room".
  const room = Math.max(1, availableWidth);
  if (toolRowWidth(items, false, opts) <= room) return all;

  const fixed = items.filter((i) => i.kind === 'fixed');
  const movable = items.filter((i) => i.kind !== 'fixed').sort((a, b) => a.priority - b.priority);
  // What the "..." menu lists, chips before window buttons whatever their numbers; the time is listed nowhere.
  const listed = [...movable.filter((i) => i.kind === 'chip'), ...movable.filter((i) => i.kind === 'window')];
  const info = movable.filter((i) => i.kind === 'info');
  const fits = (set: ToolRowItem[], moreShown: boolean) => toolRowWidth(set, moreShown, opts) <= room;
  const kept: ToolRowItem[] = [...fixed];
  if (fits([...fixed, ...listed], false)) {
    // Only the time is out: nothing goes into the menu, so the row pays for no "..." button.
    kept.push(...listed);
  } else {
    // Something goes into the menu, so the row pays for its button. The top item
    // stays even where it does not fit: a row with only a "..." button hides the
    // one thing people reach for most. The chips follow in priority order up to
    // the FIRST that does not fit: the order is the whole contract ("Terminal
    // leaves before Board"), and a strict prefix is the one rule under which a
    // narrower row never shows a chip a wider one hid. The window buttons are
    // small and all the same size: each takes the room the chips left if it
    // fits, so a wide chip that just missed the cut never leaves a button-sized
    // hole beside the "..." menu (2026-10-04).
    if (listed.length > 0) kept.push(listed[0]!);
    const rest = listed.slice(1);
    let chipsOpen = true;
    for (const item of rest) {
      if (item.kind === 'chip' && !chipsOpen) continue;
      if (fits([...kept, item], true)) kept.push(item);
      else if (item.kind === 'chip') chipsOpen = false;
    }
  }
  // The time has the least claim on the room: it takes what is left, and nothing lists it. Once a
  // chip is in the menu the row is cramped, and the room that chip left goes to the buttons, so the
  // time does not come back as the row narrows.
  const moreShown = listed.some((c) => !kept.includes(c));
  if (!moreShown) for (const item of info) if (fits([...kept, item], false)) kept.push(item);
  const keptIds = new Set(kept.map((i) => i.id));
  const hidden = items.filter((i) => !keptIds.has(i.id));
  return {
    visible: byOrder(keptIds),
    inMore: byOrder(new Set(hidden.filter((i) => i.kind === 'chip' || i.kind === 'window').map((i) => i.id))),
    dropped: byOrder(new Set(hidden.filter((i) => i.kind === 'info').map((i) => i.id))),
  };
}

/** How the title row's right cluster reads. */
export type TitleMetaLevel = 'full' | 'dot' | 'letters';

export type TitleMetaKind = 'embedded' | 'cron' | 'trigger' | 'worker' | 'leader' | 'status' | 'kebab' | 'other';

export interface TitleMetaItem {
  id: string;
  kind: TitleMetaKind;
  /** Natural width with its full text; undefined before the first measurement. */
  fullWidth?: number;
  /** The status badge as a dot; a pill as one letter. Undefined until measured at that level. */
  shortWidth?: number;
}

export interface TitleMetaFit {
  level: TitleMetaLevel;
  /** Pills hidden because even their letters did not fit, in the caller's order. */
  hidden: string[];
}

/** The room the title text keeps while the pills still have a shorter form to
 *  fall back to ("Pulse orph…" at 13px). */
export const TITLE_MIN_WIDTH = 80;
/** The floor below which a pill is removed outright rather than squeeze the title
 *  further: between the two, letters stay and the title gives up the difference
 *  (2026-10-02: at 240px the letters missed TITLE_MIN_WIDTH by a few pixels and
 *  two pills vanished for it; "Pulse o…" beside T W L reads better than
 *  "Pulse orph…" beside W L). */
export const TITLE_FLOOR_WIDTH = 48;
/** A one-letter pill before it has been measured (15px tall, 5px padding, one capital). */
export const ASSUMED_LETTER_WIDTH = 18;
/** The status badge as a dot before it has been measured. */
export const ASSUMED_DOT_WIDTH = 16;

/** Which pills give way, and in what order, when even their letters overflow. */
const PILL_DROP_ORDER: TitleMetaKind[] = ['embedded', 'cron', 'trigger', 'worker', 'leader'];

const isPill = (item: TitleMetaItem) => PILL_DROP_ORDER.includes(item.kind);
const fullOf = (item: TitleMetaItem) => (item.fullWidth == null || item.fullWidth <= 0 ? ASSUMED_TOOL_WIDTH : item.fullWidth);
const shortOf = (item: TitleMetaItem) => {
  if (item.shortWidth != null && item.shortWidth > 0) return item.shortWidth;
  return item.kind === 'status' ? ASSUMED_DOT_WIDTH : isPill(item) ? ASSUMED_LETTER_WIDTH : fullOf(item);
};

function metaWidth(items: TitleMetaItem[], level: TitleMetaLevel, gap: number): number {
  const each = (item: TitleMetaItem) => {
    if (level === 'full') return fullOf(item);
    if (item.kind === 'status') return shortOf(item);
    if (level === 'letters' && isPill(item)) return shortOf(item);
    return fullOf(item);
  };
  return items.reduce((sum, i) => sum + each(i), 0) + Math.max(0, items.length - 1) * gap;
}

export interface TitleMetaFitOptions {
  /** A kind kept on the row whatever the room (a kebab row is about to open its flyout). */
  pinned?: TitleMetaKind | string | null;
  /** Extra room the letters may take from the title before a pill is removed
   *  (TITLE_MIN_WIDTH - TITLE_FLOOR_WIDTH in the header). */
  dropSlack?: number;
}

/**
 * `availableWidth` is the room the cluster may take once the title has
 * TITLE_MIN_WIDTH: row width minus the title's fixed companions (dot, phase
 * circle, the Ask slot's menu button, the thread mode pill) and minus the title's
 * reserve.
 */
export function fitTitleMeta(items: TitleMetaItem[], availableWidth: number, gap: number, options: TitleMetaFitOptions = {}): TitleMetaFit {
  if (items.length === 0) return { level: 'full', hidden: [] };
  // The title's companions alone can exceed a very narrow row; that is "no
  // room", never "unknown" (the hooks skip rows that have no width yet).
  const room = Math.max(1, availableWidth);
  if (metaWidth(items, 'full', gap) <= room) return { level: 'full', hidden: [] };
  if (items.some((i) => i.kind === 'status') && metaWidth(items, 'dot', gap) <= room) return { level: 'dot', hidden: [] };
  // Letters may squeeze the title down to its floor before anything is removed.
  const roomForLetters = room + Math.max(0, options.dropSlack ?? 0);
  if (metaWidth(items, 'letters', gap) <= roomForLetters) return { level: 'letters', hidden: [] };
  // Letters still overflow: pills go, lowest priority first, until the rest fit.
  // A pinned kind (the one a kebab row is about to open, so its flyout has an
  // anchor) stays whatever the room.
  const kept = [...items];
  const hidden: string[] = [];
  for (const kind of PILL_DROP_ORDER) {
    if (kind === options.pinned) continue;
    for (const item of items.filter((i) => i.kind === kind)) {
      if (metaWidth(kept, 'letters', gap) <= roomForLetters) break;
      kept.splice(kept.indexOf(item), 1);
      hidden.push(item.id);
    }
  }
  return { level: 'letters', hidden: items.filter((i) => hidden.includes(i.id)).map((i) => i.id) };
}

/** The element a pill kind renders in the title row (for the kebab's proxy rows). */
export const TITLE_PILL_SELECTOR: Record<string, string> = {
  embedded: '.session-panel-badge[data-header-pill="embedded"]',
  cron: '.session-cron-pill',
  trigger: '.task-trigger-pill',
  worker: '.todo-item-subtask-pill',
  leader: '.todo-item-leader-pill',
};

/** The title row's cluster, classified by what each child IS (its component's class). */
export function classifyTitleMetaChild(classList: { contains: (name: string) => boolean }, dataset: { headerPill?: string }): TitleMetaKind {
  if (dataset.headerPill === 'embedded') return 'embedded';
  if (classList.contains('session-cron-pill')) return 'cron';
  if (classList.contains('task-trigger-pill')) return 'trigger';
  if (classList.contains('todo-item-subtask-pill')) return 'worker';
  if (classList.contains('todo-item-leader-pill')) return 'leader';
  if (classList.contains('session-panel-badge')) return 'status';
  if (classList.contains('task-quick-actions')) return 'kebab';
  return 'other';
}
