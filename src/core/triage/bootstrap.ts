/**
 * Turning `config.triage` into the ONE routine that runs Inbox Triage.
 *
 * Shape of the thing being built — nothing here is a new concept, it is three
 * existing routine parts composed:
 *
 *   schedule      { kind:'every', everyMs }                 the clock
 *   wake          { events, countField:'count', threshold,  the counter (S11)
 *                   skipWhenIdle:true }
 *   initProcessor { actionId:'inbox-triage-batch' }          the batch (S13)
 *   executor      { type:'claude-code', … }                  a NEW task+session
 *                                                            per run (decision D2)
 *
 * Three rules this file exists to keep:
 *
 *  - ONE routine, ever. Found by its init-processor action id first (a marker the
 *    routine form cannot erase — it does not render initProcessor) and by name
 *    second, so a rename does not produce a second routine on the next enable.
 *
 *  - Enabling creates NO task and NO session. Each run mints its own task and
 *    session through the executor, so there is nothing to pre-create; that is
 *    also why nothing here is gated on backgroundAiDisabled() — no model call
 *    happens at enable time, and gating the wiring would leave it untested.
 *
 *  - Disabling DISABLES, never deletes. The run history under "Ask Inbox Triage"
 *    and the notes under notes/Walnut/Triage/ ARE the cross-run memory.
 *
 * Active hours are STORED here (on nothing — they stay in config) and enforced
 * in the batch action; see the note on isTriageWithinActiveHours in config.ts for
 * why that is the only place that can decline a fire without minting a session.
 *
 * ONE thing S13 must land with the action: an initProcessor naming an action that
 * does not exist does NOT fail the run. src/actions/registry.ts answers
 * `{invoke:false, content:'Action "…" not found'}`, the server's runAction adapter
 * maps any `invoke:false` to `{status:'ok', summary: content}`, and executeJobCore
 * then prepends that sentence to the instructions and starts a session anyway. It
 * never crashes, but it is not an error result either — so between this slice and
 * the action landing, an ENABLED triage would mint a batch-less session per
 * interval. Triage is off by default, which is what keeps that window harmless.
 */

import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { bus, EventNames } from '../event-bus.js';
import { askProjectFor } from '../sessions/ask-agent.js';
import type { CronJob, CronWake } from '../cron/types.js';
import { readTriageConfig, type ResolvedTriageConfig, type TriageConfigHolder } from './config.js';
import { triageRunRules } from './letter-rules.js';
import {
  TRIAGE_ACTION_ID,
  TRIAGE_ACTION_TIMEOUT_SECONDS,
  TRIAGE_AGENT_ID,
  TRIAGE_AGENT_NAME,
  TRIAGE_ROUTINE_NAME,
  TRIAGE_TITLE_TEMPLATE,
  TRIAGE_WAKE_COUNT_FIELD,
} from './types.js';

/** The bus subscriber name. Re-subscribing overwrites it (never two). */
export const TRIAGE_CONFIG_SUBSCRIBER = 'triage-config';

/** The project a run's task is filed under — the drawer lists it per agent. */
export const TRIAGE_PROJECT = askProjectFor({ id: TRIAGE_AGENT_ID, name: TRIAGE_AGENT_NAME });

/** The routine's one-line description, shown on its card. */
const TRIAGE_ROUTINE_DESCRIPTION =
  'Reads each batch of new mail and Slack, matches it to your projects and tasks, '
  + 'keeps the tracking notes true, and asks you about anything that needs a decision.';

/**
 * The instructions every run is launched with. The batch action's summary is
 * prepended by the cron engine (`initOutput + "\n\n" + instructions`), so this is
 * the part that never changes: what to do, in what order, and where the memory
 * lives. The detail is in the skill, which the session's injected index carries.
 */
