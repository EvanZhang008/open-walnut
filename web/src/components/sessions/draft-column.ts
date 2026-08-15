/**
 * The draft session column's data model + its launch-memory rules.
 *
 * A draft is an EMPTY session column the user just opened with "+": pure client
 * state (0 bytes server-side) until Start or "Create task for later". This module
 * is the leaf both the panel (DraftSessionPanel) and the owner (MainPage) import,
 * so the row shape and the "which model will this actually launch with" logic have
 * exactly one definition.
 *
 * Every read here is SYNCHRONOUS — the working-dirs MODULE CACHE only
 * (`peekWorkingDirs`), never a fetch: the draft-open path is contractually
 * network-free, so a cold cache means "no remembered config", not "go get it".
 * MainPage warms that cache once on mount and again after each launch.
 */

import { peekWorkingDirs, type WorkingDirEntry } from '@/api/sessions';
import type { QuickStartTaskMeta } from './SessionPathSelector';

/** Prefix of every draft composer's localStorage key — MainPage sweeps stale
 *  `draft:new-session:*` entries with it on mount. */
const DRAFT_COMPOSER_KEY_PREFIX = 'draft:new-session:';

/** The EXACT localStorage key ChatInput persists a draft's text under —
 *  ChatInput uses `draftKey` verbatim (get/set/removeItem all take it raw), so
 *  this IS that key. Exported so the owner can clear it on close ("no trace")
 *  without re-deriving it. */
export function draftComposerKey(draftId: string): string {
  return DRAFT_COMPOSER_KEY_PREFIX + draftId;
}

/** A draft field the background AI parse filled in (✦-badged in the launch bar).
 *  `cwd` only ever comes from an AI-chosen project's `default_cwd`. */
export type DraftAiField =
  'project' | 'cwd' | 'pinTier' | 'priority' | 'dueDate' | 'startDate' | 'endDate';

/** Who put the current `project` on the row — the ownership rule the AI backfill
 *  obeys. 'seed' = a project/tier "+" seeded it, 'user' = an explicit pick (pill
 *  or quick chip), 'ai' = the background parse (overwritable by a later parse).
 *  undefined = nobody, i.e. Inbox. */
export type DraftProjectSource = 'user' | 'seed' | 'ai';

export interface DraftColumn {
  /** `draft:<ts>-<seq>` — also the session-strip column id. */
  id: string;
  /** '' until the user picks one (or the launch memory is empty on a fresh browser). */
  cwd: string;
  /** null = local machine. */
  host: string | null;
  hostLabel?: string;
  /** Project the resulting task/session files under. undefined/'' = Inbox. */
  project?: string;
  /** Provenance of `project`. 'user'/'seed' are FINAL — the AI backfill never
   *  overwrites them; 'ai' (and absent) it may. */
  projectSource?: DraftProjectSource;
  /** Fields the background parse filled. Purely presentational (the ✦ badges) —
   *  ownership decisions read `projectSource` / `metaTouched` / `cwdPinned`, never
   *  this set. */
  aiFields?: ReadonlySet<DraftAiField>;
  meta: QuickStartTaskMeta;
  /** True once the user picked the path explicitly — a later async seed (e.g. a
   *  project's default dir) must not overwrite their choice. */
  cwdPinned?: boolean;
  /** True once the user edited the launch meta (model / engine / tier / star /
   *  priority) in the launch bar or through the picker's footer. While FALSE a cwd
   *  change is free to refresh model+engine from that directory's launch memory;
   *  once TRUE the explicit pick wins and memory never overwrites it. This is the
   *  launch-memory switch — it replaced `cwdPinned` in that role, which turned the
   *  memory off after the FIRST pick and made every later folder change silently
   *  launch with the previous folder's model. */
  metaTouched?: boolean;
  /** The user confirmed a MISSING folder through the picker's "Create folder &
   *  start session in it" row, so the launch must mkdir it first. Carried on the
   *  row (not just inside the picker) because Start reads the draft, not the
   *  picker: without it the launch silently targeted a nonexistent cwd. */
  createCwd?: boolean;
  /** Launch intent. 'fix-walnut' → the server wraps the message in its repair
   *  briefing (and titles/files the task as a repair). Currently set by NO draft
   *  UI (the in-draft chip was removed with the v4 layout — the repair entry point
   *  is the chat pill); the field + its forwarding in handleDraftStart stay so a
   *  future entry point needs no plumbing. */
  intent?: 'fix-walnut';
  /** This draft is BOUND to an existing task (task row ▶ Start on a title-only
   *  task): the launch reuses that task instead of minting a new one, so there is
   *  nothing to "create for later" — it already IS a task. */
  taskId?: string;
  /** Title of the bound task — shown in the header, and used as the first message
   *  when the user hits Start with an empty composer. */
  boundTaskTitle?: string;
  /** Owner-driven "open the folder picker" signal. Bumped (never reset) when a
   *  Start is attempted with no cwd; the panel opens the picker on each change.
   *  A nonce rather than a boolean so a second attempt after the user dismissed
   *  the picker re-opens it. */
  openPickerNonce?: number;
}

