/**
 * Every writer of a draft's task fields other than the parse itself: More, the
 * folder picker footer, the tier "+" seed, the Ask Walnut tab, the visibility
 * re-derivation. Pure (no React), and each returns the SAME object on a no-op.
 *
 * Ownership is per FIELD (DraftColumn.fieldOwner): a human edit owns that field
 * only, a tier "+" seed owns the tier, and an owned field is final against the
 * AI. None of these writers sets `metaTouched`, which stays the model/engine
 * launch-memory switch only (the footer still latches it from model/engine).
 *
 * Imports draft-column.ts one way; draft-column.ts never imports this file.
 */

import type { QuickStartPath, QuickStartTaskMeta } from './SessionPathSelector';
import { DEFAULT_META } from './task-meta-constants';
import {
  ASK_WALNUT_PROJECT, applyDraftParse, clearAiFields, launchDivergesFromDirMemory,
  projectForFolderPick, restoreMetaAfterWalnut,
  type ApplyDraftParseOpts, type DraftAiField, type DraftColumn, type DraftFieldOwner, type DraftOwnedField,
  type DraftTaskField, type DraftTaskFieldPatch, type ProjectDefaultLookup,
} from './draft-column';
import { DRAFT_TASK_FIELDS, builtinTierKnown, resetTaskField, taskFieldValue } from './draft-parse-rules';

const OWNED_FIELDS: readonly DraftOwnedField[] = [...DRAFT_TASK_FIELDS, 'unread'];

type Owners = Partial<Record<DraftOwnedField, DraftFieldOwner>>;

/** Is the current value of `field` the AI's (✦, and revertable)? */
export function isAiOwned(draft: DraftColumn, field: DraftAiField): boolean {
  if (!draft.aiFields?.has(field)) return false;
  if (field === 'project' || field === 'cwd') return true;
  return !draft.fieldOwner?.[field];
}

/** Write one owned field into a meta copy. undefined clears a date, unpins the
 *  tier, and means none / false for priority / unread. */
function writeOwnedField(meta: QuickStartTaskMeta, field: DraftOwnedField, value: unknown): void {
  if (field === 'unread') meta.unread = value === true;
  else if (field === 'priority') meta.priority = (value as QuickStartTaskMeta['priority'] | undefined) ?? 'none';
  else if (field === 'pinTier') meta.pinTier = value as QuickStartTaskMeta['pinTier'];
  else if (value === undefined) delete meta[field];
  else meta[field] = value as string;
}

function sameOwners(a: Owners | undefined, b: Owners | undefined): boolean {
  return OWNED_FIELDS.every((f) => a?.[f] === b?.[f]);
}

function sameMeta(a: QuickStartTaskMeta, b: QuickStartTaskMeta): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k as keyof QuickStartTaskMeta] !== b[k as keyof QuickStartTaskMeta]) return false;
  }
  return true;
}

function sameSet<T>(a: ReadonlySet<T> | undefined, b: ReadonlySet<T> | undefined): boolean {
  const x = a ?? new Set<T>();
  const y = b ?? new Set<T>();
  if (x.size !== y.size) return false;
  for (const v of x) if (!y.has(v)) return false;
  return true;
}

/** Assemble the result, or return `draft` itself when nothing moved. */
function commit(
  draft: DraftColumn,
  meta: QuickStartTaskMeta,
  owners: Owners | undefined,
  ai: ReadonlySet<DraftAiField> | undefined,
  extra: Partial<DraftColumn> = {},
): DraftColumn {
  const extraSame = (Object.keys(extra) as (keyof DraftColumn)[]).every((k) => draft[k] === extra[k]);
  if (extraSame && sameMeta(draft.meta, meta) && sameOwners(draft.fieldOwner, owners) && sameSet(draft.aiFields, ai)) {
    return draft;
  }
  const next: DraftColumn = { ...draft, ...extra, meta };
  if (owners && Object.keys(owners).length) next.fieldOwner = owners;
  else delete next.fieldOwner;
  if (ai) next.aiFields = ai;
  return next;
}

/**
 * A More edit of task fields: each key in `patch` is written, owned by the user
 * and loses its ✦. `userTouched` latches (the user configured this column, so a
 * seed opens its own); `metaTouched` does NOT (it is model/engine memory only).
 * Editing the start drops the end with it (the menu has no end row).
 */
export function applyDraftTaskFieldEdit(draft: DraftColumn, patch: DraftTaskFieldPatch): DraftColumn {
  const keys = (Object.keys(patch) as DraftOwnedField[]).filter((k) => OWNED_FIELDS.includes(k));
  if (!keys.length) return draft;
  const meta = { ...draft.meta };
  const owners: Owners = { ...draft.fieldOwner };
  const ai = new Set(draft.aiFields ?? []);
  for (const k of keys) {
    writeOwnedField(meta, k, patch[k]);
    if (k === 'startDate') delete meta.endDate;
    owners[k] = 'user';
    if (k !== 'unread') ai.delete(k);
  }
  return commit(draft, meta, owners, ai, { userTouched: true });
}

