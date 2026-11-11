// The router's wake: a daemon trigger (template router:pending) whose fire wakes one area router.
import { createHash, randomUUID } from 'node:crypto';
import { WALNUT_HOME } from '../../constants.js';
import type { CronJob } from '../cron/types.js';
import type { ExecutorDefinition, ExecutorRunResult } from '../routines/types.js';
import { parseTemplateRun, registerTriggerTemplate, templateRun } from '../routines/trigger-templates.js';
import { pickDeliverySession } from '../routines/session-target.js';
import { registerExecutor } from '../routines/registry.js';
import type { Disposable } from '../plugins/disposable.js';
import type { SessionRecord, Task } from '../types.js';
import { activeRouter, readRouterAreas, taskArea, type RouterArea, type RouterAreasFile } from './areas.js';
import { isRouterAreaSession } from './session-policy.js';
import { routerAreaId, routerKey } from './store.js';
import type { RouterRoute, RouterSource } from './types.js';
import { ROUTER_RUNTIME_SOURCE, takeRouterWakeGrant } from './delivery-scope.js';
import { currentRouterSources } from './source-registry.js';

export const ROUTER_WAKE_OWNER = 'router';
export const ROUTER_WAKE_TEMPLATE = 'router:pending';
export const ROUTER_WAKE_EXECUTOR = 'router';
export const ROUTER_WAKE_INPUT = 'Confirmed incoming items await this area router.';
export const ROUTER_WAKE_INSTRUCTIONS = 'Read each listed item with router_context and record its route with router_route.';
export const ROUTER_WAKE_BATCH = 50;
export const ROUTER_WAKE_EVERY_MS = 5 * 60_000;
const LOOKUP_BATCH = 200;

const withRouterWake = takeRouterWakeGrant();

export class RouterWakeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RouterWakeError';
  }
}

export type WakeTask = Pick<Task, 'id' | 'phase' | 'source' | 'org_role' | 'router_area_id' | 'router_paused'>;
export type WakeSession = Pick<SessionRecord, 'claudeSessionId' | 'process_status' | 'archived' | 'lastActiveAt' | 'profile' | 'host' | 'engine'>;

export interface RouterWakeDeps {
  readAreas(): Promise<RouterAreasFile>;
  getTask(taskId: string): Promise<WakeTask | null>;
  orgEnabled(): Promise<boolean>;
  /** One lookup for a batch of sources, keyed by `routerKey(source)`. */
  routesFor(areaId: string, sources: readonly RouterSource[]): Promise<Map<string, RouterRoute>>;
  sessionsForTask(taskId: string): Promise<WakeSession[]>;
  send(sessionId: string, message: string, messageId: string, taskId: string): Promise<void>;
  /** An idle start: no first message, no turn; the wake's message follows through the grant. */
  start(taskId: string): Promise<{ sessionId?: string }>;
  nonce(): string;
  /** Sources (by `routerKey`) waiting on the person's answer to a handoff ask: not pending until it can go on. */
  waitingSources?(areaId: string, sources: readonly RouterSource[], routerTaskId: string): Promise<Set<string>>;
  /** Cache-only batch check of which sources are still the current delivery; absent = the registry's. */
  currentSources?(sources: readonly RouterSource[]): Promise<RouterSource[]>;
}

function defaultDeps(): RouterWakeDeps {
  return {
    readAreas: () => readRouterAreas(WALNUT_HOME),
    async getTask(taskId) {
      const { getTask } = await import('../task-manager.js');
      return await getTask(taskId).catch(() => null);
    },
    async orgEnabled() {
      const { isOrgEnabled } = await import('../org/org-enabled.js');
      return await isOrgEnabled();
    },
    async routesFor(areaId, sources) {
      const { routerStore } = await import('./runtime.js');
      return await routerStore(areaId).getSources(sources);
    },
    async sessionsForTask(taskId) {
      const { getSessionsForTask } = await import('../session-tracker.js');
      return await getSessionsForTask(taskId);
    },
    async send(sessionId, message, messageId, taskId) {
      const { sendMessageToSession } = await import('../session-message-queue.js');
      await sendMessageToSession(sessionId, message, { source: ROUTER_RUNTIME_SOURCE, taskId, messageId });
    },
    async start(taskId) {
      const { startSessionForTask } = await import('../sessions/task-start.js');
      const started = await startSessionForTask({
        taskIdPrefix: taskId, idle: true, expectReply: false, awaitStart: true, source: ROUTER_RUNTIME_SOURCE,
      });
      return started.started && started.sessionId ? { sessionId: started.sessionId } : {};
    },
    nonce: () => randomUUID(),
    currentSources: currentRouterSources,
    async waitingSources(_areaId, sources, routerTaskId) {
      const { handoffWaitingSources } = await import('./handoff-approval.js');
      return await handoffWaitingSources(sources, routerTaskId);
    },
  };
}