/** Merge a directory's remembered launch config into `meta`.
 *
 *  `undefined` CLEARS model/engine back to Auto/Claude rather than leaving the
 *  previous directory's values behind — the same rule as SessionPathSelector's
 *  `withLaunchMemory`, and the reason a folder with no memory can't inherit the
 *  model of whatever folder was selected before it. */
export function applyLaunchMemory(
  meta: QuickStartTaskMeta,
  launch: { model?: string; engine?: 'codex' } | undefined,
): QuickStartTaskMeta {
  if (meta.model === launch?.model && meta.engine === launch?.engine) return meta;
  return { ...meta, model: launch?.model, engine: launch?.engine };
}

/** A directory's remembered launch config from the working-dirs cache.
 *  `undefined` = cold cache, or that directory has no memory. */
function dirLaunchMemory(cwd: string, host: string | null): { model?: string; engine?: 'codex' } | undefined {
  if (!cwd) return undefined;
  return peekWorkingDirs()?.dirs
    .find(d => d.cwd === cwd && (d.host ?? null) === (host ?? null))?.lastLaunch;
}

/** `applyLaunchMemory` for a cwd/host pair. Cold cache → `meta` unchanged.
 *  Callers must check `metaTouched` first — this helper only knows about
 *  directories, not about who last edited the meta. */
export function withDirLaunchMemory(
  meta: QuickStartTaskMeta,
  cwd: string,
  host: string | null,
): QuickStartTaskMeta {
  if (!cwd || !peekWorkingDirs()) return meta;
  return applyLaunchMemory(meta, dirLaunchMemory(cwd, host));
}

/**
 * Does `meta` say something the picked directory's own memory does NOT?
 *
 * The one decidable signal that a confirmed pick carries an EXPLICIT model/engine
 * choice: the folder picker applies a directory's memory itself unless the user
 * touched those controls during that open, so a confirmed meta that disagrees with
 * the directory's memory can only have come from the user. The owner uses it to
 * set `metaTouched`, which stops a later cwd change from refreshing model/engine
 * over that choice. Cold cache / no memory for the dir → `false` (nothing to
 * compare against, and `withDirLaunchMemory` is a no-op there anyway, so nothing
 * can be clobbered either).
 */
export function launchDivergesFromDirMemory(
  meta: QuickStartTaskMeta,
  cwd: string,
  host: string | null,
): boolean {
  if (!peekWorkingDirs()) return false;
  const launch = dirLaunchMemory(cwd, host);
  return meta.model !== launch?.model || meta.engine !== launch?.engine;
}

/** `host::cwd` — the identity of a working dir (the same folder path on two hosts
 *  is two entries), used to dedupe the two chip groups against each other. */