/**
 * "Use Walnut's pick": give a field back to the AI. Only when the parse proposed
 * something for it (`aiSuggested`); the value comes back with its ✦ and the owner
 * goes, so later parses may change it again. The start brings back the end the
 * same parse gave it.
 */
export function returnFieldToWalnut(draft: DraftColumn, field: DraftTaskField): DraftColumn {
  const suggested = draft.aiSuggested?.[field];
  if (suggested === undefined) return draft;
  const meta = { ...draft.meta };
  writeOwnedField(meta, field, suggested);
  if (field === 'startDate') {
    const end = draft.lastParse?.start_date === suggested ? draft.lastParse.end_date : undefined;
    if (end) meta.endDate = end;
    else delete meta.endDate;
  }
  const owners: Owners = { ...draft.fieldOwner };
  delete owners[field];
  const ai = new Set(draft.aiFields ?? []);
  ai.add(field);
  return commit(draft, meta, owners, ai);
}

/**
 * A folder pick landed (full picker, or a quick folder chip). The pure body of
 * MainPage's handleDraftPathChange.
 *
 * Folder + project: the folder becomes the user's (`cwdPinned`, ✦ dropped), and the
 * project follows it (projectForFolderPick: registry owner, else the basename,
 * never over a user/seed pick). `createCwd` is rewritten, never merged.
 *
 * Meta, rebased PER FIELD so a parse that landed while the picker was open is not
 * overwritten by the picker's stale copy:
 *  · model / engine always come from `meta` (the picker already resolved the
 *    folder's launch memory), and `metaTouched` latches when they diverge from it;
 *  · with `openedMeta` (the full picker, snapshot taken when it opened) a task
 *    field whose returned value differs from that snapshot is the user's edit:
 *    written, owned, ✦ dropped. An equal one keeps the CURRENT row value. A changed
 *    End takes over start AND end together (owner on startDate);
 *  · without `openedMeta` (a quick folder chip hands a render-time snapshot) no
 *    task field, owner or ✦ changes at all.
 */
export function applyDraftPathPick(
  draft: DraftColumn,
  path: QuickStartPath,
  meta: QuickStartTaskMeta,
  openedMeta: QuickStartTaskMeta | undefined,
  projectForDir: (cwd: string) => string,
): DraftColumn {
  const project = projectForFolderPick(draft, path.cwd, projectForDir);
  const base = clearAiFields(draft, project !== null ? ['cwd', 'project'] : ['cwd']);
  const nextMeta: QuickStartTaskMeta = { ...draft.meta, model: meta.model, engine: meta.engine };
  let owners = draft.fieldOwner;
  const ai = new Set(base.aiFields ?? []);
  if (openedMeta) {
    const o: Owners = { ...draft.fieldOwner };
    for (const f of OWNED_FIELDS) {
      if (meta[f] === openedMeta[f]) continue;
      writeOwnedField(nextMeta, f, meta[f]);
      o[f] = 'user';
      if (f !== 'unread') ai.delete(f);
    }
    if (meta.endDate !== openedMeta.endDate) {
      writeOwnedField(nextMeta, 'startDate', meta.startDate);
      if (meta.endDate === undefined) delete nextMeta.endDate;
      else nextMeta.endDate = meta.endDate;
      o.startDate = 'user';
      ai.delete('startDate');
    }
    owners = o;
  }
  return commit(draft, nextMeta, owners, ai, {
    cwd: path.cwd,
    host: path.host,
    hostLabel: path.hostLabel,
    cwdPinned: true,
    userTouched: true,
    createCwd: path.createCwd === true,
    metaTouched: draft.metaTouched || launchDivergesFromDirMemory(meta, path.cwd, path.host),
    ...(project !== null ? { project, projectSource: 'folder' as const } : {}),
  });
}

/** A tier "+" header click: the tier is the user asking, so the seed owns it (no
 *  ✦), unless the user already picked a tier by hand, which stays. */
export function applyTierSeed(draft: DraftColumn, tier: string): DraftColumn {
  if (draft.fieldOwner?.pinTier === 'user') return draft;
  const ai = new Set(draft.aiFields ?? []);
  ai.delete('pinTier');
  return commit(draft, { ...draft.meta, pinTier: tier }, { ...draft.fieldOwner, pinTier: 'seed' }, ai);
}

/** Every AI-owned field among `fields` back to its default, ✦ dropped (the
 *  quick-parse switch turned off, priority hidden, entering Ask Walnut). User and
 *  seed values stay. */
export function revertAiTaskFields(
  draft: DraftColumn,
  fields: readonly DraftTaskField[] = DRAFT_TASK_FIELDS,
): DraftColumn {
  const meta = { ...draft.meta };
  const ai = new Set(draft.aiFields ?? []);
  for (const f of fields) {
    if (!isAiOwned(draft, f)) continue;
    resetTaskField(meta, f);
    ai.delete(f);
  }
  return commit(draft, meta, draft.fieldOwner, ai);
}

