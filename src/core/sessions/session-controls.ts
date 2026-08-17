/**
 * Session control core — model switch, effort switch, fork, and the picker's
 * model-options data. Shared by the web routes (src/web/routes/sessions.ts),
 * the /api/v1 mobile routes (session-control-v1.ts), and the daemon control
 * relay (cloud companion path) so there is exactly ONE implementation of each
 * behavior.
 *
 * Error contract: every validation/lookup failure throws SessionControlError
 * with an HTTP-ish statusCode (+ optional extra payload fields like
 * existing_session_id). Callers map it onto their own frozen error shape
 * (web: { error: string }, v1: { error: { code, message } }).
 *
 * All provider/tracker imports are dynamic — this module sits in core/ and a
 * static import of claude-code-session.ts (which itself imports half of core)
 * would risk a load cycle.
 */

import { randomUUID } from 'node:crypto';
import {
  VALID_SESSION_EFFORT_IDS,
  VALID_SESSION_MODEL_IDS,
  matchSessionModelCatalogEntry,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  resolveModelSwitchValue,
  sessionModelsAsCatalog,
  type SessionEffort,
  type SessionModelCatalogEntry,
} from '../types.js';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';

export class SessionControlError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SessionControlError';
  }
}

/** HTTP status → relay errorKind (same vocabulary as mobile-launch.ts). */
export function controlErrorKind(status: number): string {
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'internal';
  return 'bad_request';
}

// ── Effort ──────────────────────────────────────────────────────────────────

export interface EffortChangeResult {
  effort: SessionEffort;
  appliedLive: boolean;
  effectiveEffort?: string;
  overridden: boolean;
}

/**
 * Change a session's reasoning effort. Persists record.effort (cold --resume
 * re-applies --effort) and, when the CLI is live, pushes apply_flag_settings +
 * reads back the CLI's true effort. Capability authority order (do not
 * simplify — see the web route's original comment): (1) the live/host catalog
 * row's supportedEffortLevels, (2) its supportsEffort boolean (veto only for
 * xhigh/max), (3) the static model-family tables.
 */