function dirKey(d: { cwd: string; host: string | null }): string {
  return `${d.host ?? '__local__'}::${d.cwd}`;
}

/** How many chips are picked by ABSOLUTE use count vs. by recency. 2+2: five
 *  read as clutter on a draft column (user feedback), four is the scan limit. */
const QUICK_TOP_BY_COUNT = 2;
const QUICK_TOP_BY_RECENT = 2;

/**
 * The launch bar's quick-access folder chips: **top 2 by absolute `count`** (the
 * folders this user works in most, ever) followed by the **2 most recent by
 * `lastUsed`** that aren't already in those two.
 *
 * Why not the server's own ranking: `/api/sessions/working-dirs` returns a single
 * frecency order, in which a folder used twice this morning outranks the one used
 * 300 times over a year — so the chip row churned. Splitting the row into "my
 * folders" + "what I just touched" keeps the first three stable (they only move
 * when the actual usage totals do) while still surfacing today's work.
 *
 * The row's membership is a pure function of the CACHE — the draft's current cwd
 * is NOT excluded (the bar renders that chip highlighted-active instead). The
 * first shape removed it, which made the row RESHUFFLE 21ms after every pick: the
 * folder just left re-entered the pool (usually at slot 0, being the most-used)
 * and a double-click's second press landed on the folder the user had just
 * escaped. Stable membership means no click can move a chip. A cold cache yields
 * NO chips — every read here is the synchronous module cache, never a fetch.
 */
export function quickDirsFor(): WorkingDirEntry[] {
  const cached = peekWorkingDirs();
  if (!cached) return [];
  const seen = new Set<string>();
  const candidates: WorkingDirEntry[] = [];
  for (const d of cached.dirs) {
    const key = dirKey({ cwd: d.cwd, host: d.host ?? null });
    if (seen.has(key)) continue;   // a duplicate row for the same dir
    seen.add(key);
    candidates.push(d);
  }

  // Most-used ever. Ties break on recency so the order is deterministic rather
  // than dependent on the server's array order.
  const byCount = [...candidates].sort(
    (a, b) => (b.count - a.count) || cmpLastUsed(a, b),
  ).slice(0, QUICK_TOP_BY_COUNT);

  const picked = new Set(byCount.map(d => dirKey({ cwd: d.cwd, host: d.host ?? null })));
  const byRecent = [...candidates]
    .filter(d => !picked.has(dirKey({ cwd: d.cwd, host: d.host ?? null })))
    .sort(cmpLastUsed)
    .slice(0, QUICK_TOP_BY_RECENT);

  return [...byCount, ...byRecent];
}

/** Freshest first. A missing/unparseable `lastUsed` sorts last rather than
 *  poisoning the comparison with NaN. */
function cmpLastUsed(a: WorkingDirEntry, b: WorkingDirEntry): number {
  return lastUsedMs(b) - lastUsedMs(a);
}
function lastUsedMs(d: WorkingDirEntry): number {
  const t = Date.parse(d.lastUsed ?? '');
  return Number.isNaN(t) ? -Infinity : t;
}

/** A project's declared folder, looked up by lowercased name
 *  (`useProjectRegistry().projectDefaults`). */
export type ProjectDefaultLookup = (project: string) => { cwd: string; host: string | null } | undefined;

/**
 * Fold a background parse of the composer text into a draft row.
 *
 * The ownership rule, one place: the AI may only write a field NOBODY ELSE has
 * claimed.
 *   · `project` — only while `projectSource` is unset or a previous 'ai' write.
 *     A 'user' pick (project pill / quick chip) or a 'seed' (project & tier "+")
 *     is FINAL.
 *   · `pinTier` / `priority` — only while `metaTouched` is false, and
 *     applying them must NOT set it: `metaTouched` means "the human chose", and it
 *     is also the per-directory launch-memory switch, so latching it here would
 *     silently freeze the model at whatever folder was selected first.
 *   · `cwd`/`host` — only as a consequence of an AI project, and only when the cwd
 *     is not pinned (no explicit folder pick) and the project actually declares a
 *     `default_cwd`. Never sets `cwdPinned` for the same reason.
 * Returns the SAME object when nothing applies, so a no-op parse can't re-render.
 */