export const TRIAGE_RUN_INSTRUCTIONS = [
  'You are running one Inbox Triage batch. Read the batch above.',
  '',
  'Follow the walnut-inbox-triage skill. In order: read notes/Walnut/Triage/State.md,',
  'read what you need about each item, match items to the projects and tasks that',
  'already exist, update the tracking notes, ask the tasks that are affected, then',
  'write at most one summary letter and at most three decision letters.',
  '',
  'Before you finish: rewrite notes/Walnut/Triage/State.md, append one line to',
  'notes/Walnut/Triage/Runs/<YYYY-MM>.md, and memory_write anything durable you',
  'learned. Never send mail, post to Slack, mark anything read or unsubscribe on',
  'your own — ask. Never invent a project or a task.',
].join('\n');

/**
 * The instructions for ONE mode — the fixed part plus the letter budget and the
 * mode's own permissions (letter-rules.ts).
 *
 * `mode` therefore rides the routine DEFINITION, which is why `matchesSpec`
 * compares `instructions`: without that, flipping ask → assist in Settings would
 * leave every future run reading the old rules until something else drifted.
 */
export function triageInstructionsFor(resolved: ResolvedTriageConfig): string {
  return `${TRIAGE_RUN_INSTRUCTIONS}\n\n${triageRunRules(resolved.mode, resolved.autoMarkRead)}`;
}

// ── Injectable seams (the live routines layer by default) ──

export type TriageBootstrapDeps = {
  getConfig?: () => Promise<TriageConfigHolder>;
  listRoutines?: () => Promise<CronJob[]>;
  createRoutine?: (body: unknown) => Promise<{ job: unknown }>;
  patchRoutine?: (id: string, body: unknown) => Promise<{ job: unknown }>;
  /** Resolve the console agent a run speaks as; undefined = it does not exist. */
  resolveAgent?: (id: string) => Promise<{ id: string; name: string } | undefined>;
};

async function defaultGetConfig(): Promise<TriageConfigHolder> {
  const { getConfig } = await import('../config-manager.js');
  return await getConfig() as TriageConfigHolder;
}

async function defaultListRoutines(): Promise<CronJob[]> {
  const { listRoutines } = await import('../routines/routines-core.js');
  const { jobs } = await listRoutines(true);
  return jobs as CronJob[];
}

async function defaultCreateRoutine(body: unknown): Promise<{ job: unknown }> {
  const { createRoutine } = await import('../routines/routines-core.js');
  return await createRoutine(body);
}

async function defaultPatchRoutine(id: string, body: unknown): Promise<{ job: unknown }> {
  const { patchRoutine } = await import('../routines/routines-core.js');
  return await patchRoutine(id, body);
}

async function defaultResolveAgent(id: string): Promise<{ id: string; name: string } | undefined> {
  const { resolveAskAgent } = await import('../sessions/ask-agent.js');
  return await resolveAskAgent(id);
}

// ── The desired routine ──

/** The wake block for these sources, or undefined when there are none. */
function wakeFor(resolved: ResolvedTriageConfig): CronWake | undefined {
  if (resolved.wakeEvents.length === 0) return undefined;
  return {
    events: resolved.wakeEvents,
    countField: TRIAGE_WAKE_COUNT_FIELD,
    threshold: resolved.everyMessages,
    // A timed batch with nothing new in it costs a whole session for no reason.
    // Only safe BECAUSE there are events to count: with no wake block at all the
    // clock runs unconditionally, which is what a sources-less config wants.
    skipWhenIdle: true,
  };
}

/** The routine triage wants to exist, as create/patch input. */
export function buildTriageRoutineSpec(resolved: ResolvedTriageConfig): Record<string, unknown> {
  const wake = wakeFor(resolved);
  return {
    name: TRIAGE_ROUTINE_NAME,
    description: TRIAGE_ROUTINE_DESCRIPTION,
    enabled: true,
    schedule: { kind: 'every', everyMs: resolved.everyMs },
    // `null` CLEARS a stored wake (a user who removed every source), where an
    // absent key would leave the old one counting.
    wake: wake ?? null,
    initProcessor: {
      actionId: TRIAGE_ACTION_ID,
      invokeAgent: true,
      timeoutSeconds: TRIAGE_ACTION_TIMEOUT_SECONDS,
    },
    executor: {
      type: 'claude-code',
      config: {
        instructions: triageInstructionsFor(resolved),
        cwd: WALNUT_HOME,
        walnutAgent: true,
        agentId: TRIAGE_AGENT_ID,
        project: TRIAGE_PROJECT,
        titleTemplate: TRIAGE_TITLE_TEMPLATE,
      },
    },
  };
}

