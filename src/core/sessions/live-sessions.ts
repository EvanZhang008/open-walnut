/**
 * How many Claude Code processes this machine keeps alive, and when a quiet one exits
 * (2026-11-11, the Operations VP: the Mac's load reached 215 to 328 from memory, not CPU, with
 * about 50 live CLIs of 0.3 to 1.1 GB each; swap 16 of 17.4 GB, 64 MB free; "MEMORY TIGHT" about
 * 180 times a day). A session whose turn is over holds its whole process for nothing: the next
 * message resumes the same conversation from its transcript (`--resume`), and triggers and waits
 * wake it through Walnut as before. So, for sessions on THIS machine (the server's own host):
 *
 *  1. Idle exit: a session whose turn ended and that has been quiet for `local_idle_exit_minutes`
 *     (default 30; the maintainer's Mac sets 15) exits. Never one whose own work runs on after its
 *     turn (a background command or subagent, an agent team, an armed wakeup or /loop), one waiting
 *     on a permission prompt, Main or a VP, or one the user is in now (typed into its chat or had it
 *     open within that window). Those keep the plain idle timeout.
 *  2. Live limit: past `local_live_limit` live processes (default one per 2.4 GB of memory, 4 to
 *     64: 20 on a 48 GB Mac, 6 on 16 GB), the health monitor stops the longest-quiet sessions whose
 *     turn is over (quiet at least EVICT_MIN_QUIET_MS) until the count is back at the limit, Main
 *     and the VPs last; and an automatic start (hosts/placement.ts) finds the machine full only when
 *     its processes that must stay alive already fill the limit, so it waits in the start queue
 *     instead of adding a process that nothing could make room for. A person's own start and a
 *     message that resumes a session are never held; the limit trims the idle ones after.
 *
 * The stop itself is the idle reap's (session-health-monitor.ts reapIdleSession): through the
 * daemon that owns the process, never a signal from here.
 *
 * Why these defaults for any install: a cold resume costs a few seconds once; an idle CLI costs
 * 0.3 to 1.1 GB for as long as it lives. 30 minutes keeps a session alive across a short break in
 * a conversation, and half the old 60. A process per 2.4 GB leaves room for the OS, the browser
 * and the server on a small machine and matches the 20 measured as safe on the 48 GB Mac.
 */
import os from 'node:os';
import type { SessionRecord, Task } from '../types.js';

export const DEFAULT_IDLE_EXIT_MINUTES = 30;
/** A just-ended turn keeps its process this long before the live limit may stop it: the status
 *  question, the summary and a follow-up message usually come within it. */
export const EVICT_MIN_QUIET_MS = 5 * 60_000;
export const LIVE_GB_PER_SESSION = 2.4;
export const MIN_LIVE_LIMIT = 4;
export const MAX_LIVE_LIMIT = 64;
const GB = 1024 ** 3;

export interface LiveSessionConfig {
  local_idle_exit_minutes?: number;
  local_live_limit?: number;
  /** 0 = the user asked Walnut never to stop a quiet session: no live limit unless one is set. */
  idle_timeout_minutes?: number;
}

