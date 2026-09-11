/**
 * Routines shared core — the ONE implementation of routine list/detail/CRUD/
 * toggle/run-now/actions/status/executors, used by the internal web router
 * (src/web/routes/cron.ts), the /api/v1 mobile router (routines-v1.ts), and
 * the daemon control relay's `server.routines.*` actions (cloud companion).
 *
 * Single-writer rule: the PRIMARY's cron engine owns cron-jobs.json. A cloud
 * REPLICA never mutates its local copy — every v1 call relays to the primary
 * (see the dual-engine blind-write cron storm this rule exists to prevent).
 *
 * Error contract: throws SessionControlError with an HTTP-ish statusCode so
 * both the frozen v1 error shape and the relay errorKind map cleanly.
 */

import { SessionControlError } from '../sessions/session-controls.js';
import { log } from '../../logging/index.js';
import type { CronService } from '../cron/index.js';

/** Resolve the live cron service or throw a 503 (server still booting). */
async function requireCronService(): Promise<CronService> {
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) throw new SessionControlError('Routines engine is not running', 503);
  return service;
}

/** Map the engine's message-based errors onto HTTP-ish codes. */
function mapCronError(err: unknown): never {
  if (err instanceof SessionControlError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/unknown cron job id/i.test(msg)) throw new SessionControlError(msg, 404);
  // jobs.ts throws bare Errors for input validation (payload/executor shape) —
  // those are caller mistakes (400), not server faults (500).
  if (/requires a payload|requires payload|requires text|requires message/i.test(msg)) {
    throw new SessionControlError(msg, 400);
  }
  throw err instanceof Error ? err : new Error(msg);
}

/**
 * Run the executor's own validate() at SAVE time and write the result back.
 *
 * normalize() only does field hygiene that every executor shares (trim
 * instructions, floor timeoutSeconds); it has no idea what a watcher's
 * maxOutcomesPerRun means. Without this hook the only validate() call was in
 * runExecutor(), so a routine with a missing required field or an out-of-range
 * safety limit saved fine and failed on its first tick — an hour later, in a
 * run-history line nobody is watching. The registry doc has always claimed
 * create/update validates; this is that claim wired up.
 *
 * Two things it deliberately does:
 *  - stores the VALIDATED config, so a clamped number (500 → 20) is what the
 *    form shows afterwards rather than a value the run silently ignores, and
 *  - rejects an unknown type by name, because a typo'd executor is otherwise a
 *    routine that ticks forever and errors every time.
 *
 * It runs only on this REST/relay path, never on store load: revalidating on
 * load would let a rule added later make an existing job unreadable.
 */
async function validateExecutorForSave(input: { executor?: unknown }): Promise<void> {
  const ref = input.executor as { type?: string; config?: unknown } | undefined;
  if (!ref || typeof ref.type !== 'string' || !ref.type) return;
  const { getExecutor, listExecutors } = await import('./registry.js');
  const def = getExecutor(ref.type);
  if (!def) {
    const known = listExecutors().map((e) => e.type).join(', ');
    throw new SessionControlError(
      `Unknown executor type '${ref.type}'${known ? ` — available: ${known}` : ''}`,
      400,
    );
  }
  const validated = def.validate(ref.config ?? {});
  if (!validated.ok) {
    throw new SessionControlError(`Invalid ${ref.type} config: ${validated.error}`, 400);
  }
  input.executor = { type: ref.type, config: validated.config };
}

export async function listRoutines(includeDisabled: boolean): Promise<{ jobs: unknown[] }> {
  const service = await requireCronService();
  return { jobs: await service.list({ includeDisabled }) };
}

export async function getRoutine(id: string): Promise<{ job: unknown }> {
  const service = await requireCronService();
  const jobs = await service.list({ includeDisabled: true });
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new SessionControlError(`Cron job not found: ${id}`, 404);
  return { job };
}

export async function createRoutine(body: unknown): Promise<{ job: unknown }> {
  const service = await requireCronService();
  const { normalizeCronJobCreate } = await import('../cron/index.js');
  const input = normalizeCronJobCreate(body);
  // normalize() passes through schedule-less objects; createJob would then
  // TypeError on input.schedule.kind — a caller mistake, so reject as 400.
  if (!input || !input.schedule) {
    throw new SessionControlError('Invalid input. Provide at least schedule and payload.', 400);
  }
  await validateExecutorForSave(input);
  try {
    const job = await service.add(input);
    log.web.info('routine created via shared core', { jobId: job.id, name: job.name });
    return { job };
  } catch (err) {
    mapCronError(err);
  }
}

export async function patchRoutine(id: string, body: unknown): Promise<{ job: unknown }> {
  const service = await requireCronService();
  const { normalizeCronJobPatch } = await import('../cron/index.js');
  const patch = normalizeCronJobPatch(body);
  if (!patch) throw new SessionControlError('Invalid patch input.', 400);
  await validateExecutorForSave(patch);
  try {
    const job = await service.update(id, patch);
    log.web.info('routine updated via shared core', { jobId: id });
    return { job };
  } catch (err) {
    mapCronError(err);
  }
}

