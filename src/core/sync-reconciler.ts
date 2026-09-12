/**
 * Sync Reconciler — generic full-reconciliation framework for integration plugins.
 *
 * Delta polling (syncPoll) is fast but unreliable: network issues, API truncation,
 * or token expiry can cause permanent drift. This framework adds a periodic full
 * reconciliation layer on top of delta polling to guarantee eventual consistency.
 *
 * Plugin contract: implement fullPull(ctx) + extractRemoteId(task) (~20 lines each).
 * Framework owns all reconciliation logic: scheduling, three-way diff, safety guards.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SYNC_DIR } from '../constants.js';
import { log } from '../logging/index.js';
import {
  addTasksBulk,
  autoPushIfConfigured,
  deleteTasksBulk,
  ensureProject,
  InvalidProjectNameError,
  isPushInflight,
  isRetiredSentinelTitle,
  updateTasksBulk,
} from './task-manager.js';
import { bus, EventNames } from './event-bus.js';
import { isLegacyInboxGroup, isRetiredQuickStartGroup } from '../utils/format.js';
import { isRemoteIdBlocked, isRemoteIdClaimedByLiveTask } from './task-remote-links.js';
import type { RegisteredPlugin, RemoteSyncItem, SyncPollContext } from './integration-types.js';
import type { Task } from './types.js';

// ── Reconcile state (per-plugin, managed by framework) ──

interface ReconcileState {
  /** Number of delta ticks since last full reconcile. */
  deltaEpoch: number;
  /** ISO timestamp of last successful full reconcile. */
  lastFullReconcileAt: string;
  /** Number of items returned by last full pull (for empty-result guard). */
  lastFullPullCount: number;
  /** Last state file write. */
  updatedAt: string;
}

// ── Scheduling config ──

const FULL_RECONCILE_EPOCH = 60;       // After 60 deltas (~30 min at 30s interval)
const FULL_RECONCILE_INTERVAL_MS = 30 * 60_000; // 30 minutes time-based fallback
const DELTA_FAILURE_THRESHOLD = 3;     // Force full after 3 consecutive delta failures
const EMPTY_RESULT_MIN_RATIO = 0.1;    // Abort if result < 10% of last known count

// ── Diff result types ──

interface ReconcileDiffResult {
  toCreate: RemoteSyncItem[];
  toUpdate: Array<{ local: Task; remote: RemoteSyncItem }>;
  /** Remote items matched to a local task via a FORMER id (alias): the task
   *  adopts the remote's current id instead of a duplicate being created. */
  toAdopt: Array<{ local: Task; remote: RemoteSyncItem }>;
  toRemove: Task[];
  /** Local tasks completed here whose completion the remote never received:
   *  the remote is still open and was not touched after the local completion.
   *  The reconciler pushes them again (see `remoteMissedOurCompletion`). */
  toRepush: Task[];
  unchanged: number;
}

/**
 * How many lost completions one full reconcile pushes again. Each push is a
 * serial remote round trip (~1-3s), so the batch bounds the tick; the rest wait
 * for the next cycle.
 */
const REPUSH_BATCH = 50;
/** Two at a time: four tripped the tracker's rate limit (22 of 50 pushes throttled). */
const REPUSH_CONCURRENCY = 2;

/** Clock skew allowance between this machine and the remote server. */
const ECHO_GRACE_MS = 10_000;

/** The remote refused for rate, not for content (the tracker says "ThrottlingException: Rate exceeded"). */
function isRateLimitError(error: string | undefined): boolean {
  return /throttl|rate exceeded|rate limit|too many requests|\b429\b/i.test(error ?? '');
}

/** The remote item is closed, as the plugin's mapper reports it. */
function remoteIsClosed(remote: RemoteSyncItem): boolean {
  return remote.fields.phase === 'COMPLETE' || remote.fields.status === 'done';
}

/** The remote item is open, as the plugin's mapper reports it (a mapper that
 *  reports neither phase nor status says nothing, and nothing is inferred). */
function remoteIsOpen(remote: RemoteSyncItem): boolean {
  if (remote.fields.phase !== undefined) return remote.fields.phase !== 'COMPLETE';
  if (remote.fields.status !== undefined) return remote.fields.status !== 'done';
  return false;
}

