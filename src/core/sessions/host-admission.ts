/**
 * Each host's slots for automatic starts (2026-11-05, the user: "remove this we don't want
 * this limitation, it is more like not per vp, like per host can handle x amount, but let only
 * limit the auto start, not the one start by human manually ... make limit per host, and auto
 * able to assign based on each host"). It replaces the per-lead cap of 8 running subtasks,
 * which held starts in the queue for 80 minutes while four hosts sat idle. A start no host has
 * room for throws here; task-start.ts records an explicit capacity wait for an unpinned
 * agent start, while a named host or folder keeps the hosts_full refusal (2026-11-11).
 *
 * A start is admitted on the host it will run on once placement chose it and before anything is
 * set up there (start-placement.ts), while that host has room: a free slot (hosts/placement.ts
 * hostSlots), memory left, and load under twice its cap (judgeHost `full`; the load caps alone
 * only steer placement to another host). An admitted start holds its slot until its session runs
 * or fails, so ten starts in one turn take ten slots, not one each of the same free slot.
 * Admissions on one host run one at a time.
 *
 * Who is limited: an automatic start only, that is a worker session's task_start or
 * task_create, the run of a start an older Walnut queued (start-queue.ts), the org's own start of a lead or a VP
 * (org-autostart.ts), and a routine's run (routines/run-start-deps.ts). A person's start (the
 * board, the phone, a chat), a Personal AI ask's, a start that quotes the user's words
 * (`user_request`), and Walnut's own moves (an engine switch, a transfer, a recovery) start at
 * once. Not limited either: a start that continues a task's conversation (a message, no new
 * session), and `walnut start` typed in a shell (no caller session: it reads as a person's).
 * The org's Retry and Start now on a queued start are a person's clicks: they never wait. A
 * worker's start and the org's start of a lead fail with HostsFullError, which their caller reads
 * (the agent's tool answer, the Org page's Retry); a routine's run asks again here for up to a
 * minute, inside its trigger's delivery, and fails retryable after (routines/run-start-deps.ts).
 */

import type { HostLoadView } from '../hosts/placement.js';

export const LOCAL_HOST = '__local__';

/** Walnut's own moves of work that already runs: they need their session now. */
const OWN_MOVES = new Set(['engine-switch', 'transfer', 'auto-recover', 'recovery', 'restart', 'folder-gone']);

/** Starts admitted per host and not settled yet (task ids). */
const admitted = new Map<string, Set<string>>();
/** Starts that settled and are still counted until then (ms): their record may not say running yet. */
const held = new Map<string, Map<string, number>>();
let locks = new Map<string, Promise<void>>();

function hostKey(host: string | undefined | null): string {
  return !host || host === 'local' ? LOCAL_HOST : host;
}

/**
 * The tasks whose starts hold a slot on `host` (admitted, or settled and still held). Placement
 * counts them with the host's sessions in a turn, once per task (hosts/placement.ts hostLoads).
 */
export function slotHoldersOn(host: string | undefined | null): string[] {
  const key = hostKey(host);
  const now = Date.now();
  const out = new Set(admitted.get(key) ?? []);
  const h = held.get(key);
  for (const [id, until] of h ?? []) {
    if (until > now) out.add(id);
    else h!.delete(id);
  }
  return [...out];
}

/**
 * Count a started session's slot on `host` for `ms` under its task: a start admitted before its
 * task existed (a routine's new run) hands its slot on to the task it made (review round 5, Sol).
 */
export function holdSlotFor(host: string | undefined | null, taskId: string, ms: number): void {
  const key = hostKey(host);
  const h = held.get(key) ?? new Map<string, number>();
  h.set(taskId, Math.max(h.get(taskId) ?? 0, Date.now() + ms));
  held.set(key, h);
}

/** How many slots on `host` starts hold (tests read it). */
export function startsAdmittedOn(host: string | undefined | null): number {
  return slotHoldersOn(host).length;
}

export interface HostsFullDetail {
  taskId: string;
  /** Where it will run once there is room. */
  host: string;
  /** That host's name as the user reads it ("this Mac", a host's label). */
  label?: string;
  /** Why its host has no room, in words that stay the same while it waits ("all 24 slots taken"). */
  reason: string;
  /** The tasks whose sessions are in a turn there, and its slots (the answer's `queued.running` / `cap`). */
  running?: string[];
  cap?: number;
  /** Why it stays on that host: placement's own words, or that the start keeps its host (task-start.ts). */
  placement?: string;
}

/** Admission refused; the start layer either records a capacity wait or returns this refusal. */
export class HostsFullError extends Error {
  readonly statusCode = 409;
  readonly code = 'hosts_full';
  constructor(message: string, readonly detail: HostsFullDetail) {
    super(message);
    this.name = 'HostsFullError';
  }
}

/** Whether a start waits for a free slot: see the header. */
export async function isAutomaticStart(p: { callerSid?: string; source?: string; userRequest?: string; ownMove?: boolean; byPerson?: boolean }): Promise<boolean> {
  // `byPerson`: a person's click that runs through an automatic path (the Org page's Retry, Start now on a queued start).
  if (p.userRequest?.trim() || p.ownMove || p.byPerson) return false;
  if (p.source && OWN_MOVES.has(p.source)) return false;
  const { START_QUEUE_SOURCE } = await import('./start-queue.js');
  if (p.source === START_QUEUE_SOURCE) return true;
  const { ORG_START_SOURCE } = await import('../org/org-autostart.js');
  if (p.source === ORG_START_SOURCE) return true;
  if (!p.callerSid?.trim()) return false;
  const { resolveCallerPlacement } = await import('./caller-placement.js');
  const caller = await resolveCallerPlacement(p.callerSid).catch(() => ({ kind: 'unknown' as const }));
  return caller.kind === 'worker';
}

