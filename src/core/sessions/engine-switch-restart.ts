/**
 * A switch or move this server's own stop cut short is paused, never failed (2026-11-12: three
 * task moves from this Mac died 1 to 2 s after a deploy began, recorded as "Walnut is not
 * connected to this Mac right now.", and each had to be asked for again).
 *
 * engine-switch.ts's fail() asks pauseForRestart first, and its restore() only lets go of a
 * start that did not confirm, so no failure path of a switch can miss it. While this server is
 * stopping (server-stopping.ts) nothing is put back: restoring the old session would hand its
 * held messages to a server going down. The switch stays `switching`, which the claim already
 * wrote, so a stop too hard for this write still leaves it there; `error` and `interrupted` say
 * what happened and what the run had reached. The next boot (engine-switch-watch.ts,
 * resumeEngineSwitches) stops a start that never confirmed, makes the old session the task's
 * session again and runs the switch from the start. Each step a second run repeats is safe to
 * repeat: retiring archives again and stops a CLI already stopped, a pack starts its folder over,
 * a staged copy at offset 0 starts over, and a piece of the work the cut run set up on the target
 * (or was setting up) is kept, or has this run's pack set up in it, never made again beside it
 * (transfer/task-work.ts, `done` and `inDoubt`).
 */
import type { EngineSwitchInterrupted, EngineSwitchState, SessionRecord } from '../types.js';
import type { MovedPiece } from '../transfer/task-work.js';
import { log } from '../../logging/index.js';
import { engineCaps } from '../agents/engine-registry.js';
import { LOCAL_HOST, normalizeHost } from '../transfer/planner.js';
import { interruptedByShutdown, serverStopNote, serverStopWords } from '../server-stopping.js';

/** What a run had reached when it stopped: what it set up, what it was setting up, a start not confirmed. */
export interface SwitchProgress {
  applied: MovedPiece[];
  /** By destination: a piece whose set-up was asked for and not answered yet. */
  applying: Map<string, { kind: string; source: string; dest: string }>;
  start?: { session_id?: string; since: string };
}

export function newSwitchProgress(): SwitchProgress {
  return { applied: [], applying: new Map() };
}

/** The words the task keeps (and the caller gets) for a switch a server stop cut short. */
export function restartPauseText(sw: Pick<EngineSwitchState, 'move' | 'to'>): string {
  const host = normalizeHost(sw.to.host);
  const what = sw.move ? `the move to ${host === LOCAL_HOST ? 'this Mac' : host}` : `the switch to ${engineCaps(sw.to.engine).displayName}`;
  return `The Walnut server restarted${serverStopNote()} while ${what} ran. Nothing was lost: the task's work and conversation `
    + `are where they were, and ${what} runs again by itself once Walnut is back up. There is no need to ask for it again.`;
}

/** What the next run starts from: the earlier cut runs' record with this run's on top. */
function merged(prior: EngineSwitchInterrupted | undefined, progress: SwitchProgress | undefined): Pick<EngineSwitchInterrupted, 'applied' | 'in_doubt' | 'unconfirmed_start'> {
  const applied = new Map<string, MovedPiece>();
  for (const p of [...(prior?.applied ?? []), ...(progress?.applied ?? [])]) if (p.applied) applied.set(p.dest, p);
  const doubt = new Map<string, { kind: string; source: string; dest: string }>();
  for (const d of [...(prior?.in_doubt ?? []), ...(progress?.applying.values() ?? [])]) doubt.set(d.dest, d);
  // Set up after all: no longer in doubt.
  for (const dest of applied.keys()) doubt.delete(dest);
  const start = progress?.start ?? prior?.unconfirmed_start;
  return {
    ...(applied.size ? { applied: [...applied.values()] } : {}),
    ...(doubt.size ? { in_doubt: [...doubt.values()] } : {}),
    ...(start ? { unconfirmed_start: start } : {}),
  };
}

