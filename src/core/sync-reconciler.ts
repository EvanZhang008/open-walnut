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
  deleteTasksBulk,
  ensureProject,
  InvalidProjectNameError,
  isPushInflight,
  updateTasksBulk,
} from './task-manager.js';
import { bus, EventNames } from './event-bus.js';
import { isLegacyInboxGroup, isRetiredQuickStartGroup } from '../utils/format.js';
import { isRemoteIdBlocked } from './task-remote-links.js';
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
  unchanged: number;
}

// ── SyncReconciler ──

export class SyncReconciler {
  private stateCache = new Map<string, ReconcileState>();
  private isFirstTick = new Map<string, boolean>();

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
      const remoteItems = await plugin.sync.fullPull(ctx);
      if (!remoteItems) {
        log.web.debug('sync-reconciler: fullPull returned null/undefined, skipping', { pluginId: plugin.id });
        this.saveState(plugin.id, state);
        return;
      }

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
      await this.applyDiff(diff, ctx, plugin.id);

      // Update state on success
      state.deltaEpoch = 0;
      state.lastFullReconcileAt = new Date().toISOString();
      state.lastFullPullCount = remoteItems.length;
      state.updatedAt = new Date().toISOString();
      this.saveState(plugin.id, state);

      log.web.info('sync-reconciler: full reconcile complete', {
        pluginId: plugin.id,
        remoteCount: remoteItems.length,
        created: diff.toCreate.length,
        updated: diff.toUpdate.length,
        removed: diff.toRemove.length,
        unchanged: diff.unchanged,
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
        const ECHO_GRACE_MS = 10_000;
        const remoteTime = new Date(remote.remoteUpdatedAt).getTime();
        const syncedAt = local._syncedAt ? new Date(local._syncedAt).getTime() : 0;
        const localUpdatedAt = local.updated_at ? new Date(local.updated_at).getTime() : 0;
        const threshold = Math.max(syncedAt, localUpdatedAt);
        if (remoteTime > threshold + ECHO_GRACE_MS) {
          toUpdate.push({ local, remote });
        } else {
          unchanged++;
        }
        continue;
      }
      const aliasOwner = localByAlias.get(remoteId);
      if (aliasOwner && !isPushInflight(aliasOwner.id)) {
        // The remote item wears an id this task USED to have — adopt it back
        // (re-point ext to the current remote id) instead of forking a copy.
        toAdopt.push({ local: aliasOwner, remote });
        adoptedTaskIds.add(aliasOwner.id);
        continue;
      }
      toCreate.push(remote);
    }

    // local - remote → candidate for removal (adopted tasks are matched)
    for (const [remoteId, local] of localByRemoteId) {
      if (!remoteMap.has(remoteId) && !adoptedTaskIds.has(local.id)) {
        toRemove.push(local);
      }
    }

    // Tasks without remote ID are left alone (can't reconcile without a join key)
    unchanged += localWithoutRemoteId.length;

    return { toCreate, toUpdate, toAdopt, toRemove, unchanged };
  }

  // ── Private: Apply diff ──

  private async applyDiff(
    diff: ReconcileDiffResult,
    ctx: SyncPollContext,
    pluginId: string,
  ): Promise<void> {
    const source = `${pluginId}-reconcile`;
    let changeCount = 0;

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
    const ensuredProjects = new Map<string, string | 'conflict'>(); // lower(name) → canonical
    const resolveProject = async (fields: Partial<Task>): Promise<'ok' | 'conflict'> => {
      const name = (fields.project ?? '').trim();
      if (!name) return 'ok';
      // Retired grouping names are Inbox, and Inbox can't hold provider tasks —
      // same pull-side rule as routePulledListToProject. Without this, a remote
      // task still tagged with the retired name resurrects it as a claimed
      // project on every full pull (the v5 repair deleted these rows once).
      if (isRetiredQuickStartGroup(name) || isLegacyInboxGroup(name)) {
        log.web.warn('sync-reconciler: remote task grouped under a retired name — not imported/moved', {
          pluginId, project: name,
        });
        return 'conflict';
      }
      const key = name.toLowerCase();
      let canonical = ensuredProjects.get(key);
      if (canonical === undefined) {
        try {
          const ensured = await ensureProject(name, pluginId as Task['source']);
          canonical = ensured.source === pluginId ? ensured.name : 'conflict';
          if (canonical === 'conflict') {
            log.web.warn('sync-reconciler: remote task targets a project claimed by another provider', {
              pluginId, project: name, claimedBy: ensured.source,
            });
          }
        } catch (err) {
          if (!(err instanceof InvalidProjectNameError)) throw err;
          log.web.warn('sync-reconciler: invalid project name from remote — leaving project unchanged', {
            pluginId, project: name,
          });
          canonical = '';
        }
        ensuredProjects.set(key, canonical);
      }
      if (canonical === 'conflict') return 'conflict';
      if (canonical) fields.project = canonical;
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
        delete (updates as any).phase;
        delete (updates as any).status;
        delete (updates as any).unread;
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
        } catch (err) {
          log.web.warn('sync-reconciler: bulk delete failed', {
            pluginId,
            batchSize: idsToDelete.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
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