export type RouterWakeGate = { ready: true; area: RouterArea; task: WakeTask; file: RouterAreasFile } | { ready: false; reason: string };

/** Area, active router and its task as configured now; paused, complete or org off is quiet, a mismatch throws. */
/** The gate's answer for a paused router (its registry entry or its task), read by the router page too. */
export const ROUTER_PAUSED_REASON = 'The area router is paused.';

export async function routerWakeGate(areaId: string, deps: RouterWakeDeps, target?: string): Promise<RouterWakeGate> {
  routerAreaId(areaId);
  const file = await deps.readAreas();
  const area = file.areas.find((one) => one.id === areaId);
  if (!area) throw new RouterWakeError('area_missing', `Router area ${areaId} is not configured.`);
  if (area.host !== '__local__') throw new RouterWakeError('area_host_unsupported', `Router area ${areaId} runs only on this machine.`);
  if (target !== undefined && taskArea(file, target)?.id !== areaId) {
    throw new RouterWakeError('router_other_area', `Task ${target} is not a task of router area ${areaId}.`);
  }
  const router = activeRouter(file, areaId);
  if (!router) return { ready: false, reason: ROUTER_PAUSED_REASON };
  if (target !== undefined && router.taskId !== target) {
    throw new RouterWakeError('router_changed', `Task ${target} is not the active router of area ${areaId}.`);
  }
  const task = await deps.getTask(router.taskId);
  if (!task) throw new RouterWakeError('router_task_missing', `The router task of area ${areaId} does not exist.`);
  if (task.org_role !== 'router' || task.router_area_id !== areaId || task.source !== 'local') {
    throw new RouterWakeError('router_task_mismatch', `Task ${task.id} is not a local router of area ${areaId}.`);
  }
  if (task.phase === 'COMPLETE') return { ready: false, reason: 'The area router is complete.' };
  if (task.router_paused !== false) return { ready: false, reason: ROUTER_PAUSED_REASON };
  if (!await deps.orgEnabled()) return { ready: false, reason: 'The org is off.' };
  return { ready: true, area, task, file };
}

/** This area's confirmed items with no ledger row and still current in the cache, in file order; failed and unknown rows are not pending, nor held asks. */
export async function pendingSources(file: RouterAreasFile, area: RouterArea, deps: Pick<RouterWakeDeps, 'routesFor' | 'waitingSources' | 'currentSources'>,
  opts: { first?: boolean } = {}): Promise<RouterSource[]> {
  const routerTaskId = activeRouter(file, area.id)?.taskId;
  const allowed = new Set(area.sources.map((source) => JSON.stringify([source.kind, source.account])));
  const mine = file.items.filter((item) => item.areaId === area.id
    && (item.source.kind !== 'mail' || item.source.version !== undefined)
    && allowed.has(JSON.stringify([item.source.kind, item.source.account])));
  const pending: RouterSource[] = [];
  for (let at = 0; at < mine.length; at += LOOKUP_BATCH) {
    const batch = mine.slice(at, at + LOOKUP_BATCH).map((item) => ({ ...item.source }));
    const routes = await deps.routesFor(area.id, batch);
    const ledgerless = batch.filter((source) => !routes.has(routerKey(source)));
    // A confirmed snapshot a later delivery replaced never gets a ledger row, so it must not wake forever.
    const open = ledgerless.length ? await (deps.currentSources ? deps.currentSources(ledgerless) : currentRouterSources(ledgerless)) : [];
    const held = open.length && routerTaskId && deps.waitingSources ? await deps.waitingSources(area.id, open, routerTaskId) : new Set<string>();
    for (const source of open) {
      if (held.has(routerKey(source))) continue;
      pending.push(source);
      if (opts.first) return pending;
    }
  }
  return pending;
}