/** Test seam: the view of one host (placement's hostLoads by default). */
type HostView = (host: string) => Promise<HostLoadView | undefined>;
let viewOf: HostView | null = null;
export function __setHostViewForTesting(v: HostView | null): void { viewOf = v; }
export function __resetHostAdmissionForTesting(): void { admitted.clear(); held.clear(); locks = new Map(); }

async function view(host: string): Promise<HostLoadView | undefined> {
  if (viewOf) return viewOf(host);
  const { hostLoads } = await import('../hosts/placement.js');
  return (await hostLoads({ hosts: [host] }).catch(() => []))[0];
}

/** Why a host has no room, with no live numbers, so a waiting entry keeps the same words. */
export function fullReason(v: Pick<HostLoadView, 'fullReasons'>): string {
  return v.fullReasons.join(', ');
}

/** Room for an automatic start: not full (a host whose load is unknown is full only by its slots). */
export function hasRoom(v: Pick<HostLoadView, 'full'>): boolean {
  return !v.full;
}

async function runningOn(key: string): Promise<string[]> {
  const { getActiveSessionsByHost } = await import('../session-tracker.js');
  const active = await getActiveSessionsByHost().catch(() => ({} as Record<string, { taskId?: string; claudeSessionId: string }[]>));
  // In a turn only, as the slots count them (hosts/placement.ts hostLoads).
  const runner = await import('../../providers/claude-code-session.js').then((m) => m.sessionRunner).catch(() => null);
  return (active[key === LOCAL_HOST ? 'local' : key] ?? []).filter((s) => runner?.isInTurn(s.claudeSessionId) !== false)
    .map((s) => s.taskId ?? '').filter(Boolean);
}

/** How often, and how long, a start with no queue to wait in asks again for room. */
export const WAIT_STEP_MS = 15_000;
export const WAIT_MAX_MS = 30 * 60_000;

/**
 * Admit one start on `host`, or throw HostsFullError when it is automatic and the host has
 * no room. Returns the release to call once the start has settled (spawned or failed).
 * `replay`: the start queue's own start (it is the one that waited). `waitMs`: ask again
 * every WAIT_STEP_MS until room or that long has passed.
 */
export async function admitHostStart(
  taskId: string, host: string | undefined | null, opts: AdmitOpts & { waitMs?: number },
): Promise<(holdMs?: number) => void> {
  const waitMs = opts.waitMs ?? 0;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      return await admitOnce(taskId, host, opts);
    } catch (err) {
      if (!(err instanceof HostsFullError)) throw err;
      if (Date.now() + waitStepMs > until) {
        if (waitMs <= 0) throw err;
        // It waited and gave up: say so, not that it waits (review round 5).
        throw new HostsFullError(`Not started: ${err.detail.label ?? err.detail.host} had no room for ${waitWords(waitMs)} (${err.detail.reason}).`, err.detail);
      }
      await new Promise((r) => setTimeout(r, waitStepMs));
    }
  }
}

/** "30 minutes", "45 seconds". */
export function waitWords(ms: number): string {
  const [n, unit] = ms >= 60_000 ? [Math.round(ms / 60_000), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** `automatic`: held to the host's room. */
interface AdmitOpts { automatic: boolean; respectWaiting?: boolean }
let waitStepMs = WAIT_STEP_MS;
export function __setWaitStepForTesting(ms: number | null): void { waitStepMs = ms ?? WAIT_STEP_MS; }

async function admitOnce(taskId: string, host: string | undefined | null, opts: AdmitOpts): Promise<(holdMs?: number) => void> {
  const key = hostKey(host);
  let unlock!: () => void;
  const mine = new Promise<void>((resolve) => { unlock = resolve; });
  const previous = locks.get(key) ?? Promise.resolve();
  const tail = previous.then(() => mine);
  locks.set(key, tail);
  await previous;
  try {
    if (opts.automatic) {
      if (opts.respectWaiting) {
        const { listTasks } = await import('../task-manager.js');
        const all = await listTasks();
        const byId = new Map(all.map((t) => [t.id, t]));
        const { heldByTeamStop } = await import('./start-queue.js');
        const waiting = all.some((t) => t.id !== taskId && t.phase !== 'COMPLETE'
          && t.start_queue?.wait_for_slot && (t.start_queue.host ?? LOCAL_HOST) === key
          && byId.get(t.start_queue.parent_id)?.phase !== 'COMPLETE' && byId.has(t.start_queue.parent_id)
          && !heldByTeamStop(t, byId));
        if (waiting) throw new HostsFullError(`Not started: earlier automatic starts are waiting on ${key}.`, {
          taskId, host: key, reason: 'earlier automatic starts are waiting for a free slot',
        });
      }
      const v = await view(key);
      // Its slots count even when its load cannot be read (review round 3, Sol).
      if (v?.full) {
        const reason = fullReason(v);
        throw new HostsFullError(`Not started: ${v.label} has no room (${reason}).`, {
          taskId, host: key, label: v.label, reason, running: await runningOn(key), cap: v.runningLimit,
        });
      }
    }
    const set = admitted.get(key) ?? new Set<string>();
    set.add(taskId);
    admitted.set(key, set);
    let released = false;
    return (holdMs = 0) => {
      if (released) return;
      released = true;
      if (holdMs > 0) {
        const h = held.get(key) ?? new Map<string, number>();
        h.set(taskId, Math.max(h.get(taskId) ?? 0, Date.now() + holdMs));
        held.set(key, h);
      }
      set.delete(taskId);
      if (set.size === 0 && admitted.get(key) === set) admitted.delete(key);
    };
  } finally {
    unlock();
    if (locks.get(key) === tail) locks.delete(key);
  }
}
