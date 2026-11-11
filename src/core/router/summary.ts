/**
 * What a router's Org page shows above its chat (2026-11-11, the person, on a router page that said
 * only "No conversation history found": "why it is empty that is weird it is not working or what").
 * A router's chat is empty until confirmed mail of its area reaches it, so the page says instead
 * what it reads, whether it runs, how many items it routed and the newest one, and what feeds it.
 *
 * Counts and the newest route's state, time and target task only: never an item's words (sender,
 * subject, body), which stay behind the area's own reads.
 */
import { WALNUT_HOME } from '../../constants.js';
import { activeRouter, readRouterAreas, taskArea } from './areas.js';
import { routerStore } from './runtime.js';
import { ROUTER_PAUSED_REASON, pendingCount, routerReadiness, routerWakeJobId } from './wake.js';
import type { RouterRouteStatus } from './types.js';

export interface RouterNodeSummary {
  areaId: string;
  areaName: string;
  /** Paused (its registry entry or its task): it reads nothing until the person turns Paused off. */
  paused: boolean;
  /** Not paused, yet its wake would hand it nothing, with the wake gate's reason ("The org is off."). */
  blocked?: string;
  /** The accounts the area reads from (mail or Slack), by count. */
  sources: number;
  /** Items the person confirmed for this area. */
  assigned: number;
  /** Confirmed items with no route yet (what the next wake hands it); null when that could not be read, 0 while paused. */
  waiting: number | null;
  counts: Record<'routed' | 'not_routed' | 'routing' | 'failed' | 'unknown', number>;
  latest?: { at: number; status: RouterRouteStatus; taskId?: string; taskTitle?: string };
  /** Its wake: the check that hands it waiting items. */
  wake: { armed: boolean; everyMs?: number; lastCheckAt?: number; nextAt?: number };
  /** Its own conversation: started (a live CLI, idle or at work), or not. */
  session: { started: boolean; state?: string };
}

export class RouterSummaryError extends Error {
  constructor(readonly code: 'not_router', message: string, readonly status = 404) { super(message); }
}

const ZERO = { routed: 0, not_routed: 0, routing: 0, failed: 0, unknown: 0 };

export async function routerNodeSummary(taskId: string, home = WALNUT_HOME): Promise<RouterNodeSummary> {
  const file = await readRouterAreas(home);
  const area = taskArea(file, taskId);
  const assignment = area ? file.routers.find((r) => r.taskId === taskId && r.areaId === area.id) : undefined;
  if (!area || !assignment) throw new RouterSummaryError('not_router', 'This task is not a router of any area.');
  const [overview, readiness, wake, session] = await Promise.all([
    routerStore(area.id, home).overview(),
    routerReadiness(area.id, taskId),
    wakeOf(taskId),
    sessionOf(taskId),
  ]);
  const paused = activeRouter(file, area.id)?.taskId !== taskId || (!readiness.ready && readiness.reason === ROUTER_PAUSED_REASON);
  const blocked = !paused && !readiness.ready ? readiness.reason : undefined;
  // Paused: no next check, so nothing "waits for" one; a read that fails says unknown, never 0.
  const waiting = paused ? 0 : await pendingCount(file, area).catch(() => null);
  const counts = { ...ZERO };
  for (const [status, n] of Object.entries(overview.counts)) counts[status as keyof typeof ZERO] += n ?? 0;
  let latest: RouterNodeSummary['latest'];
  if (overview.latest) {
    const one = overview.latest;
    latest = { at: one.at, status: one.status, ...(one.taskId ? { taskId: one.taskId } : {}) };
    if (one.taskId) {
      const { getTask } = await import('../task-manager.js');
      const title = await getTask(one.taskId).then((t) => t.title).catch(() => undefined);
      if (title) latest.taskTitle = title;
    }
  }
  return {
    areaId: area.id, areaName: area.name || area.id, paused, ...(blocked ? { blocked } : {}), sources: area.sources.length,
    assigned: file.items.filter((item) => item.areaId === area.id).length,
    waiting, counts, ...(latest ? { latest } : {}), wake, session,
  };
}

async function wakeOf(taskId: string): Promise<RouterNodeSummary['wake']> {
  try {
    const id = await routerWakeJobId(taskId);
    const { listRoutines } = await import('../routines/routines-core.js');
    const { jobs } = await listRoutines(true);
    const job = (jobs as import('../cron/types.js').CronJob[]).find((one) => one.id === id);
    if (!job) return { armed: false };
    const every = job.schedule?.kind === 'every' ? job.schedule.everyMs : undefined;
    const last = job.state?.lastCheck?.atMs ?? job.state?.lastRunAtMs;
    const next = job.state?.nextRunAtMs;
    return {
      armed: job.enabled === true, ...(typeof every === 'number' ? { everyMs: every } : {}),
      ...(typeof last === 'number' ? { lastCheckAt: last } : {}), ...(typeof next === 'number' ? { nextAt: next } : {}),
    };
  } catch { return { armed: false }; }
}

async function sessionOf(taskId: string): Promise<RouterNodeSummary['session']> {
  try {
    const { getSessionsForTask } = await import('../session-tracker.js');
    const live = (await getSessionsForTask(taskId)).filter((s) => s.process_status === 'running' || s.process_status === 'idle');
    return live.length ? { started: true, state: live[0]!.process_status } : { started: false };
  } catch { return { started: false }; }
}