function setting(v: unknown): number | null {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The idle exit on this machine, in ms; null when off (setting 0). */
export function localIdleExitMs(cfg: LiveSessionConfig | undefined): number | null {
  const m = setting(cfg?.local_idle_exit_minutes) ?? DEFAULT_IDLE_EXIT_MINUTES;
  return m === 0 ? null : m * 60_000;
}

/** The live process limit on this machine; 0 = none. */
export function localLiveLimit(cfg: LiveSessionConfig | undefined, memTotalBytes = os.totalmem()): number {
  const set = setting(cfg?.local_live_limit);
  if (set !== null) return Math.floor(set);
  if (cfg?.idle_timeout_minutes === 0) return 0;
  const byMem = memTotalBytes > 0 ? Math.floor(memTotalBytes / GB / LIVE_GB_PER_SESSION) : MIN_LIVE_LIMIT;
  return Math.min(MAX_LIVE_LIMIT, Math.max(MIN_LIVE_LIMIT, byMem));
}

/** A record of this machine whose CLI process is alive (as the record says; the health monitor
 *  corrects a dead one within a tick). SDK and embedded sessions have no process of their own. */
export function isLocalLiveProcess(s: Pick<SessionRecord, 'host' | 'archived' | 'process_status' | 'pid' | 'provider'>): boolean {
  if (s.host || s.archived) return false;
  if (s.process_status !== 'running' && s.process_status !== 'idle') return false;
  if (s.pid == null) return false;
  return s.provider !== 'sdk' && s.provider !== 'embedded';
}

/** What the runner knows of a live session (providers/claude-code-session.ts sessionRunner). */
export interface LiveRunnerView {
  isInTurn?(claudeSessionId: string): boolean | null;
  hasWorkOutlivingTurn?(claudeSessionId: string): boolean;
  isCronArmed?(claudeSessionId: string): boolean;
  hasPendingPermission?(claudeSessionId: string): boolean;
  isTeamActive?(claudeSessionId: string): boolean;
}

export type StayReason = 'turn' | 'own-work' | 'loop' | 'prompt' | 'team' | 'user-here';

/**
 * Why this live process must stay, or null when it may exit to give its memory back. A session
 * the runner does not hold reads by its record: `running` is in a turn.
 */
export function mustStay(
  s: Pick<SessionRecord, 'claudeSessionId' | 'process_status'>, runner: LiveRunnerView | null | undefined, userHere: boolean,
): StayReason | null {
  const sid = s.claudeSessionId;
  const inTurn = runner?.isInTurn?.(sid) ?? null;
  if (inTurn === true || (inTurn === null && s.process_status === 'running')) return 'turn';
  if (runner?.hasWorkOutlivingTurn?.(sid)) return 'own-work';
  if (runner?.isCronArmed?.(sid)) return 'loop';
  if (runner?.hasPendingPermission?.(sid)) return 'prompt';
  if (runner?.isTeamActive?.(sid)) return 'team';
  if (userHere) return 'user-here';
  return null;
}

/** Main and the VPs: the idle exit leaves them alone, and the live limit stops them last. */
export function exitsLast(task: Pick<Task, 'org_role'> | null | undefined): boolean {
  return task?.org_role === 'main' || task?.org_role === 'lead' || task?.org_role === 'router';
}

/** How recently a person must have been in a session's chat for it to stay (both rules, both readers). */
export function userHereWindowMs(cfg: LiveSessionConfig | undefined): number {
  return localIdleExitMs(cfg) ?? USER_HERE_FALLBACK_MS;
}
const USER_HERE_FALLBACK_MS = 15 * 60_000;

/** Whether a person is in this session's chat now or was within `withinMs`. */
export async function userHereIn(
  s: Pick<SessionRecord, 'claudeSessionId' | 'chatInputAt' | 'taskId'>, withinMs: number, now = Date.now(),
): Promise<boolean> {
  try {
    const { userInTaskChat } = await import('../org/user-away.js');
    return await userInTaskChat(s.taskId, [s], withinMs, now);
  } catch {
    // Unknown: keep it, a wrong stop costs the user a cold resume while he types.
    return true;
  }
}

export interface EvictionCandidate {
  claudeSessionId: string;
  /** Since its last output, ms. */
  quietMs: number;
  /** Main or a VP (exitsLast). */
  last: boolean;
}

/**
 * The order the live limit stops sessions in: everyone else before Main and the VPs, the longest
 * quiet first; only those quiet at least EVICT_MIN_QUIET_MS. Pure.
 */
export function evictionOrder(candidates: readonly EvictionCandidate[]): EvictionCandidate[] {
  return candidates
    .filter((c) => c.quietMs >= EVICT_MIN_QUIET_MS)
    .slice()
    .sort((a, b) => (Number(a.last) - Number(b.last)) || (b.quietMs - a.quietMs));
}