export function applyDraftParse(
  draft: DraftColumn,
  parse: {
    project?: string; project_is_new?: boolean;
    pinTier?: string; priority?: QuickStartTaskMeta['priority'];
    due_date?: string; start_date?: string; end_date?: string;
  },
  projectDefault: ProjectDefaultLookup,
): DraftColumn {
  const ai = new Set<DraftAiField>(draft.aiFields ?? []);
  // Work on a copy and return the ORIGINAL unless something actually changed —
  // this runs on every landed parse (i.e. every ~500ms typing pause), and handing
  // React a new row for an identical result would re-render the column for nothing.
  const next: DraftColumn = { ...draft };
  let changed = false;

  const project = parse.project?.trim();
  const projectFree = draft.projectSource === undefined || draft.projectSource === 'ai';
  if (project && projectFree && project !== draft.project) {
    next.project = project;
    next.projectSource = 'ai';
    ai.add('project');
    changed = true;
    // Follow the project to its folder — the same "one gesture configures both"
    // rule the quick chips use, minus the click. A pinned cwd (explicit pick) or
    // an undeclared project leaves the folder alone.
    const home = projectDefault(project);
    if (home?.cwd && !next.cwdPinned && home.cwd !== next.cwd) {
      next.cwd = home.cwd;
      next.host = home.host;
      next.hostLabel = undefined;
      ai.add('cwd');
      // The bar SHOWS the model, so a cwd move has to move the launch memory with
      // it — otherwise it would advertise the previous folder's model.
      if (!next.metaTouched) next.meta = withDirLaunchMemory(next.meta, next.cwd, next.host);
    }
  }

  if (!draft.metaTouched) {
    const meta = { ...draft.meta };
    let metaChanged = false;
    if (parse.pinTier && parse.pinTier !== meta.pinTier) {
      meta.pinTier = parse.pinTier; ai.add('pinTier'); metaChanged = true;
    }
    if (parse.priority && parse.priority !== meta.priority) {
      meta.priority = parse.priority; ai.add('priority'); metaChanged = true;
    }
    // Dates ("by Friday", "3-5pm") — same ownership rule as tier/priority: any
    // user edit of the meta (metaTouched) freezes ALL of it, dates included.
    if (parse.due_date && parse.due_date !== meta.dueDate) {
      meta.dueDate = parse.due_date; ai.add('dueDate'); metaChanged = true;
    }
    if (parse.start_date && parse.start_date !== meta.startDate) {
      meta.startDate = parse.start_date; ai.add('startDate'); metaChanged = true;
    }
    if (parse.end_date && parse.end_date !== meta.endDate) {
      meta.endDate = parse.end_date; ai.add('endDate'); metaChanged = true;
    }
    // `meta` is REPLACED, never mutated in place; metaTouched deliberately stays
    // as it was (an AI value must not read as a user pick — see the doc above).
    if (metaChanged) { next.meta = meta; changed = true; }
  }

  if (!changed) return draft;
  next.aiFields = ai;
  return next;
}

/**
 * The user just took over a field — drop its ✦ badge.
 *
 * Only the BADGE: the authority flags (`projectSource`, `metaTouched`,
 * `cwdPinned`) are set by the handlers that own those edits, and they are what
 * actually stops further AI writes. This keeps the two concerns from drifting:
 * a badge is never load-bearing.
 */
export function clearAiFields(draft: DraftColumn, fields: readonly DraftAiField[]): DraftColumn {
  if (!draft.aiFields?.size) return draft;
  const ai = new Set(draft.aiFields);
  let changed = false;
  for (const f of fields) changed = ai.delete(f) || changed;
  return changed ? { ...draft, aiFields: ai } : draft;
}