/** Whether this router's wake would hand it items now, and why not (the router page's summary): the wake's own gate. */
export async function routerReadiness(areaId: string, taskId: string): Promise<{ ready: true } | { ready: false; reason: string }> {
  try {
    const gate = await routerWakeGate(areaId, defaultDeps(), taskId);
    return gate.ready ? { ready: true } : { ready: false, reason: gate.reason };
  } catch (error) {
    return { ready: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** How many of an area's confirmed items still wait for a route (the router page's summary). */
export async function pendingCount(file: RouterAreasFile, area: RouterArea): Promise<number> {
  return (await pendingSources(file, area, defaultDeps())).length;
}

/** A window of at most `size` that moves on each wake, so a stuck head never hides the tail. */
export function wakeWindow<T>(pending: readonly T[], cursor: number, size = ROUTER_WAKE_BATCH): { items: T[]; next: number } {
  if (pending.length <= size) return { items: [...pending], next: 0 };
  const start = cursor % pending.length;
  const items = [...pending.slice(start, start + size), ...pending.slice(0, Math.max(0, start + size - pending.length))];
  return { items, next: (start + size) % pending.length };
}

export function routerWakeMessage(areaId: string, items: readonly RouterSource[], more: number): string {
  return JSON.stringify({
    instructions: ROUTER_WAKE_INSTRUCTIONS, areaId,
    items: items.map((source) => ({ ...source })), more,
  });
}

/** One id per real wake: a wake is no item receipt, so a batch still unrouted is sent again next time. */
export function routerWakeMessageId(taskId: string, items: readonly RouterSource[], nonce: string): string {
  const identities = items.map((source) => [source.kind, source.account, source.message, source.version ?? '']);
  return `qm-router-wake-${createHash('sha256').update(JSON.stringify(['router-wake-v2', taskId, identities, nonce])).digest('hex').slice(0, 32)}`;
}

export async function routerWakeJobId(taskId: string): Promise<string> {
  const { taskIdForKey } = await import('../task-create-idempotency.js');
  return taskIdForKey(`router-wake:${taskId}`);
}

export async function checkRouterPending(params: Record<string, string>, deps: RouterWakeDeps = defaultDeps()): Promise<{ fire: boolean; input?: string }> {
  const areaId = params.areaId;
  if (typeof areaId !== 'string') throw new RouterWakeError('area_required', 'A router wake names its area.');
  const gate = await routerWakeGate(areaId, deps);
  if (!gate.ready) return { fire: false };
  // No items: the daemon's seen set never swallows a source whose routing is unfinished.
  const pending = await pendingSources(gate.file, gate.area, deps, { first: true });
  return pending.length > 0 ? { fire: true, input: ROUTER_WAKE_INPUT } : { fire: false };
}

function validateConfig(raw: unknown): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const target = typeof config.target === 'string' ? config.target.trim() : '';
  if (!target || target.length > 200 || /[\u0000-\u001f\u007f]/.test(target)) return { ok: false, error: 'target must name the router task' };
  if (typeof config.areaId !== 'string') return { ok: false, error: 'areaId is required' };
  try { routerAreaId(config.areaId); } catch { return { ok: false, error: 'areaId must be a router area id' }; }
  if (config.instructions !== undefined && config.instructions !== ROUTER_WAKE_INSTRUCTIONS) {
    return { ok: false, error: 'instructions are fixed for a router wake' };
  }
  const extra = Object.keys(config).filter((key) => !['target', 'areaId', 'instructions'].includes(key));
  if (extra.length > 0) return { ok: false, error: `unknown config fields: ${extra.join(', ')}` };
  return { ok: true, config: { target, areaId: config.areaId, instructions: ROUTER_WAKE_INSTRUCTIONS } };
}

/** The job must be exactly the wake this module arms for this router and area. */
async function assertWakeJob(job: CronJob, target: string, areaId: string): Promise<void> {
  const parsed = parseTemplateRun(job.check?.run ?? '');
  const keys = parsed ? Object.keys(parsed.params) : [];
  if (job.id !== await routerWakeJobId(target) || (job.check?.host || '__local__') !== '__local__' || job.check?.cwd
    || parsed?.name !== ROUTER_WAKE_TEMPLATE || keys.length !== 1 || parsed.params.areaId !== areaId) {
    throw new RouterWakeError('not_router_wake', 'This routine is not the router wake of its task.');
  }
}

let registered: { dispose(): void } | null = null;
const inFlight = new Set<string>();
const cursors = new Map<string, number>();

export function createRouterWakeExecutor(deps: RouterWakeDeps = defaultDeps()): ExecutorDefinition {
  const refuse = (error: string): ExecutorRunResult => ({ status: 'error', error });
  return {
    type: ROUTER_WAKE_EXECUTOR,
    label: 'Router wake',
    description: 'Wake an area router when confirmed incoming items have no route yet.',
    configSchema: [],
    internal: true,
    validate: validateConfig,
    async run(job, executor): Promise<ExecutorRunResult> {
      // The fire's message is not read: the batch is rebuilt from the areas file and the ledger.
      const checked = validateConfig(executor.config);
      if (!checked.ok) return refuse(checked.error);
      const { target, areaId } = checked.config as { target: string; areaId: string };
      try {
        await assertWakeJob(job, target, areaId);
        const gate = await routerWakeGate(areaId, deps, target);
        if (!gate.ready) return { status: 'ok', summary: `${gate.reason} Nothing was sent.` };
        if (inFlight.has(target)) return { status: 'ok', summary: 'The router is already being woken.' };
        inFlight.add(target);
        try {
          return await wake(gate, target, deps);
        } finally {
          inFlight.delete(target);
        }
      } catch (err) {
        if (err instanceof RouterWakeError) return refuse(err.message);
        throw err;
      }
    },
  };
}

const newestFirst = (a: WakeSession, b: WakeSession) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? '');