/**
 * Triage's own routine, by its action-id marker first and its name second.
 *
 * The marker is the durable half: the routine form never renders initProcessor,
 * so a save cannot drop it, and the user is free to rename the card.
 */
export function findTriageRoutine(jobs: CronJob[]): CronJob | undefined {
  return jobs.find((j) => j.initProcessor?.actionId === TRIAGE_ACTION_ID)
    ?? jobs.find((j) => j.name === TRIAGE_ROUTINE_NAME);
}

/** Does the stored routine already match the spec in every field we own? */
function matchesSpec(job: CronJob, spec: Record<string, unknown>): boolean {
  const schedule = spec.schedule as { everyMs: number };
  if (!job.enabled) return false;
  // Defensive about the stored shape: this runs over whatever is in
  // cron-jobs.json, including a routine a much older build wrote.
  if (job.schedule?.kind !== 'every' || job.schedule.everyMs !== schedule.everyMs) return false;
  const wantWake = spec.wake as CronWake | null;
  const haveWake = job.wake;
  if (!wantWake !== !haveWake) return false;
  if (wantWake && haveWake) {
    if (wantWake.threshold !== haveWake.threshold) return false;
    if (wantWake.countField !== haveWake.countField) return false;
    if (wantWake.skipWhenIdle !== (haveWake.skipWhenIdle ?? false)) return false;
    if (wantWake.events.join('\u0000') !== haveWake.events.join('\u0000')) return false;
  }
  if (job.initProcessor?.actionId !== TRIAGE_ACTION_ID) return false;
  const wantExec = spec.executor as { type: string; config: Record<string, unknown> };
  const haveExec = job.executor;
  if (!haveExec || haveExec.type !== wantExec.type) return false;
  const haveConfig = haveExec.config ?? {};
  // `instructions` is in the list because `triage.mode` / `auto_mark_read` only
  // reach a run through it (triageInstructionsFor): leaving it out would make a
  // mode change in Settings silently take effect "some time later".
  for (const key of ['cwd', 'agentId', 'project', 'titleTemplate', 'walnutAgent', 'instructions'] as const) {
    if (haveConfig[key] !== wantExec.config[key]) return false;
  }
  return true;
}

export type TriageBootstrapOutcome =
  | 'created'          // the routine did not exist and now does
  | 'patched'          // it existed and drifted from the config
  | 'unchanged'        // it existed and already matched
  | 'disabled'         // triage is off and the routine was enabled
  | 'already-disabled' // triage is off and the routine was already off
  | 'absent'           // triage is off and no routine exists (fresh install)
  | 'no-agent';        // the console agent is missing — refused

export type TriageBootstrapResult = {
  outcome: TriageBootstrapOutcome;
  jobId?: string;
  resolved: ResolvedTriageConfig;
};

/**
 * Bring the routine in line with `config.triage`. Idempotent: safe to call at
 * boot, on every config change, and twice in a row.
 */
