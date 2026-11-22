import { SESSION_MODE_IDS, type SessionMode } from '../types.js';
import type { VouchedJob } from '../plugin-jobs/job-caller.js';

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
 * Who asks to start or set work, for the start-mode ceiling (startModeCeiling).
 *   person      no caller sid: the user's own CLI or UI
 *   plugin      an installed plugin's server half (caller sid `plugin:<id>`)
 *   plugin-job  that plugin's job, vouched for by its host's daemon (plugin-jobs/job-caller.ts)
 *   session     a session, bounded by its own mode
 *   external    anonymous or unknown (the gateway's `external`, a sid that names no session, or
 *               a session sid its host's daemon could not prove: lib/caller-unproven.ts)
 */
export type StartCaller =
  | { kind: 'person' }
  | { kind: 'plugin' }
  | { kind: 'plugin-job'; plugin: string; job: string; host: string }
  | { kind: 'session'; mode: SessionMode | undefined }
  | { kind: 'external' };

/** The loosest mode this caller may start or set work in; null = no ceiling. Pure. */
export function startModeCeiling(caller: StartCaller): SessionMode | null {
  switch (caller.kind) {
    case 'person':
    case 'plugin':
    case 'plugin-job':
      return null;
    case 'session':
      return caller.mode && SESSION_MODE_IDS.includes(caller.mode) ? caller.mode : 'default';
    default:
      return 'default';
  }
}

/**
 * Apply it: the mode to use; an asked-for looser mode throws, an implied one (a project default)
 * comes down. Pure.
 *
 * `implied`: the mode was not asked for but carried over (an engine switch keeping the task's
 * mode, a project's default); a looser one comes down to the ceiling instead of refusing.
 * Under a ceiling, a start that names no mode takes the caller's own (delegatedMode).
 */
export function applyStartModeCeiling(caller: StartCaller, requested: string | undefined, opts: { implied?: boolean } = {}): SessionMode | undefined {
  const ceiling = startModeCeiling(caller);
  if (ceiling === null) return requested as SessionMode | undefined;
  if (opts.implied) return requested && ceiling !== 'bypass' && looserThan(requested, ceiling) ? ceiling : requested as SessionMode | undefined;
  return delegatedMode(ceiling, requested);
}

/**
 * What a start or a mode change knows of its caller beyond the sid.
 *   job       the plugin job a request's credential vouched for (plugin-jobs/job-caller.ts
 *             vouchedPluginJob); it counts only for an outside caller, never for a session's sid,
 *             a plugin's server half or a person
 *   unproven  the host's daemon could not prove the sid (lib/caller-unproven.ts callerUnprovenOf):
 *             the caller is anonymous here, whatever the sid names; the sid stays its provenance
 */
export interface CallerTrust { job?: VouchedJob | null; unproven?: boolean }

/** The StartCaller a caller sid names, with what else the request proved (CallerTrust). */
export async function startCallerOf(callerSid: string | undefined, trust: CallerTrust = {}): Promise<StartCaller> {
  // Checked before the sid: an unproven caller never reads as the person, a plugin or a session.
  if (trust.unproven) return { kind: 'external' };
  if (!callerSid?.trim()) return { kind: 'person' };
  const { resolveCaller } = await import('./session-send-core.js');
  const caller = await resolveCaller(callerSid);
  if (caller.kind === 'human') return { kind: 'person' };
  if (caller.kind === 'session') return { kind: 'session', mode: caller.record.mode };
  if (caller.app) return { kind: 'plugin' };
  const job = trust.job;
  return job ? { kind: 'plugin-job', plugin: job.plugin, job: job.job, host: job.host } : { kind: 'external' };
}

/** Why an unproven caller met the outside caller's ceiling, after the refusal's words. */
export const UNPROVEN_NOTE = 'Its host could not confirm which session made this call, so it counts as an outside caller.';

/**
 * The one ceiling every start path applies (tests/core/sessions/start-mode-ceiling-guard.test.ts):
 * a session (or a sid that names none) starts work at most as loose as its own mode. The person's
 * own CLI (no caller), an installed plugin's own call and its job vouched for by its host
 * (`opts.job`) are not capped; a caller whose sid its host could not prove (`opts.unproven`) is
 * capped as an outside caller.
 *
 * A looser mode the caller asked for is refused with a 403 QuickStartError; an implied one comes
 * down (applyStartModeCeiling).
 */
export async function capStartMode(
  callerSid: string | undefined, requested?: string, opts: { implied?: boolean } & CallerTrust = {},
): Promise<SessionMode | undefined> {
  if (!callerSid?.trim() && !opts.unproven) return requested as SessionMode | undefined;
  const caller = await startCallerOf(callerSid, opts);
  try { return applyStartModeCeiling(caller, requested, opts); }
  catch (err) {
    const { QuickStartError } = await import('./quick-start.js');
    const msg = err instanceof Error ? err.message : String(err);
    throw new QuickStartError(opts.unproven ? `${msg} ${UNPROVEN_NOTE}` : msg, 403);
  }
}

/**
 * The same ceiling for a live mode change (PATCH a session's mode, its mode control): a session
 * may set any session's mode, its own included, only as loose as its own mode. Returns the
 * refusal's words, or null when allowed. The person and an installed plugin are not capped; an
 * unproven caller (`opts.unproven`) is capped as an outside caller.
 */
export async function modeChangeRefusal(callerSid: string | undefined, mode: unknown, opts: { unproven?: boolean } = {}): Promise<string | null> {
  if (typeof mode !== 'string' || (!callerSid?.trim() && !opts.unproven)) return null;
  try { await capStartMode(callerSid, mode, { unproven: opts.unproven }); return null; }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.replace('cannot start a task in', 'cannot set a session to');
  }
}