export async function deleteRoutine(id: string): Promise<{ ok: boolean; removed: boolean }> {
  const service = await requireCronService();
  const result = await service.remove(id);
  if (!result.removed) throw new SessionControlError(`Cron job not found: ${id}`, 404);
  // A watcher's memory outlives nothing: leaving it behind would make a
  // recreated routine with a recycled id inherit a stranger's seen/acted sets.
  const { deleteTriggerState } = await import('./trigger-state.js');
  await deleteTriggerState(id);
  log.web.info('routine deleted via shared core', { jobId: id });
  return result;
}

export async function toggleRoutine(id: string): Promise<{ job: unknown }> {
  const service = await requireCronService();
  try {
    return { job: await service.toggle(id) };
  } catch (err) {
    mapCronError(err);
  }
}

export async function runRoutineNow(id: string): Promise<{ result: unknown }> {
  const service = await requireCronService();
  try {
    const result = await service.run(id, 'force');
    log.web.info('routine triggered via shared core', { jobId: id });
    return { result };
  } catch (err) {
    mapCronError(err);
  }
}

export async function getRoutinesStatus(): Promise<Record<string, unknown>> {
  const service = await requireCronService();
  return await service.status() as unknown as Record<string, unknown>;
}

export async function listRoutineActions(): Promise<{ actions: unknown[] }> {
  const { listActions } = await import('../cron/index.js');
  return { actions: await listActions() };
}

export async function listRoutineExecutors(): Promise<Record<string, unknown>> {
  const { listExecutors } = await import('./index.js');
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  const hosts = Object.entries(config.hosts ?? {}).map(([alias, def]) => ({
    value: alias,
    label: (def as { label?: string })?.label ?? alias,
  }));
  const { SESSION_MODELS } = await import('../types.js');
  const models = SESSION_MODELS.map((m) => ({ value: m.id, label: m.label }));
  return {
    executors: listExecutors().map((e) => ({
      type: e.type,
      label: e.label,
      description: e.description,
      configSchema: e.configSchema,
    })),
    options: { hosts, models },
  };
}

/**
 * NL → routine draft (one LLM call). Wave 3: shared by the internal web
 * route, the v1 mobile route (primary path) and the `server.routines.draft`
 * relay action. Throws 400 on empty text, 422 when the model produced an
 * unusable draft (the UI degrades to a manually-filled form).
 */
export async function draftRoutineFromText(text: unknown): Promise<{ draft: unknown }> {
  if (typeof text !== 'string' || !text.trim()) {
    throw new SessionControlError('text is required', 400);
  }
  const { draftRoutine } = await import('./draft.js');
  const { getConfig } = await import('../config-manager.js');
  const config = await getConfig();
  const { SESSION_MODELS } = await import('../types.js');
  // Exactly what a watcher's `tools` field may name (read-only Walnut tools +
  // installed plugin tools), so the drafter can't invent one — that would
  // produce a routine failing its first run with "unknown data tool".
  let dataTools: string[] = [];
  try {
    const { getReadOnlyTools } = await import('../tools/read-only.js');
    const { getPluginTools } = await import('../plugins/plugin-tools.js');
    dataTools = [...getReadOnlyTools(), ...getPluginTools()].map((t) => t.name);
  } catch { /* degrade to no suggestions rather than failing the draft */ }
  const result = await draftRoutine(text, {
    hosts: Object.keys(config.hosts ?? {}),
    models: SESSION_MODELS.map((m) => m.id),
    dataTools,
  });
  if (!result.ok) {
    log.web.warn('routine draft failed', { error: result.error });
    // `raw` (the unparseable LLM output) rides `extra` so the internal web
    // route can keep serving it for debugging; v1 serves the message only.
    throw new SessionControlError(result.error, 422, result.raw ? { raw: result.raw } : undefined);
  }
  return { draft: result.draft };
}

/**
 * Relay dispatcher for the `server.routines[.*]` control actions (cloud
 * REPLICA → primary). `sub` is the action suffix ('list' for the bare name).
 */
export async function handleRoutinesRelayAction(
  sub: string,
  p: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = typeof p.id === 'string' ? p.id : '';
  switch (sub) {
    case 'list': return await listRoutines(p.includeDisabled === true) as unknown as Record<string, unknown>;
    case 'actions': return await listRoutineActions() as unknown as Record<string, unknown>;
    case 'status': return await getRoutinesStatus();
    case 'executors': return await listRoutineExecutors();
    case 'get': return await getRoutine(id) as unknown as Record<string, unknown>;
    case 'create': return await createRoutine(p.body) as unknown as Record<string, unknown>;
    case 'patch': return await patchRoutine(id, p.body) as unknown as Record<string, unknown>;
    case 'delete': return await deleteRoutine(id) as unknown as Record<string, unknown>;
    case 'toggle': return await toggleRoutine(id) as unknown as Record<string, unknown>;
    case 'run': return await runRoutineNow(id) as unknown as Record<string, unknown>;
    case 'draft': return await draftRoutineFromText(p.text) as unknown as Record<string, unknown>;
    default: throw new SessionControlError(`Unknown routines action: ${sub}`, 400);
  }
}