/**
 * Start Task -> Ask Walnut. The pure half of MainPage's tab switch (the Ask Walnut
 * model fetch stays there). Walnut mode runs no parse, so no AI task value may
 * ride the Ask unseen: AI-owned fields go back to their defaults. The tier stays
 * only when a user or a seed owns it; otherwise it is Focus, owner cleared with it
 * (value and owner always move together). The stash keeps the project pick, the
 * folder's model, the owner map, and the tier ONLY when owned: an AI tier must not
 * come back on leave without its ✦ (no later parse could revert it).
 */
export function enterWalnutDraft(draft: DraftColumn): DraftColumn {
  if (draft.walnut) return draft; // re-click on the active tab: never re-stash
  const tierOwned = !!draft.fieldOwner?.pinTier;
  const reverted = revertAiTaskFields(draft);
  const owners: Owners = { ...draft.fieldOwner };
  if (!tierOwned) delete owners.pinTier;
  const next: DraftColumn = {
    ...reverted,
    walnut: true,
    // A deliberate mode choice: a seeded open must open its OWN column.
    userTouched: true,
    walnutPrev: {
      project: draft.project,
      projectSource: draft.projectSource,
      model: draft.meta.model,
      ...(tierOwned ? { pinTier: draft.meta.pinTier } : {}),
      fieldOwner: draft.fieldOwner,
    },
    // A BOUND draft's task already lives somewhere: asking about it keeps it there.
    ...(draft.taskId ? {} : { project: ASK_WALNUT_PROJECT, projectSource: 'seed' as const }),
    meta: { ...reverted.meta, pinTier: tierOwned ? draft.meta.pinTier : DEFAULT_META.pinTier, model: undefined },
  };
  if (Object.keys(owners).length) next.fieldOwner = owners;
  else delete next.fieldOwner;
  return next;
}

/**
 * Ask Walnut -> Start Task: undo what entering wrote and keep what the user picked
 * inside walnut mode. restoreMetaAfterWalnut handles the model and a stashed tier;
 * a tier picked by hand inside walnut mode is kept; an unowned tier stays Focus
 * (never unpinned). A stashed owner comes back with its value. The text is
 * re-parsed on return (the parse effect depends on the mode), so AI chips return.
 */
export function leaveWalnutDraft(draft: DraftColumn): DraftColumn {
  if (!draft.walnut) return draft;
  const prev = draft.walnutPrev;
  const owner = draft.fieldOwner?.pinTier;
  const pickedInside = owner === 'user'
    && (prev?.fieldOwner?.pinTier !== 'user' || draft.meta.pinTier !== prev?.pinTier);
  const stash = prev && pickedInside ? { ...prev, pinTier: undefined } : prev;
  const meta = { ...restoreMetaAfterWalnut(draft.meta, stash) };
  if (meta.pinTier === undefined && !owner) meta.pinTier = DEFAULT_META.pinTier;
  const back: DraftColumn = { ...draft, walnut: false, walnutPrev: undefined, meta };
  const stashOwner = prev?.fieldOwner?.pinTier;
  if (stashOwner && !owner && prev && 'pinTier' in prev && meta.pinTier === prev.pinTier) {
    back.fieldOwner = { ...draft.fieldOwner, pinTier: stashOwner };
  }
  if (draft.projectSource === 'seed' && draft.project === ASK_WALNUT_PROJECT) {
    back.project = prev?.project;
    back.projectSource = prev?.projectSource;
  }
  return back;
}

/** Re-run the last parse after priority visibility or the custom tiers became
 *  known, so a chip appears without a new keystroke. Always 'eager': a
 *  re-derivation may add or change a chip, never remove one. */
export function rederiveDraftParse(
  draft: DraftColumn,
  projectDefault: ProjectDefaultLookup,
  opts: Omit<ApplyDraftParseOpts, 'kind'> = {},
): DraftColumn {
  if (!draft.lastParse) return draft;
  return applyDraftParse(draft, draft.lastParse, projectDefault, { ...opts, kind: 'eager' });
}

/** `tierKnown` for applyDraftParse / suggestDiff / launchMetaFor: built-ins are
 *  always known; a `ct_*` id is 'unknown' until the custom tier list has loaded,
 *  then known only if it is in the list; anything else is no tier at all. */
export function makeTierKnown(
  customTiers: readonly { id: string }[],
  loaded: boolean,
): (id: string) => boolean | 'unknown' {
  const ids = new Set(customTiers.map((t) => t.id));
  return (id) => {
    if (builtinTierKnown(id)) return true;
    if (!id.startsWith('ct_')) return false;
    return loaded ? ids.has(id) : 'unknown';
  };
}

/** The meta a launch sends: a tier the app knows is gone (a deleted custom tier)
 *  goes out as the default instead. Same object when nothing is replaced. */
export function launchMetaFor(
  draft: DraftColumn,
  tierKnown: (id: string) => boolean | 'unknown',
): QuickStartTaskMeta {
  const tier = draft.meta.pinTier;
  if (tier === undefined || tierKnown(tier) !== false) return draft.meta;
  return { ...draft.meta, pinTier: DEFAULT_META.pinTier };
}