export async function applySessionEffortChange(
  sessionId: string,
  rawEffort: unknown,
): Promise<EffortChangeResult> {
  if (typeof rawEffort !== 'string' || !VALID_SESSION_EFFORT_IDS.has(rawEffort)) {
    throw new SessionControlError('effort must be one of low/medium/high/xhigh/max', 400);
  }
  const effort = rawEffort as SessionEffort;

  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  const { getHostModelCatalog } = await import('../host-model-catalog.js');

  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('session not found', 404);

  const session = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined);
  const recordModel = record.cliModel || record.model;
  let model = recordModel;
  let liveRow: SessionModelCatalogEntry | null = null;
  if (session) {
    const [settings, catalog] = await Promise.all([
      session.getSettingsSnapshot().catch(() => null),
      session.getModelCatalog().catch(() => null),
    ]);
    model = settings?.applied.model || recordModel;
    liveRow = matchSessionModelCatalogEntry(catalog?.models ?? [], model);
  }
  if (!liveRow) {
    // Live catalog unavailable (dead session / CLI timeout): consult the
    // persisted host catalog — the SAME source the picker renders from — so
    // a level the UI shows enabled can't 409 here on static-table grounds.
    const hostCatalog = await getHostModelCatalog(record.host).catch(() => null);
    liveRow = matchSessionModelCatalogEntry(hostCatalog?.models ?? [], model);
  }

  // Effort-capability authority, most→least trusted: (1) the catalog row's
  // explicit supportedEffortLevels list, (2) its supportsEffort boolean (can
  // veto but not grant xhigh/max — those need the static per-family gate too),
  // (3) the static model tables as last resort (no catalog row anywhere).
  const liveLevels = liveRow?.supportedEffortLevels;
  const supported = liveLevels !== undefined
    ? liveLevels.includes(effort)
    : effort === 'xhigh'
      ? liveRow?.supportsEffort !== false && modelSupportsXhighEffort(model)
      : effort === 'max'
        ? liveRow?.supportsEffort !== false && modelSupportsMaxEffort(model)
        : liveRow?.supportsEffort ?? modelSupportsEffort(model);
  if (!supported) {
    throw new SessionControlError(
      `Model "${model ?? 'unknown'}" does not support "${effort}" reasoning effort`, 409,
    );
  }

  // Persist first so the badge + cold-resume fallback reflect the choice even
  // if the session isn't live right now.
  await updateSessionRecord(sessionId, { effort });

  let applied = false;
  let effectiveEffort: string | undefined;
  if (session) {
    try {
      applied = await session.applyEffort(effort);
      // The apply_flag_settings ACK returns success even when the CLI silently
      // overrides (env CLAUDE_CODE_EFFORT_LEVEL) or downgrades — read back the
      // CLI's true effort instead of trusting the ACK.
      if (applied) {
        effectiveEffort = (await session.refreshEffectiveEffort('effort-change').catch(() => null)) ?? undefined;
      }
    } catch (err) {
      // Non-fatal: the persisted effort still applies on the next (re)spawn.
      log.session.warn('applyEffort control_request failed — persisted for next spawn', {
        sessionId, effort, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const overridden = effectiveEffort !== undefined && effectiveEffort !== effort;
  log.session.info('session effort changed', { sessionId, effort, appliedLive: applied, effectiveEffort, overridden });
  return { effort, appliedLive: applied, effectiveEffort, overridden };
}

// ── Model ───────────────────────────────────────────────────────────────────

export type ModelChangeResult =
  | { model: string; cliModel: string; appliedLive: boolean; effectiveModel?: string }
  /** Codex/ACP sessions answer this simpler shape (same as the web route). */
  | { applied: true; model: string };

/**
 * Change a session's model mid-session. Persists record.cliModel (cold
 * --resume respawns with the new --model) and pushes apply_flag_settings when
 * the CLI is live, verifying via a get_settings read-back.
 */
export async function applySessionModelChange(
  sessionId: string,
  rawModel: unknown,
): Promise<ModelChangeResult> {
  if (typeof rawModel !== 'string' || !rawModel.trim()) {
    throw new SessionControlError('model must be a non-empty string', 400);
  }

  const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
  const { sessionRunner } = await import('../../providers/claude-code-session.js');

  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('session not found', 404);

  if (record.engine === 'codex') {
    const acpSession = await sessionRunner.findOrAttachAcpSession(sessionId).catch(() => undefined);
    const applied = acpSession
      ? await acpSession.setModel(rawModel).catch((err: unknown) => {
          log.session.warn('ACP session model switch failed', {
            sessionId, model: rawModel,
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        })
      : false;
    if (!applied) throw new SessionControlError('model switch failed', 409);
    log.session.info('ACP session model changed', { sessionId, model: rawModel });
    return { applied: true, model: rawModel };
  }

  const cliModel = resolveModelSwitchValue(rawModel);
  if (!cliModel) {
    throw new SessionControlError(
      `model must be a catalog value from the models endpoint or one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}`, 400,
    );
  }

  // Persist first — the durable cold-resume fallback (apply_flag_settings is
  // in-memory only).
  await updateSessionRecord(sessionId, { cliModel });

  let applied = false;
  let effectiveModel: string | undefined;
  const session = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined);
  if (session) {
    try {
      applied = await session.applyModel(cliModel);
      // The ACK is success even for a silently-ignored value — read back
      // applied.model as the truth.
      if (applied) {
        effectiveModel = (await session.refreshAppliedSettings('model-change').catch(() => null))?.model ?? undefined;
        // Read-back disagrees ⇒ the CLI rejected or substituted it. The cached
        // catalog is evidently stale — drop it so the picker refetches, and
        // report the switch did NOT take.
        if (effectiveModel && !modelReadBackMatches(cliModel, effectiveModel)) {
          applied = false;
          session.invalidateModelCatalog();
        }
      }
    } catch (err) {
      // Non-fatal: the persisted cliModel still applies on the next (re)spawn.
      log.session.warn('applyModel control_request failed — persisted for next spawn', {
        sessionId, model: cliModel, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.session.info('session model changed', { sessionId, model: rawModel, cliModel, appliedLive: applied, effectiveModel });
  return { model: rawModel, cliModel, appliedLive: applied, effectiveModel };
}

/** Does the get_settings read-back string plausibly equal what we switched to?
 *  Tolerates decoration differences: 'global.anthropic.claude-opus-4-6-v1[1m]'
 *  vs 'claude-opus-4-6[1m]' vs 'opus[1m]' all describe the same runtime model.
 *  Aliases ('opus', 'sonnet[1m]') can't be compared literally — for those we
 *  only require family containment. 'default' can resolve to anything → always
 *  matches (the CLI decides what default means). */
export function modelReadBackMatches(requested: string, effective: string): boolean {
  if (requested === 'default') return true;
  const strip = (s: string) => s.toLowerCase().replace(/\[1m\]$/, '').replace(/[-_]v\d+(:\d+)?$/, '');
  const req = strip(requested);
  const eff = strip(effective);
  if (req === eff || eff.includes(req) || req.includes(eff)) return true;
  // Alias forms: compare family + [1m]-ness instead of the raw strings.
  const fam = (s: string) => ['haiku', 'sonnet', 'fable', 'opus', 'mythos'].find((f) => s.includes(f));
  const is1m = (s: string) => /\[1m\]$/.test(s.toLowerCase());
  return fam(req) !== undefined && fam(req) === fam(eff) && is1m(requested) === is1m(effective);
}

// ── Model options (mobile picker data) ──────────────────────────────────────

export interface ModelOption {
  id: string;
  label: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: SessionEffort[];
}

export interface ModelOptionsResult {
  models: ModelOption[];
  /** Row id the picker should highlight (live applied model when readable,
   *  else the record's requested model). Null when unknown. */
  current: string | null;
  /** Effort level the picker should highlight. The CLI's TRUE applied effort when
   *  the live read succeeded, else the record's requested/last-known value. Must
   *  prefer live truth for the same reason the web pill does: the level often
   *  lives in the CLI's own settings.json, so `record.effort` is undefined and
   *  reading it alone made the sheet show a different level than the session runs. */
  currentEffort: string | null;
}

/**
 * Picker data for the mobile model sheet. Catalog authority order mirrors
 * GET /api/sessions/:id/models: live CLI catalog → the host's last-known
 * catalog → the static SESSION_MODELS registry (first install).
 */
export async function computeModelOptions(sessionId: string): Promise<ModelOptionsResult> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  const { getHostModelCatalog } = await import('../host-model-catalog.js');

  const record = await getSessionByClaudeId(sessionId);
  if (!record) throw new SessionControlError('session not found', 404);

  let entries: SessionModelCatalogEntry[] | null = null;
  let liveModel: string | null = null;
  let liveEffort: string | null = null;
  const session = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined);
  if (session) {
    const [settings, catalog] = await Promise.all([
      session.getSettingsSnapshot().catch(() => null),
      session.getModelCatalog().catch(() => null),
    ]);
    liveModel = settings?.applied.model ?? null;
    // applied.effort is the CLI's runtime truth (already reflects env overrides
    // and unsupported-level downgrades). Validate before trusting it so an
    // unknown future level can't reach the client as a selectable id.
    const rawEffort = settings?.applied.effort;
    liveEffort = typeof rawEffort === 'string' && VALID_SESSION_EFFORT_IDS.has(rawEffort)
      ? rawEffort
      : null;
    if (catalog && catalog.models.length > 0) entries = catalog.models;
    // Same reconcile the web picker's live pull does: one round-trip serves both
    // the sheet and the persisted record, so effectiveEffort stops being stale
    // for every other reader too.
    if (settings) void session.refreshAppliedSettings('model-options-pull', settings.applied).catch(() => null);
  }
  if (!entries) {
    const hostCatalog = await getHostModelCatalog(record.host).catch(() => null);
    entries = hostCatalog?.models && hostCatalog.models.length > 0
      ? hostCatalog.models
      : sessionModelsAsCatalog();
  }

  const models: ModelOption[] = entries
    .filter((e) => !e.disabled)
    .map((e) => ({
      id: e.value,
      label: e.displayName,
      ...(e.supportsEffort !== undefined ? { supportsEffort: e.supportsEffort } : {}),
      ...(e.supportedEffortLevels !== undefined ? { supportedEffortLevels: e.supportedEffortLevels } : {}),
    }));

  // Highlight the ACTIVE row: match the runtime model against the catalog so
  // `current` is a valid `id` from `models` whenever possible; fall back to
  // the raw model string so the client can at least display it.
  const runtimeModel = liveModel || record.cliModel || record.model || null;
  const activeRow = matchSessionModelCatalogEntry(entries, runtimeModel);
  return {
    models,
    current: activeRow?.value ?? runtimeModel,
    // Live truth first (see the field's doc comment) — the record is only the
    // fallback for a session the CLI couldn't answer for.
    currentEffort: liveEffort ?? record.effectiveEffort ?? record.effort ?? null,
  };
}

// ── Fork ────────────────────────────────────────────────────────────────────

export interface ForkSessionInput {
  task_id?: string;
  create_child_task?: boolean;
  child_title?: string;
  message?: string;
  title?: string;
  model?: string;
  /** Pre-built image context block ("read these files" annotation) — the web
   *  route builds it from uploaded images; v1/relay callers pass nothing. */
  imageContext?: string;
}

export interface ForkSessionResult {
  status: 'pending';
  sourceSessionId: string;
  sessionId: string;
  taskId: string;
  title: string;
  childTaskCreated?: boolean;
  host?: string;
}

/**
 * Fork a session onto another task (or a freshly-created sibling task).
 * Emits SESSION_START with forkedFromSessionId — session-runner performs the
 * actual `--resume --fork-session` spawn asynchronously; the returned
 * sessionId is pre-assigned and its record pre-seeded.
 */
export async function forkSessionToTask(
  sourceSessionId: string,
  input: ForkSessionInput,
  source = 'web-api',
): Promise<ForkSessionResult> {
  const { task_id, create_child_task, child_title, message, title, model, imageContext } = input;

  if (!task_id && !create_child_task) {
    throw new SessionControlError('Either task_id or create_child_task is required', 400);
  }
  if (task_id && create_child_task) {
    throw new SessionControlError('task_id and create_child_task are mutually exclusive', 400);
  }

  const { getSessionByClaudeId, getSessionsForTask, createSessionRecord } = await import('../session-tracker.js');
  const {
    getTask, addTask, togglePin, setFocusTier, updateTask, groupTasks, addToGroup, renameGroup,
  } = await import('../task-manager.js');

  const sourceRecord = await getSessionByClaudeId(sourceSessionId);
  if (!sourceRecord) throw new SessionControlError('Source session not found', 404);

  // Codex sessions run through ACP. The installed adapter does not advertise
  // ACP session.fork, and falling through to Claude's native --fork-session
  // creates an orphan task before failing to find the conversation. Fail
  // before validating or mutating any target task.
  if (sourceRecord.engine === 'codex') {
    throw new SessionControlError('Fork is unavailable for this Codex session', 409, {
      code: 'ACP_FORK_UNSUPPORTED',
    });
  }

  // Validate source session has a working directory BEFORE creating any child tasks
  if (!sourceRecord.cwd) {
    throw new SessionControlError('Source session has no working directory — cannot fork', 400);
  }

  let task: Task | undefined;
  let childTaskCreated = false;

  if (create_child_task) {
    // Fork = create a SIBLING task and visually group it with the source task
    // (NOT a parent/subtask — they have independent lifecycles). The new task
    // inherits the source task's project/source but has NO parent; we then put
    // both the source task and the fork into a lightweight virtual group
    // (reusing the source task's existing group if it already has one).
    if (!sourceRecord.taskId) {
      throw new SessionControlError('Source session has no task — cannot create fork task', 400);
    }
    let sourceTask: Task;
    try {
      sourceTask = await getTask(sourceRecord.taskId);
    } catch {
      throw new SessionControlError(`Source task "${sourceRecord.taskId}" not found`, 404);
    }
    // When the caller didn't supply an explicit child_title, use a plain
    // `Fork of <source>` placeholder now and (below, after addTask) refine it
    // asynchronously into `<2-4 word summary of the fork prompt> - fork of <source>`.
    //
    // Fork-of-a-fork: strip any existing fork decoration from the source title
    // first, otherwise titles compound without bound ("X - fork of Y - fork of
    // Z - …" reached 290+ chars in practice and permanently failed external
    // sync plugins with title-length limits).
    const sourceBaseTitle = sourceTask.title
      .replace(/^Fork of\s+/i, '')
      .replace(/\s+-\s+fork of\s+.*$/i, '')
      .trim() || sourceTask.title;
    const autoTitle = !child_title;
    const newTitle = child_title || `Fork of ${sourceBaseTitle}`;
    // No _skipPluginOps: a fork inherits the source's source (e.g. an external
    // sync plugin) and must pass the same content validation + push as any
    // other task. addTask throws on invalid content → surfaced to the caller.
    const { task: newFork } = await addTask({
      title: newTitle,
      project: sourceTask.project || '',
      source: sourceTask.source,
    });
    // Inherit the source's pin/tier so a fork of a Focus task lands in Focus
    // too — addTask() never sets focus_tier. Best-effort, non-fatal on failure.
    if (sourceTask.pinned && sourceTask.focus_tier) {
      try {
        await togglePin(newFork.id);
        await setFocusTier(newFork.id, sourceTask.focus_tier);
      } catch (err) {
        log.session.warn('fork: failed to inherit pin/tier from source', {
          taskId: newFork.id, sourceTaskId: sourceTask.id, tier: sourceTask.focus_tier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Visually group the source task + fork. Reuse the source task's existing
    // group if it already belongs to one. Best-effort: a grouping failure must
    // not abort the fork — the fork task still exists standalone.
    let forkGroupId: string | undefined;
    try {
      if (sourceTask.group_id) {
        const r = await addToGroup(sourceTask.group_id, [newFork.id]);
        forkGroupId = r.group_id;
      } else {
        // Seed label with the source title; refined to an AI group name below.
        const r = await groupTasks([sourceTask.id, newFork.id], sourceTask.title);
        forkGroupId = r.group_id;
      }
    } catch (err) {
      log.session.warn('fork: failed to group source + fork', {
        sourceTaskId: sourceTask.id, forkTaskId: newFork.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Emit task:created with the FINAL persisted state, not the stale addTask()
    // reference: togglePin/setFocusTier/grouping above all mutated store clones,
    // so `newFork` still says pinned=false / no focus_tier / no group_id.
    try {
      task = await getTask(newFork.id);
    } catch {
      task = newFork; // re-read is best-effort; stale beats no event
    }
    bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui', 'main-agent'], { source: 'fork' });
    childTaskCreated = true;

    // Refine the auto-generated title in the background: summarize the fork's
    // new prompt into a few English words → `<words> - fork of <source>`.
    // Fire-and-forget; failures keep the `Fork of <source>` placeholder.
    if (autoTitle && message?.trim()) {
      const forkId = newFork.id;
      const sourceTitle = sourceBaseTitle;
      const placeholderTitle = newTitle;
      void (async () => {
        try {
          const { summarizeForkPrompt } = await import('../fork-title.js');
          const label = await summarizeForkPrompt(message);
          if (!label) return;
          // Don't clobber a concurrent user rename: only refine if the title is
          // still the `Fork of <source>` placeholder we created moments ago.
          const current = await getTask(forkId);
          if (current.title !== placeholderTitle) {
            log.session.info('fork title refine skipped — title changed since fork', { taskId: forkId });
            return;
          }
          const refinedTitle = `${label} - fork of ${sourceTitle}`;
          const { task: updated } = await updateTask(forkId, { title: refinedTitle }, { source: 'fork-title' });
          bus.emit(EventNames.TASK_UPDATED, { task: updated }, ['web-ui', 'main-agent'], { source: 'fork-title' });
          log.session.info('fork title refined', { taskId: forkId, title: refinedTitle });
        } catch (err) {
          log.session.warn('fork title refine failed', {
            taskId: forkId, error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }

    // Refine the GROUP name in the background from both task titles (only when
    // we created a fresh group — an existing group keeps its established name).
    if (forkGroupId && !sourceTask.group_id) {
      const gid = forkGroupId;
      const seedTitles = [sourceTask.title, newTitle];
      void (async () => {
        try {
          const { summarizeGroupLabel } = await import('../fork-title.js');
          const label = await summarizeGroupLabel(seedTitles);
          if (!label) return;
          await renameGroup(gid, label);
          bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: gid, label }, ['web-ui', 'main-agent'], { source: 'fork' });
          log.session.info('fork group label refined', { groupId: gid, label });
        } catch (err) {
          log.session.warn('fork group label refine failed', {
            groupId: gid, error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    }
  } else {
    // Look up target task by provided task_id
    try {
      task = await getTask(task_id!);
    } catch {
      task = undefined;
    }
    if (!task) {
      throw new SessionControlError(`Task "${task_id}" not found`, 404);
    }
  }

  // Check 1-session-per-task
  const existingSessions = await getSessionsForTask(task.id);
  const activeSessions = existingSessions.filter((s) => !s.archived);
  if (activeSessions.length > 0) {
    throw new SessionControlError('Target task already has a session', 409, {
      existing_session_id: activeSessions[0].claudeSessionId,
    });
  }

  // A fork inherits the full parent conversation via --resume, so the model
  // tends to keep grinding on the parent's task. Lead with a focus directive.
  const userRequest = message?.trim() || `Continue working on: ${task.title}`;
  const FORK_FOCUS_PREFIX =
    'This is a forked session. Focus on the NEW request below — treat it as your primary task. ' +
    'Do not resume or continue the parent session\'s previous work unless the user explicitly asks you to.\n\n';
  const forkMessage = `${FORK_FOCUS_PREFIX}${imageContext ?? ''}New request:\n${userRequest}`;

  // Mint the fork's session id up front (--session-id composes with --resume
  // --fork-session). Returning it lets the client open the real forked panel
  // immediately instead of polling.
  const forkSessionId = randomUUID();
  const forkTitle = title ?? `Fork of ${sourceRecord.title ?? sourceSessionId.slice(0, 16)}`;

  // Seed the record before the spawn — the client opens the panel on this
  // response, and its first session read must not 404.
  try {
    await createSessionRecord(forkSessionId, task.id, task.project ?? '', sourceRecord.cwd, {
      title: forkTitle,
      mode: sourceRecord.mode !== 'default' ? sourceRecord.mode : undefined,
      host: sourceRecord.host,
      forkedFromSessionId: sourceSessionId,
      initialProcessStatus: 'idle',
      initialStatusReason: 'awaiting_spawn',
    });
  } catch (err) {
    log.session.warn('fork: pre-spawn session record seed failed', {
      sessionId: forkSessionId, taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Emit SESSION_START with forkedFromSessionId — handleStart() uses Claude
  // Code's native --resume + --fork-session to transfer conversation context.
  bus.emit(EventNames.SESSION_START, {
    preassignedSessionId: forkSessionId,
    taskId: task.id,
    message: forkMessage,
    cwd: sourceRecord.cwd,
    project: task.project ?? '',
    mode: sourceRecord.mode !== 'default' ? sourceRecord.mode : undefined,
    // Fork must resume on the EXACT same model as the parent — the CLI does
    // NOT inherit a session's model on --resume/--fork-session. `cliModel` is
    // the parent's original --model arg verbatim (incl. the [1m] marker);
    // never fall back to the reported `model` (a resolved id that LOST the
    // [1m] marker). An explicit request-body `model` still wins as override.
    model: model ?? sourceRecord.cliModel,
    title: forkTitle,
    host: sourceRecord.host,
    forkedFromSessionId: sourceSessionId,
  }, ['session-runner'], { source });

  return {
    status: 'pending',
    sourceSessionId,
    sessionId: forkSessionId,
    taskId: task.id,
    title: forkTitle,
    ...(childTaskCreated ? { childTaskCreated: true } : {}),
    ...(sourceRecord.host ? { host: sourceRecord.host } : {}),
  };
}

// ── Daemon control relay entry (cloud companion path) ───────────────────────

/**
 * Actions the `session.control` relay understands. The daemon forwards the
 * action string OPAQUELY (its allowlist gates the command name, not the
 * action), so extending this set needs no daemon protocol change — an OLD
 * PRIMARY simply answers `Unknown control action` (400) for actions it
 * predates, which the phone surfaces as a version-skew error.
 *
 * The `server.*` family are box-level requests (notifications feed) that ride
 * the same narrow relay; they ignore the sessionId (callers pass '__server__').
 */
export type SessionControlAction =
  | 'model' | 'effort' | 'fork' | 'model-options'
  // Wave 1 lifecycle family (2026-08):
  | 'patch' | 'terminate' | 'restart' | 'retry' | 'permission'
  | 'execute-continue' | 'changes' | 'history' | 'detail'
  // Wave 2 session-extras family (2026-08): provider controls, settings
  // snapshot, side questions, workflow/plan reads, subagent lanes,
  // execute-compact, and queued-message management.
  | 'controls' | 'controls.apply' | 'settings'
  | 'side-questions' | 'side-question.ask' | 'side-question.promote' | 'side-question.delete'
  | 'workflow' | 'plan' | 'subagent-history' | 'execute-compact'
  | 'queue' | 'queue.edit' | 'queue.delete'
  // Box-level family (sessionId ignored):
  | 'server.notifications' | 'server.notifications.mark-read' | 'server.notifications.dismiss'
  // Wave 2 box-level family: routines CRUD/control (single-writer: the
  // PRIMARY's cron engine owns cron-jobs.json — replicas never write it
  // locally, avoiding the dual-engine blind-write storms), the launcher's
  // host directory listing, and the composer's slash-command palette.
  | 'server.routines' | 'server.routines.actions' | 'server.routines.status'
  | 'server.routines.executors' | 'server.routines.get' | 'server.routines.create'
  | 'server.routines.patch' | 'server.routines.delete' | 'server.routines.toggle'
  | 'server.routines.run'
  // Wave 3: NL routine draft — an LLM call, so it runs where the model
  // credentials live (the answering box); a REPLICA relays to the primary.
  | 'server.routines.draft'
  | 'server.list-dirs' | 'server.slash-commands'
  // Wave 2 box-level family: file-explorer metadata (names/types only — file
  // CONTENT never rides the bridge; see files-v1.ts for the threat model).
  | 'server.files.list' | 'server.files.resolve'
  // Phase 4 box-level family: apply ONE cloud task op (create/update/delete/
  // reorder snapshot) on the primary's task store — the synchronous
  // replacement for the git outbox round trip. See core/task-outbox.ts
  // (applyTaskOp) + core/task-queue.ts (the cloud's dispatch + fallback).
  | 'server.tasks.apply'
  // Full-row task readback (additive 2026-08): the slim projection omits
  // description/note, so a REPLICA's GET /v1/tasks/:id relays here for the
  // primary's authoritative row when the bridge is up (local row = fallback).
  | 'server.tasks.get';

// ── Task op relay payload validation (server.tasks.apply) ───────────────────

/** A task op crossing the bridge is a FULL task snapshot; a fat description
 *  plus tags still fits well under this. The cap exists because one oversized
 *  frame (1009 close) kills every in-flight RPC on the shared bridge socket
 *  (2026-08-09 incident) — reject early instead of relaying garbage. */
const TASK_OP_MAX_BYTES = 256 * 1024;

/**
 * Validate the `server.tasks.apply` payload into a TaskOp, or throw a precise
 * SessionControlError. The op arrives from the cloud box (semi-trusted: it
 * holds no sync plugins and builds rows off the slim projection), so the shape
 * is checked here and the FIELD-level trust boundary stays where it already is
 * — applyTaskOp's UPDATE_WHITELIST.
 */
function parseTaskOpParams(p: Record<string, unknown>): import('../task-outbox.js').TaskOp {
  const raw = (p.op ?? p) as Record<string, unknown>;
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  } catch {
    throw new SessionControlError('op is not serializable', 400);
  }
  if (size > TASK_OP_MAX_BYTES) {
    throw new SessionControlError(`op too large (${size} > ${TASK_OP_MAX_BYTES} bytes)`, 400);
  }
  const opId = typeof raw.opId === 'string' ? raw.opId.trim() : '';
  if (!opId) throw new SessionControlError('op.opId is required', 400);
  const at = typeof raw.at === 'string' && raw.at ? raw.at : new Date().toISOString();
  if (raw.type === 'delete') {
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id) throw new SessionControlError('delete op requires op.id', 400);
    return { opId, type: 'delete', at, id };
  }
  // Order ops (additive 2026-08): a whole-list ordering, no per-row LWW clock.
  if (raw.type === 'reorder' || raw.type === 'reorder-pins') {
    const taskIds = raw.taskIds;
    if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((v) => typeof v === 'string')) {
      throw new SessionControlError(`${raw.type} op requires op.taskIds (non-empty string array)`, 400);
    }
    if (taskIds.length > 2000) {
      throw new SessionControlError('reorder op too large (max 2000 ids)', 400);
    }
    if (raw.type === 'reorder-pins') return { opId, type: 'reorder-pins', at, taskIds: taskIds as string[] };
    const project = typeof raw.project === 'string' ? raw.project : null;
    if (project === null) throw new SessionControlError('reorder op requires op.project (string; "" = Inbox)', 400);
    return { opId, type: 'reorder', at, project, taskIds: taskIds as string[] };
  }
  if (raw.type !== 'create' && raw.type !== 'update') {
    throw new SessionControlError('op.type must be one of: create, update, delete, reorder, reorder-pins', 400);
  }
  const task = raw.task as Partial<Task> | undefined;
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new SessionControlError(`${raw.type} op requires op.task`, 400);
  }
  if (typeof task.id !== 'string' || !task.id.trim()) {
    throw new SessionControlError('op.task.id is required', 400);
  }
  // updated_at is the LWW clock — an op without it could silently clobber a
  // newer primary edit (Date.parse(undefined) is NaN, and NaN <= x is false).
  if (typeof task.updated_at !== 'string' || Number.isNaN(Date.parse(task.updated_at))) {
    throw new SessionControlError('op.task.updated_at must be an ISO-8601 timestamp', 400);
  }
  if (raw.type === 'create') return { opId, type: 'create', at, task: task as Task };
  // Update extras (additive): `touched` scopes the patch to fields the sender
  // actually set; `append.note` concatenates instead of replacing. Malformed
  // shapes degrade to the legacy full-snapshot semantics rather than erroring.
  const touched = Array.isArray(raw.touched) && raw.touched.every((v) => typeof v === 'string')
    ? (raw.touched as string[])
    : undefined;
  const appendNote = (raw.append as Record<string, unknown> | undefined)?.note;
  return {
    opId, type: 'update', at, task: task as Task,
    ...(touched?.length ? { touched } : {}),
    ...(typeof appendNote === 'string' && appendNote ? { append: { note: appendNote } } : {}),
  };
}

/**
 * Entry point for the daemon control relay (phone → cloud → bridge →
 * `control-request` event → here, on the PRIMARY box). Returns the reply
 * envelope for the `control-result` command — never throws, so a validation
 * failure travels back to the phone as a precise 4xx instead of killing the
 * daemon WS handler.
 */
export async function handleSessionControlRelay(
  action: string,
  sessionId: unknown,
  params: unknown,
): Promise<
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string; errorKind: string; errorCode?: string }
> {
  try {
    if (typeof sessionId !== 'string' || !sessionId) {
      return { ok: false, error: 'sessionId is required', errorKind: 'bad_request' };
    }
    const p = (params ?? {}) as Record<string, unknown>;
    let result: Record<string, unknown>;
    switch (action) {
      case 'model':
        result = await applySessionModelChange(sessionId, p.model) as unknown as Record<string, unknown>;
        break;
      case 'effort':
        result = await applySessionEffortChange(sessionId, p.effort) as unknown as Record<string, unknown>;
        break;
      case 'fork':
        result = await forkSessionToTask(sessionId, {
          task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
          create_child_task: p.create_child_task === true,
          child_title: typeof p.child_title === 'string' ? p.child_title : undefined,
          message: typeof p.message === 'string' ? p.message : undefined,
          title: typeof p.title === 'string' ? p.title : undefined,
          model: typeof p.model === 'string' ? p.model : undefined,
        }, 'mobile-control-bridge') as unknown as Record<string, unknown>;
        break;
      case 'model-options':
        result = await computeModelOptions(sessionId) as unknown as Record<string, unknown>;
        break;
      // ── Wave 1 lifecycle family — same shared core the web routes use ──
      case 'patch': {
        const { patchSession } = await import('./session-lifecycle.js');
        const session = await patchSession(sessionId, p);
        result = { session } as unknown as Record<string, unknown>;
        break;
      }
      case 'terminate': {
        const { terminateSession } = await import('./session-lifecycle.js');
        result = await terminateSession(sessionId, { force: p.force === true }) as unknown as Record<string, unknown>;
        break;
      }
      case 'restart': {
        const { restartSession } = await import('./session-lifecycle.js');
        result = await restartSession(sessionId) as unknown as Record<string, unknown>;
        break;
      }
      case 'retry': {
        const { retrySession } = await import('./session-lifecycle.js');
        result = await retrySession(sessionId) as unknown as Record<string, unknown>;
        break;
      }
      case 'permission': {
        const { respondSessionPermission } = await import('./session-lifecycle.js');
        // `answers` = AskUserQuestion decision relayed from the cloud replica /
        // phone; validated (plain object of strings) inside respondSessionPermission.
        result = await respondSessionPermission(sessionId, p.requestId, p.allow, p.message, p.optionId, p.answers) as unknown as Record<string, unknown>;
        break;
      }
      case 'execute-continue': {
        const { executeContinueSession } = await import('./session-lifecycle.js');
        result = await executeContinueSession(sessionId) as unknown as Record<string, unknown>;
        break;
      }
      case 'changes': {
        const { getSessionChanges } = await import('./session-lifecycle.js');
        result = await getSessionChanges(sessionId, {
          base: p.base, scope: p.scope,
          light: p.light === true, refresh: p.refresh === true,
        });
        break;
      }
      case 'history': {
        const { readSessionRichHistory } = await import('./session-lifecycle.js');
        const tail = typeof p.tail === 'number' && p.tail > 0 ? Math.floor(p.tail) : undefined;
        result = await readSessionRichHistory(sessionId, tail) as unknown as Record<string, unknown>;
        break;
      }
      case 'detail': {
        const { getSessionDetail } = await import('./session-lifecycle.js');
        result = await getSessionDetail(sessionId) as unknown as Record<string, unknown>;
        break;
      }
      // ── Wave 2 session-extras family — same shared core the web routes use ──
      case 'controls': {
        const { getSessionControls } = await import('./session-extras.js');
        result = await getSessionControls(sessionId) as unknown as Record<string, unknown>;
        break;
      }
      case 'controls.apply': {
        const { applySessionControl } = await import('./session-extras.js');
        result = await applySessionControl(sessionId, p.id, p.value) as unknown as Record<string, unknown>;
        break;
      }
      case 'settings': {
        const { getSessionSettings } = await import('./session-extras.js');
        result = await getSessionSettings(sessionId, p.details === true) as unknown as Record<string, unknown>;
        break;
      }
      case 'side-questions': {
        const { listSessionSideQuestions } = await import('./session-extras.js');
        result = await listSessionSideQuestions(sessionId) as unknown as Record<string, unknown>;
        break;
      }
      case 'side-question.ask': {
        const { askSessionSideQuestion } = await import('./session-extras.js');
        result = await askSessionSideQuestion(sessionId, p.question) as unknown as Record<string, unknown>;
        break;
      }
      case 'side-question.promote': {
        const { promoteSessionSideQuestion } = await import('./session-extras.js');
        result = await promoteSessionSideQuestion(sessionId, String(p.id ?? '')) as unknown as Record<string, unknown>;
        break;
      }
      case 'side-question.delete': {
        const { removeSessionSideQuestion } = await import('./session-extras.js');
        result = await removeSessionSideQuestion(sessionId, String(p.id ?? '')) as unknown as Record<string, unknown>;
        break;
      }
      case 'workflow': {
        const { getSessionWorkflowPayload } = await import('./session-extras.js');
        // null (no workflow ran) rides the relay as { workflow: null } so the
        // ok/result envelope stays an object.
        result = { workflow: await getSessionWorkflowPayload(sessionId) };
        break;
      }
      case 'plan': {
        const { getSessionPlanPayload } = await import('./session-extras.js');
        result = await getSessionPlanPayload(sessionId) as unknown as Record<string, unknown>;
        break;
      }
      case 'subagent-history': {
        const { getSubagentHistoryPayload } = await import('./session-extras.js');
        result = await getSubagentHistoryPayload(
          sessionId, String(p.agentId ?? ''), p.workflow === true,
        ) as unknown as Record<string, unknown>;
        break;
      }
      case 'execute-compact': {
        const { executeCompactSession } = await import('./session-extras.js');
        result = await executeCompactSession(sessionId, {
          task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
          working_directory: typeof p.working_directory === 'string' ? p.working_directory : undefined,
          instructions: typeof p.instructions === 'string' ? p.instructions : undefined,
          mode: typeof p.mode === 'string' ? p.mode : undefined,
        }) as unknown as Record<string, unknown>;
        break;
      }
      case 'queue': {
        const { getSessionQueuePayload } = await import('./session-extras.js');
        result = await getSessionQueuePayload(sessionId) as unknown as Record<string, unknown>;
        break;
      }
      case 'queue.edit': {
        const { editSessionQueuedMessage } = await import('./session-extras.js');
        result = await editSessionQueuedMessage(sessionId, String(p.messageId ?? ''), p.text) as unknown as Record<string, unknown>;
        break;
      }
      case 'queue.delete': {
        const { deleteSessionQueuedMessage } = await import('./session-extras.js');
        result = await deleteSessionQueuedMessage(sessionId, String(p.messageId ?? '')) as unknown as Record<string, unknown>;
        break;
      }
      // ── Box-level family (sessionId ignored — notifications live on the primary) ──
      case 'server.notifications': {
        const { listNotifications } = await import('../notifications/store.js');
        result = await listNotifications() as unknown as Record<string, unknown>;
        break;
      }
      case 'server.notifications.mark-read': {
        const { markRead } = await import('../notifications/store.js');
        const ids = Array.isArray(p.ids) && p.ids.every((v) => typeof v === 'string')
          ? p.ids as string[] : undefined;
        result = await markRead(ids) as unknown as Record<string, unknown>;
        break;
      }
      case 'server.notifications.dismiss': {
        const { dismissNotifications } = await import('../notifications/store.js');
        const ids = Array.isArray(p.ids) && p.ids.every((v) => typeof v === 'string')
          ? p.ids as string[] : undefined;
        const dedupKeys = Array.isArray(p.dedupKeys) && p.dedupKeys.every((v) => typeof v === 'string')
          ? p.dedupKeys as string[] : undefined;
        result = await dismissNotifications({ ids, dedupKeys }) as unknown as Record<string, unknown>;
        break;
      }
      // ── Wave 2 box-level family: routines (PRIMARY's engine is the single writer) ──
      case 'server.routines':
      case 'server.routines.actions':
      case 'server.routines.status':
      case 'server.routines.executors':
      case 'server.routines.get':
      case 'server.routines.create':
      case 'server.routines.patch':
      case 'server.routines.delete':
      case 'server.routines.toggle':
      case 'server.routines.run':
      case 'server.routines.draft': {
        const { handleRoutinesRelayAction } = await import('../routines/routines-core.js');
        result = await handleRoutinesRelayAction(action.slice('server.routines'.length).replace(/^\./, '') || 'list', p);
        break;
      }
      case 'server.list-dirs': {
        const { listSessionDirs } = await import('./session-extras.js');
        result = await listSessionDirs(
          p.prefix, typeof p.host === 'string' && p.host ? p.host : undefined, p.depth,
        ) as unknown as Record<string, unknown>;
        break;
      }
      case 'server.slash-commands': {
        const { buildSlashCommandItems } = await import('../../web/routes/slash-commands.js');
        result = await buildSlashCommandItems({
          cwd: typeof p.cwd === 'string' ? p.cwd : undefined,
          host: typeof p.host === 'string' && p.host ? p.host : undefined,
          fresh: p.fresh === true,
        }) as unknown as Record<string, unknown>;
        break;
      }
      case 'server.files.list': {
        const { listSessionFiles, FilesOpError } = await import('../../web/routes/files.js');
        try {
          result = await listSessionFiles(
            p.path, typeof p.host === 'string' && p.host ? p.host : undefined, p.showHidden === true,
          ) as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof FilesOpError) throw new SessionControlError(err.message, err.statusCode);
          throw err;
        }
        break;
      }
      case 'server.files.resolve': {
        const { resolveSessionPath, FilesOpError } = await import('../../web/routes/files.js');
        try {
          result = await resolveSessionPath(
            p.rel, p.cwd, typeof p.host === 'string' && p.host ? p.host : undefined,
          ) as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof FilesOpError) throw new SessionControlError(err.message, err.statusCode);
          throw err;
        }
        break;
      }
      // ── Phase 4 box-level family: one cloud task op, applied synchronously ──
      // Replaces the git outbox round trip (3 git hops, 1-3 min) with a ~100ms
      // RPC. Idempotent by construction — absolute snapshots + LWW + a bounded
      // recently-applied opId set — so a replayed op (lost response, or the
      // same op also arriving as a legacy git file) is safe.
      case 'server.tasks.apply': {
        const op = parseTaskOpParams(p);
        const { applyTaskOp } = await import('../task-outbox.js');
        const outcome = await applyTaskOp(op);
        result = { ...outcome, opId: op.opId };
        break;
      }
      case 'server.tasks.get': {
        const id = typeof p.id === 'string' ? p.id.trim() : '';
        if (!id) throw new SessionControlError('id is required', 400);
        const tm = await import('../task-manager.js');
        try {
          result = { task: await tm.getTask(id) as unknown as Record<string, unknown> };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/No task found/i.test(msg)) throw new SessionControlError(msg, 404);
          if (/Ambiguous ID prefix/i.test(msg)) throw new SessionControlError(msg, 400);
          throw err;
        }
        break;
      }
      default:
        return { ok: false, error: `Unknown control action: ${action}`, errorKind: 'bad_request' };
    }
    return { ok: true, result };
  } catch (err) {
    if (err instanceof SessionControlError) {
      // Domain error codes (e.g. terminate's 'cron_owner') ride along so the
      // cloud route can surface the same v1 error code as the local path.
      const errorCode = typeof err.extra?.code === 'string' ? err.extra.code : undefined;
      return {
        ok: false, error: err.message, errorKind: controlErrorKind(err.statusCode),
        ...(errorCode ? { errorCode } : {}),
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.session.error('session control relay failed', { action, error: message });
    return { ok: false, error: message, errorKind: 'internal' };
  }
}