export async function ensureTriageRoutine(
  deps: TriageBootstrapDeps = {},
): Promise<TriageBootstrapResult> {
  const getConfig = deps.getConfig ?? defaultGetConfig;
  const listRoutines = deps.listRoutines ?? defaultListRoutines;
  const createRoutine = deps.createRoutine ?? defaultCreateRoutine;
  const patchRoutine = deps.patchRoutine ?? defaultPatchRoutine;
  const resolveAgent = deps.resolveAgent ?? defaultResolveAgent;

  const resolved = readTriageConfig(await getConfig());
  const existing = findTriageRoutine(await listRoutines());

  if (!resolved.enabled) {
    if (!existing) {
      log.cron.debug('triage: disabled and no routine exists', { reason: resolved.disabledReason });
      return { outcome: 'absent', resolved };
    }
    if (!existing.enabled) return { outcome: 'already-disabled', jobId: existing.id, resolved };
    await patchRoutine(existing.id, { enabled: false });
    log.cron.info('triage: disabled — the routine is kept (its runs and notes are the memory)', {
      jobId: existing.id, reason: resolved.disabledReason,
    });
    return { outcome: 'disabled', jobId: existing.id, resolved };
  }

  // A run launches as the 'triage' console agent. Refuse rather than create a
  // routine whose every fire would fail at session start.
  if (!await resolveAgent(TRIAGE_AGENT_ID)) {
    log.cron.error('triage: the console agent is missing — not creating the routine', {
      agentId: TRIAGE_AGENT_ID,
    });
    return { outcome: 'no-agent', ...(existing ? { jobId: existing.id } : {}), resolved };
  }

  const spec = buildTriageRoutineSpec(resolved);
  if (!existing) {
    const { job } = await createRoutine(spec);
    const jobId = (job as CronJob | undefined)?.id;
    log.cron.info('triage: routine created', {
      jobId, everyMs: resolved.everyMs, threshold: resolved.everyMessages,
      sources: resolved.sources, mode: resolved.mode,
    });
    return { outcome: 'created', ...(jobId ? { jobId } : {}), resolved };
  }
  if (matchesSpec(existing, spec)) {
    return { outcome: 'unchanged', jobId: existing.id, resolved };
  }
  // Name and description are the user's to keep; everything the config owns is
  // rewritten. `enabled: true` re-enables a routine the user turned off in the
  // Routines page only when triage is enabled in Settings, which is the same
  // switch they just used.
  const { name: _name, description: _description, ...owned } = spec;
  await patchRoutine(existing.id, owned);
  log.cron.info('triage: routine updated from config', {
    jobId: existing.id, everyMs: resolved.everyMs, threshold: resolved.everyMessages,
    sources: resolved.sources,
  });
  return { outcome: 'patched', jobId: existing.id, resolved };
}

/** Disable triage's routine (leaving it, its runs and its notes in place). */
export async function stopTriage(deps: TriageBootstrapDeps = {}): Promise<TriageBootstrapResult> {
  const listRoutines = deps.listRoutines ?? defaultListRoutines;
  const patchRoutine = deps.patchRoutine ?? defaultPatchRoutine;
  const getConfig = deps.getConfig ?? defaultGetConfig;
  const resolved = readTriageConfig(await getConfig());
  const existing = findTriageRoutine(await listRoutines());
  if (!existing) return { outcome: 'absent', resolved };
  if (!existing.enabled) return { outcome: 'already-disabled', jobId: existing.id, resolved };
  await patchRoutine(existing.id, { enabled: false });
  log.cron.info('triage: routine disabled', { jobId: existing.id });
  return { outcome: 'disabled', jobId: existing.id, resolved };
}

// ── Config reactivity ──

let watching = false;

/**
 * Keep the routine in line with Settings without a restart.
 *
 * global + interest rather than a name in PUT /api/config's destination list, for
 * the reason server.ts:2553 already gives: the route's list is a shared file, and
 * this subscriber only ever wants one event name.
 *
 * Safe against a loop: the routine lives in cron-jobs.json, and a cron mutation
 * emits a cron event (to WebSocket clients), never `config:changed` — so a patch
 * from here cannot re-enter here. A test pins that.
 */
export function startTriageConfigWatcher(deps: TriageBootstrapDeps = {}): { stop(): void } {
  bus.subscribe(TRIAGE_CONFIG_SUBSCRIBER, (event) => {
    if (event.name !== EventNames.CONFIG_CHANGED) return;
    // The narrow UI-state emits (favorites, ordering, focus_bar, focus_tiers) name
    // a `key` and carry no config. Nothing there can change `triage`, and a
    // favourites toggle must not cost a routine-store read.
    const data = event.data as { key?: string; config?: unknown } | undefined;
    if (data?.key && !data.config) return;
    void ensureTriageRoutine(deps).catch((err) => {
      log.cron.warn('triage: config reload failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, { global: true, interest: [EventNames.CONFIG_CHANGED] });
  watching = true;
  return {
    stop() {
      if (!watching) return;
      bus.unsubscribe(TRIAGE_CONFIG_SUBSCRIBER);
      watching = false;
    },
  };
}