async function wake(gate: Extract<RouterWakeGate, { ready: true }>, target: string, deps: RouterWakeDeps): Promise<ExecutorRunResult> {
  // Archived rows too: a start may continue any of them, and an old full-profile one is never resumed.
  const records = await deps.sessionsForTask(target);
  if (records.some((record) => !isRouterAreaSession(record, gate.area, 'router'))) {
    return { status: 'error', error: 'The router task has a session outside its isolated router profile; it was not woken or restarted.' };
  }
  const open = records.filter((record) => !record.archived);
  if (open.some((record) => record.process_status === 'running')) return { status: 'ok', summary: 'The router is already processing.' };
  if ((await pendingSources(gate.file, gate.area, deps, { first: true })).length === 0) {
    return { status: 'ok', summary: 'No incoming item awaits this router.' };
  }
  let sessionId: string | undefined = pickDeliverySession(open)?.claudeSessionId
    ?? open.filter((record) => record.process_status === 'error').sort(newestFirst)[0]?.claudeSessionId;
  let started = false;
  if (!sessionId) {
    if (records.length > 0) return { status: 'error', error: 'The router conversation is archived; it was not woken. Restore it from the router page.' };
    sessionId = (await deps.start(target)).sessionId;
    if (!sessionId) return { status: 'error', error: 'The router session did not start; the next wake tries again.', retryable: true };
    started = true;
  }
  // Read again after any start: a pause, an area change or another profile meanwhile sends nothing.
  const fresh = await routerWakeGate(gate.area.id, deps, target);
  if (!fresh.ready) return { status: 'ok', summary: `${fresh.reason} Nothing was sent.` };
  const record = (await deps.sessionsForTask(target)).find((one) => one.claudeSessionId === sessionId);
  if (!record || record.archived || !isRouterAreaSession(record, fresh.area, 'router')) {
    return { status: 'error', error: 'The router session is not its isolated router session; nothing was sent.' };
  }
  if (!started && record.process_status === 'running') return { status: 'ok', summary: 'The router is already processing.' };
  const pending = await pendingSources(fresh.file, fresh.area, deps);
  if (pending.length === 0) return { status: 'ok', summary: 'No incoming item awaits this router.' };
  const window = wakeWindow(pending, cursors.get(fresh.area.id) ?? 0);
  const message = routerWakeMessage(fresh.area.id, window.items, pending.length - window.items.length);
  const messageId = routerWakeMessageId(target, window.items, deps.nonce());
  const sid = sessionId;
  await withRouterWake(sid, () => deps.send(sid, message, messageId, target));
  cursors.set(fresh.area.id, window.next);
  return {
    status: 'ok', delivered: { sessionId: sid },
    summary: `${started ? 'Started the router and sent' : 'Sent'} ${window.items.length} pending items to it.`,
  };
}