/**
 * When `err` came from this server's stop: record the switch as cut short (still `switching`,
 * with what its run reached) and answer the plain words for it. Null for any other failure.
 */
export async function pauseForRestart(taskId: string, state: EngineSwitchState, err: unknown, progress?: SwitchProgress): Promise<string | null> {
  if (!interruptedByShutdown(err)) return null;
  const text = restartPauseText(state);
  const cause = err instanceof Error ? err.message : String(err);
  try {
    const { updateTaskRaw } = await import('../task-manager.js');
    await updateTaskRaw(taskId, (cur) => {
      const sw = cur.engine_switch;
      // Never over a newer switch, or one a person cancelled meanwhile.
      if (!sw || sw.id !== state.id || sw.state !== 'switching') return null;
      return {
        engine_switch: {
          ...sw, error: text,
          interrupted: { at: new Date().toISOString(), by: serverStopWords(), cause: cause.slice(0, 500), ...merged(sw.interrupted, progress) },
        },
      };
    }, { source: 'engine-switch', emitEvent: true });
  } catch (writeErr) {
    // The store may already be closing: the claim's `switching` still brings the switch back at boot.
    log.session.warn('engine switch: the restart note was not written; the switch still runs again at boot', {
      taskId, switchId: state.id, error: writeErr instanceof Error ? writeErr.message : String(writeErr),
    });
  }
  log.session.warn('engine switch: this server\'s stop cut it short; it runs again after the next boot', {
    taskId, switchId: state.id, move: !!state.move, to: state.to.host, applied: progress?.applied.length ?? 0,
    inDoubt: progress?.applying.size ?? 0, unconfirmedStart: progress?.start?.session_id, cause,
  });
  return text;
}

/**
 * At boot, before a cut switch runs again: whether the session the task holds now is the switch's
 * new one, by its record's own word (2026-11-12 review: the cut run's detach can fail silently
 * while the store closes, so the task may still hold a start that never confirmed).
 */
export function tookOver(rec: Pick<SessionRecord, 'engineSwitch' | 'resumedBySwitch'> | null | undefined, sw: Pick<EngineSwitchState, 'from_session_id'>): boolean {
  return rec?.engineSwitch?.fromSessionId === sw.from_session_id || rec?.resumedBySwitch?.fromSessionId === sw.from_session_id;
}

/**
 * Stop, through their owners, the sessions a cut switch started that never confirmed: the one it
 * named, the one the task holds now when that never took over, and any other of the task started
 * since the start was asked for. Each is let go of by the task. Null when all are stopped; else why
 * one may still run (then the switch must not run again: two CLIs would share the work).
 */
export async function endUnconfirmedStarts(taskId: string, sw: EngineSwitchState, holding?: string): Promise<string | null> {
  const tracker = await import('../session-tracker.js');
  const { detachTaskSession } = await import('./task-session-claim.js');
  const { endReplacedSession } = await import('./replaced-session.js');
  const start = sw.interrupted?.unconfirmed_start;
  const rows = await tracker.getSessionsForTask(taskId).catch(() => [] as SessionRecord[]);
  const ids = new Set<string>([...(start?.session_id ? [start.session_id] : []), ...(holding ? [holding] : [])]);
  for (const r of rows) {
    if (start && r.claudeSessionId !== sw.from_session_id && !r.supersededBy && (r.startedAt ?? '') >= start.since && !tookOver(r, sw)) ids.add(r.claudeSessionId);
  }
  ids.delete(sw.from_session_id);
  for (const sid of ids) {
    const rec = rows.find((r) => r.claudeSessionId === sid) ?? await tracker.getSessionByClaudeId(sid).catch(() => null);
    if (!rec) continue;
    try {
      await endReplacedSession(rec, { taskId });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    await detachTaskSession(taskId, sid, 'engine switch did not start').catch(() => {});
    log.session.info('engine switch: a start the restart cut off is stopped before the switch runs again', { taskId, sessionId: sid });
  }
  return null;
}
