import { SESSION_MODE_IDS, type SessionMode } from '../types.js';

/** A preapproved task_create cannot launch work with greater trust than its caller. */
export function delegatedMode(caller: SessionMode, requested?: string): SessionMode | undefined {
  if (!SESSION_MODE_IDS.includes(caller)) caller = 'default';
  if (caller === 'bypass') return requested as SessionMode | undefined;
  if (requested && looserThan(requested, caller)) {
    throw new Error(`A ${caller} session cannot start a task in ${requested} mode. Change the caller's mode first.`);
  }
  return (requested as SessionMode | undefined) ?? caller;
}

function looserThan(mode: string, ceiling: SessionMode): boolean {
  return SESSION_MODE_IDS.indexOf(mode as SessionMode) > SESSION_MODE_IDS.indexOf(ceiling);
}

/**
 * The one ceiling every start path applies (tests/core/sessions/start-mode-ceiling-guard.test.ts):
 * a session (or a sid that names none) starts work at most as loose as its own mode. The person's
 * own CLI (no caller) and an installed plugin's own call are not capped.
 *
 * `implied`: the mode was not asked for but carried over (an engine switch keeping the task's
 * mode, a project's default); a looser one comes down to the caller's instead of refusing.
 * A looser mode the caller asked for is refused with a 403 QuickStartError.
 */
export async function capStartMode(callerSid: string | undefined, requested?: string, opts: { implied?: boolean } = {}): Promise<SessionMode | undefined> {
  if (!callerSid?.trim()) return requested as SessionMode | undefined;
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(callerSid);
  if (caller.kind === 'human' || (caller.kind === 'external' && !!caller.app)) return requested as SessionMode | undefined;
  let ceiling: SessionMode = caller.kind === 'session' ? caller.record.mode ?? 'default' : 'default';
  if (!SESSION_MODE_IDS.includes(ceiling)) ceiling = 'default';
  if (opts.implied) return requested && ceiling !== 'bypass' && looserThan(requested, ceiling) ? ceiling : requested as SessionMode | undefined;
  try { return delegatedMode(ceiling, requested); }
  catch (err) {
    const { QuickStartError } = await import('./quick-start.js');
    throw new QuickStartError(err instanceof Error ? err.message : String(err), 403);
  }
}

/**
 * The same ceiling for a live mode change (PATCH a session's mode, its mode control): a session
 * may set any session's mode, its own included, only as loose as its own mode. Returns the
 * refusal's words, or null when allowed. The person and an installed plugin are not capped.
 */
export async function modeChangeRefusal(callerSid: string | undefined, mode: unknown): Promise<string | null> {
  if (typeof mode !== 'string' || !callerSid?.trim()) return null;
  try { await capStartMode(callerSid, mode); return null; }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.replace('cannot start a task in', 'cannot set a session to');
  }
}