/** Epoch ms of an ISO timestamp, 0 when absent or unparseable. */
function timeOf(iso: string | undefined | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * The local task is COMPLETE, the remote twin is still open, and nothing touched
 * the remote after the local completion: the close never landed. Two plugin
 * failures produce this shape. A plugin that dropped a push while another was in
 * flight reported success (the remote's last update is the stale push, within a
 * second of the completion), and a plugin that was not loaded never pushed at all
 * (the remote's last update predates the completion). A remote edit AFTER the
 * completion (a teammate reopening it) is not this case and is left alone: the
 * remote's word stands, as it always has for phase. The completion time is the
 * intent, not `updated_at`: a later local edit to a finished task (or a bulk
 * migration bumping every row) must not turn a teammate's reopen into "lost".
 * A row that already carries a sync_error belongs to the sync loop's retry
 * schedule (with backoff); this path is for the pushes Walnut believed landed.
 */
function remoteMissedOurCompletion(local: Task, remote: RemoteSyncItem, graceMs: number): boolean {
  if (local.phase !== 'COMPLETE' || local.sync_error || !remoteIsOpen(remote)) return false;
  const remoteTime = timeOf(remote.remoteUpdatedAt);
  const localIntent = timeOf(local.completed_at) || timeOf(local.updated_at);
  return remoteTime > 0 && localIntent > 0 && remoteTime <= localIntent + graceMs;
}

/**
 * The remote twin was closed at or after the last local edit while the task is
 * still open here. Ordinarily the LWW check already takes this (remote newer than
 * the watermark), but the watermark can lie: see the toUpdate branch that
 * re-checks against updated_at alone. The grace runs in the REMOTE's favour on
 * purpose: the tracker's last-updated stamp has been observed a second behind the
 * push that closed the task, and a close is terminal, so a local reopen inside
 * that window whose own push was lost gives way to the remote (a reopen that did
 * reach the remote leaves it open and never enters this branch).
 */
function remoteClosedSinceLocalEdit(local: Task, remote: RemoteSyncItem, graceMs: number): boolean {
  if (local.phase === 'COMPLETE' || !remoteIsClosed(remote)) return false;
  const remoteTime = timeOf(remote.remoteUpdatedAt);
  return remoteTime > 0 && remoteTime + graceMs >= timeOf(local.updated_at);
}

// ── Apply outcome ──

/**
 * Why a project name could not take the write. Each one means the remote item
 * was NOT imported (create) or NOT moved (update) — the item stays remote-only
 * and the same refusal repeats on every cycle until a human changes something.
 */
type RefusalReason =
  /** The human deleted this project here; the ledger refuses to re-mint it. */
  | 'deleted-project'
  /** The remote container's name matches a LOCAL-source project — the unlinked
   *  state: two things with one name and no link between them. */
  | 'local-project'
  /** Another provider owns the project row. */
  | 'other-provider'
  /** A retired grouping name (quick-start group / legacy Inbox). */
  | 'retired-name';

/** What the apply pass ACTUALLY did, as opposed to what the diff intended. */
interface ApplyOutcome {
  adopted: number;
  created: number;
  updated: number;
  removed: number;
  /** Lost completions pushed again this cycle, and how many of those the remote accepted. */
  repushed: number;
  repushFailed: number;
  /** Remote items refused by a project gate, by project name. */
  refusals: Map<string, { reason: RefusalReason; items: number; claimedBy?: string }>;
}

// ── SyncReconciler ──

/**
 * Consecutive full reconciles a project may be refused before the refusal is
 * escalated from a warn to `log.error` (which the notification bridge turns into
 * ONE deduped card for the human). 3 ≈ 1.5h at the 30-min cadence: long enough
 * that a mid-rename blip stays quiet, short enough that the 14-hour silent loop
 * of 2026-09-08 could not happen again.
 */
const REFUSAL_ESCALATE_TICKS = 3;

export class SyncReconciler {
  private stateCache = new Map<string, ReconcileState>();
  private isFirstTick = new Map<string, boolean>();
  /** `${pluginId}:${lower(project)}` → consecutive full reconciles refused. */
  private refusalStreaks = new Map<string, number>();

  constructor() {
    fs.mkdirSync(SYNC_DIR, { recursive: true });
  }

  /**
   * Called after every delta poll. Tracks epochs, decides if full reconcile is needed,
   * and runs the three-way diff + apply cycle when triggered.
   */
  async tick(
    plugin: RegisteredPlugin,
    ctx: SyncPollContext,
    opts: { deltaFailed?: boolean } = {},
  ): Promise<void> {
    // Skip plugins that don't implement full reconciliation
    if (!plugin.sync.fullPull || !plugin.sync.extractRemoteId) return;

    const state = this.loadState(plugin.id);

    // Track delta epoch
    state.deltaEpoch++;
    if (opts.deltaFailed) {
      // deltaEpoch is also used as failure counter when delta fails consecutively
    }

    // Check if first tick for this plugin
    const first = this.isFirstTick.get(plugin.id) !== false;
    if (first) this.isFirstTick.set(plugin.id, false);

    const shouldReconcile = this.shouldRunFull(state, opts, first);
    if (!shouldReconcile) {
      this.saveState(plugin.id, state);
      return;
    }

    log.web.info(`sync-reconciler: starting full reconcile`, { pluginId: plugin.id, trigger: this.getTriggerReason(state, opts, first) });

    try {
      const pulled = await plugin.sync.fullPull(ctx);
      if (!pulled) {
        log.web.debug('sync-reconciler: fullPull returned null/undefined, skipping', { pluginId: plugin.id });
        this.saveState(plugin.id, state);
        return;
      }
      // Retired `.metadata*` sentinel twins are dropped BEFORE the diff, not at
      // write time. addTasksBulk refuses them anyway, so leaving them in made
      // every cycle report `created: 3` for rows that were never written — a
      // counter that lies about the one number this log line exists to report.
      const remoteItems = pulled.filter((item) => {
        if (!isRetiredSentinelTitle(item.title ?? (item.fields.title as string | undefined))) return true;
        log.web.debug('sync-reconciler: dropped retired .metadata sentinel from full pull', {
          pluginId: plugin.id, title: item.title, remoteId: item.remoteId,
        });
        return false;
      });
      const sentinelsDropped = pulled.length - remoteItems.length;

      // Safety guard: empty result when we previously had items
      if (remoteItems.length === 0 && state.lastFullPullCount > 5) {
        log.web.warn('sync-reconciler: fullPull returned 0 items but last pull had items — aborting to prevent mass deletion', {
          pluginId: plugin.id,
          lastCount: state.lastFullPullCount,
        });
        this.saveState(plugin.id, state);
        return;
      }

      // Safety guard: drastic drop in count
      if (
        state.lastFullPullCount > 0 &&
        remoteItems.length > 0 &&
        remoteItems.length < state.lastFullPullCount * EMPTY_RESULT_MIN_RATIO
      ) {
        log.web.warn('sync-reconciler: fullPull count dropped drastically — aborting', {
          pluginId: plugin.id,
          currentCount: remoteItems.length,
          lastCount: state.lastFullPullCount,
        });
        this.saveState(plugin.id, state);
        return;
      }

      // Run three-way diff
      const localTasks = ctx.getTasks().filter(t => t.source === plugin.id);
      const diff = this.computeDiff(localTasks, remoteItems, plugin);

      // Apply changes
      const outcome = await this.applyDiff(diff, ctx, plugin.id);
      this.noteRefusals(plugin.id, outcome.refusals);

      // Update state on success
      state.deltaEpoch = 0;
      state.lastFullReconcileAt = new Date().toISOString();
      state.lastFullPullCount = remoteItems.length;
      state.updatedAt = new Date().toISOString();
      this.saveState(plugin.id, state);

      // Every count here is what LANDED, never what the diff intended. The
      // 2026-09-08 log reported `created: 15` on every cycle for 14 hours while
      // writing nothing: 3 were sentinels and 12 were refused by a project gate,
      // and the intent-shaped counter hid both. When intent and outcome differ,
      // the difference gets its OWN field so the gap is readable, not inferred.
      const refusedItems = [...outcome.refusals.values()].reduce((n, r) => n + r.items, 0);
      log.web.info('sync-reconciler: full reconcile complete', {
        pluginId: plugin.id,
        remoteCount: remoteItems.length,
        created: outcome.created,
        updated: outcome.updated,
        removed: outcome.removed,
        unchanged: diff.unchanged,
        ...(outcome.adopted > 0 ? { adopted: outcome.adopted } : {}),
        ...(diff.toRepush.length > 0
          ? { repushed: outcome.repushed, repushFailed: outcome.repushFailed, repushPending: diff.toRepush.length - outcome.repushed - outcome.repushFailed }
          : {}),
        ...(diff.toCreate.length !== outcome.created ? { createsIntended: diff.toCreate.length } : {}),
        ...(diff.toUpdate.length !== outcome.updated ? { updatesIntended: diff.toUpdate.length } : {}),
        ...(sentinelsDropped > 0 ? { sentinelsDropped } : {}),
        ...(refusedItems > 0
          ? { refusedItems, refusedProjects: [...outcome.refusals.keys()] }
          : {}),
      });
    } catch (err) {
      log.web.error('sync-reconciler: full reconcile failed', {
        pluginId: plugin.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't reset epoch — next tick will try again if threshold still met
      this.saveState(plugin.id, state);
    }
  }

  /** Reset state for a plugin (e.g. on server startup). */
  forceNextReconcile(pluginId: string): void {
    this.isFirstTick.set(pluginId, true);
  }

  // ── Private: Scheduling ──

  private shouldRunFull(
    state: ReconcileState,
    opts: { deltaFailed?: boolean },
    isFirst: boolean,
  ): boolean {
    if (isFirst) return true;
    if (state.deltaEpoch >= FULL_RECONCILE_EPOCH) return true;
    if (opts.deltaFailed && state.deltaEpoch >= DELTA_FAILURE_THRESHOLD) return true;

    const elapsed = Date.now() - new Date(state.lastFullReconcileAt).getTime();
    if (elapsed >= FULL_RECONCILE_INTERVAL_MS) return true;

    return false;
  }

  private getTriggerReason(
    state: ReconcileState,
    opts: { deltaFailed?: boolean },
    isFirst: boolean,
  ): string {
    if (isFirst) return 'first_tick';
    if (opts.deltaFailed && state.deltaEpoch >= DELTA_FAILURE_THRESHOLD) return 'delta_failures';
    if (state.deltaEpoch >= FULL_RECONCILE_EPOCH) return 'epoch_threshold';
    const elapsed = Date.now() - new Date(state.lastFullReconcileAt).getTime();
    if (elapsed >= FULL_RECONCILE_INTERVAL_MS) return 'time_elapsed';
    return 'unknown';
  }

  // ── Private: Three-way diff ──

  private computeDiff(
    localTasks: Task[],
    remoteItems: RemoteSyncItem[],
    plugin: RegisteredPlugin,
  ): ReconcileDiffResult {
    const extractId = plugin.sync.extractRemoteId!;
    const extractAliases = plugin.sync.extractRemoteIdAliases;

    // Build maps
    const remoteMap = new Map<string, RemoteSyncItem>();
    for (const item of remoteItems) {
      if (!item.deleted) {
        remoteMap.set(item.remoteId, item);
      }
    }

    const localByRemoteId = new Map<string, Task>();
    const localWithoutRemoteId: Task[] = [];
    for (const task of localTasks) {
      const rid = extractId(task);
      if (rid) {
        localByRemoteId.set(rid, task);
      } else {
        localWithoutRemoteId.push(task);
      }
    }
    // Alias map, SEPARATE from the current-id map: a remote item still keyed to
    // a task's FORMER id (ms-todo re-keys on list migration) must join to that
    // task — as an ADOPTION — instead of landing in toCreate as a duplicate.
    // Kept separate because the removal loop below may only judge current ids:
    // folding aliases in would queue a task for removal whenever one of its
    // OLD ids is (correctly) absent from the remote.
    const localByAlias = new Map<string, Task>();
    if (extractAliases) {
      for (const task of localTasks) {
        for (const alias of extractAliases(task) ?? []) {
          if (!localByRemoteId.has(alias) && !localByAlias.has(alias)) {
            localByAlias.set(alias, task);
          }
        }
      }
    }

    const toCreate: RemoteSyncItem[] = [];
    const toUpdate: Array<{ local: Task; remote: RemoteSyncItem }> = [];
    const toAdopt: Array<{ local: Task; remote: RemoteSyncItem }> = [];
    const toRemove: Task[] = [];
    const toRepush: Task[] = [];
    let unchanged = 0;
    // A task adopted via alias is accounted for — its current id pointing at
    // nothing remote is EXPECTED (the remote item wears the alias id).
    const adoptedTaskIds = new Set<string>();

    // remote ∩ local → check for updates
    // remote - local → create (or adopt when a local task owned this id before)
    for (const [remoteId, remote] of remoteMap) {
      const local = localByRemoteId.get(remoteId);
      if (local) {
        // Skip tasks with inflight push — avoid echo during push window
        if (isPushInflight(local.id)) {
          unchanged++;
          continue;
        }
        // Both exist — only overwrite if remote is strictly newer than our last
        // local modification (Last-Write-Wins). Using max(_syncedAt, updated_at)
        // as the threshold protects local changes when push has failed (auth
        // expired, network error, etc.): _syncedAt stays stale but updated_at
        // reflects the unsynced local edit, so the reconciler won't clobber it.
        // Grace period accounts for clock skew between local and remote servers.
        const remoteTime = new Date(remote.remoteUpdatedAt).getTime();
        const syncedAt = local._syncedAt ? new Date(local._syncedAt).getTime() : 0;
        const localUpdatedAt = local.updated_at ? new Date(local.updated_at).getTime() : 0;
        const threshold = Math.max(syncedAt, localUpdatedAt);
        if (remoteTime > threshold + ECHO_GRACE_MS) {
          toUpdate.push({ local, remote });
        } else if (remoteMissedOurCompletion(local, remote, ECHO_GRACE_MS)) {
          toRepush.push(local);
        } else if (remoteClosedSinceLocalEdit(local, remote, ECHO_GRACE_MS)) {
          // Judged against updated_at alone, not the watermark: an earlier cycle
          // stamped _syncedAt with this very close while dropping its phase, so
          // the watermark is the thing that hid it.
          toUpdate.push({ local, remote });
        } else {
          unchanged++;
        }
        continue;
      }
      const aliasOwner = localByAlias.get(remoteId);
      if (aliasOwner) {
        if (adoptedTaskIds.has(aliasOwner.id)) {
          // This task already adopted ANOTHER remote item this cycle (a task
          // can carry several former ids). A second adoption would overwrite
          // the first — ext.id can only point at one remote — leaving the
          // other item unowned and re-creatable next cycle. Leave this one
          // for the next reconcile, after the first adoption has settled.
          unchanged++;
          continue;
        }
        const ownerCurrentId = extractId(aliasOwner);
        if (ownerCurrentId && remoteMap.has(ownerCurrentId)) {
          // BOTH ids are present remotely: the owner is already matched by its
          // CURRENT id; this item is a stale twin wearing a former id (the
          // re-key DELETE never landed). Adopting would steal the identity
          // back to the old id and orphan the new one — next cycle the new id
          // mints a duplicate. Don't adopt, don't create; just skip.
          log.web.debug('sync-reconciler: skipped stale twin wearing a former id', {
            pluginId: plugin.id, taskId: aliasOwner.id, staleRemoteId: remoteId, currentRemoteId: ownerCurrentId,
          });
          unchanged++;
        } else if (!isPushInflight(aliasOwner.id)) {
          // The remote item wears an id this task USED to have — adopt it back
          // (re-point ext to the current remote id) instead of forking a copy.
          toAdopt.push({ local: aliasOwner, remote });
          adoptedTaskIds.add(aliasOwner.id);
        } else {
          // Push in flight for the owner: neither adopt (racing the push's own
          // ext write) nor create (that forks a copy for an id we know is
          // owned). Revisit next cycle.
          unchanged++;
        }
        continue;
      }
      toCreate.push(remote);
    }

    // local - remote → candidate for removal (adopted tasks are matched).
    // Push-inflight tasks are exempt: a re-key push (remote DELETE old id →
    // POST new id → local ext updated) has a window where the local ext still
    // wears the just-deleted id — a full pull landing inside it would read
    // "remote gone" and delete a task that is mid-flight, not gone.
    for (const [remoteId, local] of localByRemoteId) {
      if (!remoteMap.has(remoteId) && !adoptedTaskIds.has(local.id) && !isPushInflight(local.id)) {
        toRemove.push(local);
      }
    }

    // Tasks without remote ID are left alone (can't reconcile without a join key)
    unchanged += localWithoutRemoteId.length;

    return { toCreate, toUpdate, toAdopt, toRemove, toRepush, unchanged };
  }

  // ── Private: Apply diff ──

  private async applyDiff(
    diff: ReconcileDiffResult,
    ctx: SyncPollContext,
    pluginId: string,
  ): Promise<ApplyOutcome> {
    const source = `${pluginId}-reconcile`;
    let changeCount = 0;
    const outcome: ApplyOutcome = { adopted: 0, created: 0, updated: 0, removed: 0, repushed: 0, repushFailed: 0, refusals: new Map() };
    /** Count this item against the project that refused it (for the caller's log). */
    const noteRefusal = (project: string, reason: RefusalReason, claimedBy?: string): void => {
      const entry = outcome.refusals.get(project);
      if (entry) entry.items++;
      else outcome.refusals.set(project, { reason, items: 1, ...(claimedBy ? { claimedBy } : {}) });
    };

    // addTasksBulk/updateTasksBulk skip the create-time validation chain by
    // design, so this is the one bulk path that could write `tasks.project`
    // with no registry row (e.g. a remote list renamed between ticks) or into a
    // project CLAIMED BY ANOTHER PROVIDER (addTaskFull hard-refuses that shape;
    // without the same gate here a full pull re-created cross-claimed twins on
    // every cycle — observed 2026-08-05 with one provider re-importing tasks
    // whose project belonged to a different provider).
    // Resolution per name: valid + unclaimed/same-claim → canonical spelling;
    // claim conflict → 'conflict' (create skipped, update keeps local project);
    // shape-invalid → '' (field dropped, row keeps its current project).
    //
    // A 'conflict' is REPORTED, not just skipped: the same items are refused on
    // every cycle until a human intervenes, so the resolution is cached WITH its
    // reason and each refused item is counted (see noteRefusal / noteRefusals).
    type Resolution = string | { conflict: RefusalReason; claimedBy?: string };
    const ensuredProjects = new Map<string, Resolution>(); // lower(name) → canonical | refusal
    const resolveProject = async (fields: Partial<Task>): Promise<'ok' | 'conflict'> => {
      const name = (fields.project ?? '').trim();
      if (!name) return 'ok';
      const key = name.toLowerCase();
      let resolution = ensuredProjects.get(key);
      if (resolution === undefined) {
        // Retired grouping names are Inbox, and Inbox can't hold provider tasks —
        // same pull-side rule as routePulledListToProject. Without this, a remote
        // task still tagged with the retired name resurrects it as a claimed
        // project on every full pull (the v5 repair deleted these rows once).
        if (isRetiredQuickStartGroup(name) || isLegacyInboxGroup(name)) {
          log.web.warn('sync-reconciler: remote task grouped under a retired name — not imported/moved', {
            pluginId, project: name,
          });
          resolution = { conflict: 'retired-name' };
        } else {
          try {
            const ensured = await ensureProject(name, pluginId as Task['source'], {
              writer: `${pluginId}-reconcile`,
            });
            if (ensured.blocked) {
              // The human deleted this project. The remote container may still
              // exist, and re-minting the row from it is exactly the resurrection
              // the tombstone ledger refuses (2026-09-08).
              log.web.warn('sync-reconciler: remote task targets a DELETED project — not imported/moved', {
                pluginId, project: name,
              });
              resolution = { conflict: 'deleted-project' };
            } else if (ensured.source === pluginId) {
              resolution = ensured.name;
            } else if (ensured.source === 'local') {
              // The UNLINKED STATE, and the shape that started the 2026-09-08
              // incident: a remote container and a LOCAL project wearing the same
              // name, with nothing joining them. Every pull refuses these items
              // (a provider task cannot live in a local-claimed project) and the
              // refusal used to be invisible, so the mismatch survived 14 hours
              // and a delete that only removed the local half. Binding the
              // project to the container automatically is NOT the answer — that
              // would start pushing the user's local tasks into a remote account
              // nobody asked to sync — so this stays a report, escalated by
              // noteRefusals when it keeps happening.
              log.web.warn('sync-reconciler: remote container matches a LOCAL project — items stay remote-only', {
                pluginId, project: name, remoteItems: 1,
              });
              resolution = { conflict: 'local-project' };
            } else {
              log.web.warn('sync-reconciler: remote task targets a project claimed by another provider', {
                pluginId, project: name, claimedBy: ensured.source,
              });
              resolution = { conflict: 'other-provider', claimedBy: ensured.source };
            }
          } catch (err) {
            if (!(err instanceof InvalidProjectNameError)) throw err;
            log.web.warn('sync-reconciler: invalid project name from remote — leaving project unchanged', {
              pluginId, project: name,
            });
            resolution = '';
          }
        }
        ensuredProjects.set(key, resolution);
      }
      if (typeof resolution !== 'string') {
        noteRefusal(name, resolution.conflict, resolution.claimedBy);
        return 'conflict';
      }
      if (resolution) fields.project = resolution;
      else delete fields.project;
      return 'ok';
    };

    // ── Adoptions — a local task reclaims a remote item wearing its former id ──
    // Runs BEFORE creates so a re-keyed item can never race into both lists.
    if (diff.toAdopt.length > 0) {
      const adoptPatches: Array<{ id: string; patch: Partial<Task> }> = [];
      for (const { local, remote } of diff.toAdopt) {
        const currentExt = (local.ext?.[pluginId] ?? {}) as Record<string, unknown>;
        adoptPatches.push({
          id: local.id,
          patch: {
            ext: {
              ...local.ext,
              [pluginId]: { ...currentExt, ...(remote.fields.ext?.[pluginId] as Record<string, unknown> | undefined), id: remote.remoteId },
            },
          },
        });
        log.web.info('sync-reconciler: adopted re-keyed remote item', {
          pluginId, taskId: local.id, remoteId: remote.remoteId,
        });
      }
      try {
        const { changed } = await updateTasksBulk(adoptPatches);
        for (const task of changed) {
          bus.emit(EventNames.TASK_UPDATED, { task }, [], { source });
        }
        changeCount += changed.length;
        outcome.adopted = changed.length;
      } catch (err) {
        log.web.warn('sync-reconciler: bulk adopt failed', {
          pluginId, batchSize: adoptPatches.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Creates (batch limit: 50) ──
    const createBatch = diff.toCreate.slice(0, 50);
    if (createBatch.length > 0) {
      const creates: Array<Omit<Task, 'id'>> = [];
      for (const remote of createBatch) {
        // Ledger gate: a remote id some local task once owned (released via a
        // source migration, or deleted) never mints a new local task — that
        // re-import is exactly how sync forked tasks into copies.
        if (isRemoteIdBlocked(pluginId, remote.remoteId)) {
          log.web.debug('sync-reconciler: skipped ledgered remote id', {
            pluginId, remoteId: remote.remoteId, title: remote.title,
          });
          continue;
        }
        // Claim gate: an id a LIVE local task already owns must never mint a
        // second task. computeDiff only reached toCreate because its in-memory
        // snapshot had not observed the owner's ext write yet — the ledger has.
        // This is the hole that forked three tasks on 2026-09-01.
        const claim = isRemoteIdClaimedByLiveTask(pluginId, remote.remoteId);
        if (claim.claimed) {
          log.web.warn('sync-reconciler: refused to create — remote id already owned by a live task', {
            pluginId, remoteId: remote.remoteId, title: remote.title, ownedBy: claim.byTaskId,
          });
          continue;
        }
        const fields = {
          ...remote.fields,
          source: pluginId as Task['source'],
          title: remote.fields.title ?? remote.title,
        } as Omit<Task, 'id'>;
        // A remote task pointing at another provider's project is NOT imported:
        // creating it would strand an unpushable minority-source task. It stays
        // remote-only until the claim or the remote grouping is changed.
        if ((await resolveProject(fields)) === 'conflict') continue;
        creates.push(fields);
      }
      try {
        const created = await addTasksBulk(creates);
        for (const task of created) {
          bus.emit(EventNames.TASK_CREATED, { task }, [], { source });
        }
        changeCount += created.length;
        outcome.created = created.length;
        // addTasksBulk applies its own refusals (retired sentinel titles, rows
        // whose project row vanished mid-batch). A silent gap here is how a
        // reconcile can look busy while writing nothing, so say it out loud.
        if (created.length !== creates.length) {
          log.web.warn('sync-reconciler: the store refused some creates', {
            pluginId, offered: creates.length, written: created.length,
            titles: creates.slice(0, 5).map((c) => c.title),
          });
        }
      } catch (err) {
        log.web.warn('sync-reconciler: bulk create failed', {
          pluginId,
          batchSize: creates.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Updates (batch limit: 100) — strip protected fields per row ──
    const updateBatch = diff.toUpdate.slice(0, 100);
    if (updateBatch.length > 0) {
      const updatesList: Array<{ id: string; patch: Partial<Task> }> = [];
      for (const { local, remote } of updateBatch) {
        const updates: Partial<Task> = { ...remote.fields };
        // MERGE ext, never replace: remote.fields.ext carries only what the
        // pull mapper knows ({id, list_id}); a wholesale write would wipe
        // plugin-side keys like previous_ids — the aliases the adopt pass
        // depends on — from the local row.
        if (updates.ext) {
          const pluginExt = {
            ...(local.ext?.[pluginId] as Record<string, unknown> | undefined),
            ...(updates.ext[pluginId] as Record<string, unknown> | undefined),
          };
          updates.ext = { ...local.ext, ...updates.ext, [pluginId]: pluginExt };
        }
        // Never overwrite local-only fields from remote
        delete (updates as any).note;
        delete (updates as any).summary;
        delete (updates as any).conversation_log;
        // Never overwrite session fields
        delete (updates as any).session_id;
        delete (updates as any).session_ids;
        delete (updates as any).plan_session_id;
        delete (updates as any).exec_session_id;
        // Drop any _syncedAt the remote mapping happened to carry…
        delete (updates as any)._syncedAt;
        // Never overwrite phase/status/read-marker from remote (RC8 fix). BOTH
        // marker keys must be dropped — leaving the legacy one through would let a
        // remote echo resurrect the dot on a task the user already read.
        const remoteClosed = remoteIsClosed(remote);
        const remoteCompletedAt = remote.fields.completed_at;
        delete (updates as any).phase;
        delete (updates as any).status;
        delete (updates as any).unread;
        // …with ONE exception: a remote CLOSE of a task still open here is applied.
        // It cannot be an echo (an echo of our own close would find the task already
        // COMPLETE), and it is the one state change a teammate makes that must land.
        // Skipping it while stamping _syncedAt below buried every remote close the
        // delta poll had missed: the watermark advanced past the close, so no later
        // cycle ever looked at it again. Same field set as applyPhase's COMPLETE
        // (read marker cleared); the raw bulk write does not derive it.
        if (remoteClosed && local.phase !== 'COMPLETE') {
          updates.phase = 'COMPLETE';
          updates.status = 'done';
          updates.unread = false;
          // The mapper's close time when it reports one; the remote's last-modified
          // stamp otherwise (the close is the last thing that happened to it).
          updates.completed_at = remoteCompletedAt ?? remote.remoteUpdatedAt;
        }
        // Claim conflict → keep the local project rather than moving the task
        // into another provider's group.
        if ((await resolveProject(updates)) === 'conflict') delete updates.project;
        // …then stamp OUR OWN: the remote's lastModified becomes the row's
        // sync watermark. Without this the LWW threshold never advances for
        // rows with NULL timestamps and the reconciler re-applies the SAME
        // update every cycle forever (28 identical `updated 1197` cycles
        // observed on 2026-08-20 before this fix).
        (updates as any)._syncedAt = remote.remoteUpdatedAt;
        updatesList.push({ id: local.id, patch: updates });
      }
      try {
        const { changed } = await updateTasksBulk(updatesList);
        for (const task of changed) {
          bus.emit(EventNames.TASK_UPDATED, { task }, [], { source });
        }
        changeCount += changed.length;
        outcome.updated = changed.length;
      } catch (err) {
        log.web.warn('sync-reconciler: bulk update failed', {
          pluginId,
          batchSize: updatesList.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Removes — filter out tasks with actively-running sessions ──
    if (diff.toRemove.length > 0) {
      // Snapshot session list once instead of per-task (hasActiveSession was
      // calling listSessions() for every candidate — O(n) filesystem reads).
      let sessionsSnapshot: Awaited<ReturnType<typeof import('./session-tracker.js').listSessions>> | null = null;
      try {
        const { listSessions } = await import('./session-tracker.js');
        sessionsSnapshot = await listSessions();
      } catch {
        sessionsSnapshot = null;
      }

      const idsToDelete: string[] = [];
      for (const task of diff.toRemove) {
        if (this.hasSessionHistory(task, sessionsSnapshot)) {
          log.web.info('sync-reconciler: skipping removal of task with session history', {
            pluginId,
            taskId: task.id,
            title: task.title,
          });
          continue;
        }
        idsToDelete.push(task.id);
      }

      if (idsToDelete.length > 0) {
        try {
          const { deleted } = await deleteTasksBulk(idsToDelete);
          for (const task of deleted) {
            bus.emit(EventNames.TASK_DELETED, { task }, [], { source });
            log.web.info('sync-reconciler: removed task no longer in remote', {
              pluginId,
              taskId: task.id,
              title: task.title,
            });
          }
          changeCount += deleted.length;
          outcome.removed = deleted.length;
        } catch (err) {
          log.web.warn('sync-reconciler: bulk delete failed', {
            pluginId,
            batchSize: idsToDelete.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Re-push completions the remote never received (batch limit: REPUSH_BATCH) ──
    // Through autoPushIfConfigured, the same path a fresh edit takes: success clears
    // sync_error and stamps _syncedAt, failure records sync_error for the retry loop.
    // A few pushes at a time: a plugin may debounce each push (2s for the tracker
    // plugin), so a serial batch of 50 would hold the tick for minutes.
    const repushQueue = diff.toRepush.slice(0, REPUSH_BATCH);
    let throttled = false;
    await Promise.all(Array.from({ length: Math.min(REPUSH_CONCURRENCY, repushQueue.length) }, async () => {
      while (!throttled) {
        const task = repushQueue.shift();
        if (!task) break;
        // autoPushIfConfigured reports plugin failures as {success:false}; only its
        // own bookkeeping (the ext write) can throw. Either way this task is one
        // failure and the batch goes on; a throw must not abort applyDiff after the
        // writes above already landed.
        const result = await autoPushIfConfigured(task).catch((err: unknown) => ({
          success: false as const, error: err instanceof Error ? err.message : String(err),
        }));
        if (result.success) {
          outcome.repushed++;
          log.web.info('sync-reconciler: pushed a completion the remote had never received', {
            pluginId, taskId: task.id, title: task.title, completedAt: task.completed_at,
          });
        } else {
          outcome.repushFailed++;
          log.web.warn('sync-reconciler: re-push of a lost completion failed', {
            pluginId, taskId: task.id, title: task.title, error: result.error,
          });
          // A rate limit answers every further push the same way until it cools
          // down: the rest of the batch waits for the retry loop / next cycle.
          if (isRateLimitError(result.error)) throttled = true;
        }
      }
    }));
    if (throttled) {
      log.web.warn('sync-reconciler: remote rate limit hit, re-push batch stopped early', {
        pluginId, pushed: outcome.repushed, failed: outcome.repushFailed, leftForNextCycle: repushQueue.length,
      });
    }

    // Single bulk signal to web-ui (mirrors the delta-sync batching in server.ts
    // so reconcile-only cycles still trigger a refetch). `ctx` is unused now
    // that we call task-manager bulk APIs directly; keep the parameter for
    // signature stability with the caller.
    void ctx;
    if (changeCount > 0) {
      bus.emit(
        EventNames.TASK_UPDATED,
        { task: null } as any,
        ['web-ui'],
        { source: `${pluginId}-reconcile-batch` },
      );
    }
    return outcome;
  }

  /**
   * Turn a repeated project refusal into something the human sees.
   *
   * One refused cycle is noise (a rename mid-pull, a project deleted seconds
   * ago). The SAME refusal on cycle after cycle is a standing mismatch that will
   * never resolve itself — which is exactly what ran unnoticed for 14 hours on
   * 2026-09-08 while the log cheerfully reported the refused items as `created`.
   * At REFUSAL_ESCALATE_TICKS the warn becomes a `log.error`, which the
   * notification bridge collapses into ONE deduped card per project.
   */
  private noteRefusals(
    pluginId: string,
    refusals: ApplyOutcome['refusals'],
  ): void {
    const seen = new Set<string>();
    for (const [project, info] of refusals) {
      const key = `${pluginId}:${project.toLowerCase()}`;
      seen.add(key);
      const streak = (this.refusalStreaks.get(key) ?? 0) + 1;
      this.refusalStreaks.set(key, streak);
      // Escalate ONCE per standing mismatch (not every cycle): the card exists to
      // tell the human something needs a decision, not to count cycles.
      if (streak !== REFUSAL_ESCALATE_TICKS) continue;
      log.web.error('Task sync cannot import a remote list', {
        pluginId,
        project,
        reason: info.reason,
        ...(info.claimedBy ? { claimedBy: info.claimedBy } : {}),
        items: info.items,
        consecutiveReconciles: streak,
        remedy: info.reason === 'local-project'
          ? `A list named "${project}" exists in ${pluginId} and a LOCAL project here shares that name, with no link between them. Rename one of the two, or delete the list in the provider's app.`
          : info.reason === 'deleted-project'
            ? `You deleted the project "${project}" here, but its list still exists in ${pluginId}. Delete the list there, or re-create the project to take the items back.`
            : `The project "${project}" is claimed by ${info.claimedBy ?? 'another provider'}, so ${pluginId} items cannot be filed under it.`,
      });
    }
    // A refusal that stopped happening must not keep an old streak alive — the
    // next occurrence starts a fresh count (and can escalate again).
    for (const key of [...this.refusalStreaks.keys()]) {
      if (key.startsWith(`${pluginId}:`) && !seen.has(key)) this.refusalStreaks.delete(key);
    }
  }

  /**
   * True when reconciler-driven removal must NOT touch this task because it
   * carries session history. Checks ALL session link fields — session_ids
   * included (1,641 tasks hold their ONLY session link there; the old
   * slot-only check let the reconciler delete them, which is how the H-1B RFE
   * task's session became unreachable). And ANY linked session blocks removal,
   * not just a running one: a remote item disappearing from a pull is not
   * authority to destroy local session history. Session-less tasks still
   * remove normally, so remote deletions keep propagating.
   */
  private hasSessionHistory(
    task: Task,
    sessions: Awaited<ReturnType<typeof import('./session-tracker.js').listSessions>> | null,
  ): boolean {
    const sessionIds = [
      task.session_id,
      task.plan_session_id,
      task.exec_session_id,
      ...(task.session_ids ?? []),
    ].filter(Boolean) as string[];
    if (sessionIds.length === 0) return false;
    if (!sessions) {
      // Couldn't load session list — be conservative and block removal.
      return true;
    }
    return sessionIds.some((sid) => sessions.some((s) => s.claudeSessionId === sid));
  }

  // ── Private: State persistence ──

  private stateFile(pluginId: string): string {
    return path.join(SYNC_DIR, `reconcile-${pluginId}.json`);
  }

  private loadState(pluginId: string): ReconcileState {
    const cached = this.stateCache.get(pluginId);
    if (cached) return cached;

    const filePath = this.stateFile(pluginId);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.stateCache.set(pluginId, data);
      return data;
    } catch {
      const fresh: ReconcileState = {
        deltaEpoch: 0,
        lastFullReconcileAt: new Date(0).toISOString(),
        lastFullPullCount: 0,
        updatedAt: new Date().toISOString(),
      };
      this.stateCache.set(pluginId, fresh);
      return fresh;
    }
  }

  private saveState(pluginId: string, state: ReconcileState): void {
    state.updatedAt = new Date().toISOString();
    this.stateCache.set(pluginId, state);
    try {
      fs.writeFileSync(this.stateFile(pluginId), JSON.stringify(state, null, 2));
    } catch (err) {
      log.web.warn('sync-reconciler: failed to save state', {
        pluginId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Singleton instance. */
export const syncReconciler = new SyncReconciler();