/** Registers the router:pending template and the router executor; a second call replaces the first. */
export function registerRouterWake(deps: RouterWakeDeps = defaultDeps()): Disposable {
  registered?.dispose();
  const template = registerTriggerTemplate(ROUTER_WAKE_OWNER, 'Router', {
    id: 'pending',
    title: 'Router: pending incoming items',
    description: 'Fires while confirmed incoming items of an area have no route.',
    params: [{ key: 'areaId', label: 'Area', required: true }],
    every: '5m',
    maxFiresPerDay: 288,
    internal: true,
    prepare() {
      throw new Error('Walnut arms the router wake itself when a router is set up.');
    },
    check: (params) => checkRouterPending(params, deps),
  });
  const executor = createRouterWakeExecutor(deps);
  let live = true;
  registerExecutor({
    ...executor,
    run: (job, ref, message) => live ? executor.run(job, ref, message)
      : Promise.resolve<ExecutorRunResult>({ status: 'error', error: 'The router wake is stopped on this server.' }),
  });
  const handle = {
    dispose() {
      live = false;
      void template.dispose();
      inFlight.clear();
      cursors.clear();
      if (registered === handle) registered = null;
    },
  };
  registered = handle;
  return handle;
}

export function disposeRouterWake(): void {
  registered?.dispose();
}

export function routerWakeRegistered(): boolean {
  return registered !== null;
}

/** At boot: every configured router's wake matches its task; reads no item content, starts no process. */
export async function reconcileRouterWakes(opts: { attempts?: number; gapMs?: number; isLive?: () => boolean } = {}): Promise<{ failed: string[] }> {
  const { log } = await import('../../logging/index.js');
  const { getTask } = await import('../task-manager.js');
  const attempts = opts.attempts ?? 3;
  let todo = (await readRouterAreas(WALNUT_HOME)).routers.map((router) => router.taskId);
  for (let attempt = 1; attempt <= attempts && todo.length > 0; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, opts.gapMs ?? 30_000));
    if (opts.isLive && !opts.isLive()) break;
    const failed: string[] = [];
    for (const taskId of todo) {
      try {
        const task = await getTask(taskId).catch(() => null);
        if (task) await configureRouterWake(task);
      } catch (err) {
        failed.push(taskId);
        log.cron.warn('router wake: not reconciled', { taskId, attempt, error: err instanceof Error ? err.message : String(err) });
      }
    }
    todo = failed;
  }
  return { failed: todo };
}

/** Arms, pauses or resumes the router's one wake routine; a setup or a pause never starts a process. */
export async function configureRouterWake(task: WakeTask): Promise<{ id: string; enabled: boolean; created: boolean } | null> {
  const id = await routerWakeJobId(task.id);
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  if (!service) throw new RouterWakeError('routines_unavailable', 'The routines engine is not running here.');
  const existing = (await service.list({ includeDisabled: true, recompute: false })).find((job) => job.id === id) ?? null;
  const router = task.org_role === 'router' && task.source === 'local' && !!task.router_area_id;
  const enabled = router && task.phase !== 'COMPLETE' && task.router_paused === false;
  const { createRoutine, patchRoutine } = await import('../routines/routines-core.js');
  if (existing) {
    const config = existing.executor?.config as { target?: unknown; areaId?: unknown } | undefined;
    if (existing.executor?.type !== ROUTER_WAKE_EXECUTOR || config?.target !== task.id
      || (router && config?.areaId !== task.router_area_id)) {
      throw new RouterWakeError('wake_conflict', `Routine ${id} is not this router's wake; it was left as it is.`);
    }
    if (existing.enabled !== enabled) await patchRoutine(id, { enabled });
    return { id, enabled, created: false };
  }
  // A paused router needs no routine yet: it is made, with the daemon's check, on its first resume.
  if (!router || !enabled) return null;
  const areaId = routerAreaId(task.router_area_id);
  await createRoutine({
    name: `Router wake: ${areaId}`,
    enabled,
    schedule: { kind: 'every', everyMs: ROUTER_WAKE_EVERY_MS },
    executor: { type: ROUTER_WAKE_EXECUTOR, config: { target: task.id, areaId, instructions: ROUTER_WAKE_INSTRUCTIONS } },
    check: {
      run: templateRun(ROUTER_WAKE_TEMPLATE, { areaId }), host: '__local__', maxFiresPerDay: 288,
      template: { id: ROUTER_WAKE_TEMPLATE, params: { areaId }, label: `Router: ${areaId}` },
    },
  }, undefined, { id });
  return { id, enabled, created: true };
}
