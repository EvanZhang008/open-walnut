/**
 * What a host starts a claude-code routine's run from (clock-host-start-v1), the one place that
 * builds it: clock-placement.ts places clocks and re-exports this for its callers.
 */

import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { validateClockStartSpec, type ClockStartSpec } from '../../providers/trigger-clock-core.js';
import type { CronJob } from '../cron/types.js';
import { portableClaudeConfigOf } from './clock-portable.js';
import { promptOf } from './trigger-push.js';

/**
 * What a host starts a claude-code routine's run from while this Mac is away
 * (clock-host-start-v1), or null when the run stays this Mac's to start. Every field
 * is the one this Mac's claude-code executor would use (executors/claude-code.ts,
 * quickStartSession): the instructions as the first message, the routine's folder,
 * model and title ("Routine: <name>" unless it names one, sent as the literal text),
 * its project ("Routines" unless it names one), the mode this Mac runs a routine in
 * (none named: the engine setting, else Auto when supported), the configured session effort, and the session
 * context this Mac would append, built for the run's task with START_TASK_TOKEN where
 * the id goes (the host mints it).
 *
 * `at.cwd`: the routine is portable (clock-portable.ts), so it names no host of its own and the
 * run starts on `host` in this folder, its own mapped into that host's Walnut home. The
 * routine's configured host is never read as `host`, and never renamed to it.
 *
 * Eligible only when the host can do what this Mac would do: an ordinary routine (no
 * console agent, no title template), instructions short enough to go inline (the Mac
 * spills longer ones to a file here) and naming no task or project pill (the Mac adds
 * their cards), an absolute folder and the Claude Code engine for that host. This is a
 * fresh daemon-owned CLI run, independent of the primary's SDK session-server setting.
 */
export async function routineStartOf(job: CronJob, host: string, home: string = WALNUT_HOME, at?: { cwd: string }): Promise<ClockStartSpec | null> {
  if (job.executor?.type !== 'claude-code' || !host || host === '__local__') return null;
  const c = (job.executor.config ?? {}) as Record<string, unknown>;
  if (at ? !portableClaudeConfigOf(job) : (typeof c.host === 'string' ? c.host.trim() : '') !== host) return null;
  if (c.walnutAgent === true || (typeof c.agentId === 'string' && c.agentId.trim()) || (typeof c.titleTemplate === 'string' && c.titleTemplate.trim())) return null;
  const message = promptOf(job);
  const cwd = at ? at.cwd : typeof c.cwd === 'string' ? c.cwd.trim() : '';
  if (!message.trim() || !cwd.startsWith('/')) return null;
  const [{ QUICK_START_MESSAGE_SPILL_LIMIT }, { listEntityRefs }, { readTriageCountHint }] = await Promise.all([
    import('../../constants.js'), import('../../utils/entity-refs.js'), import('./executors/claude-code.js'),
  ]);
  if (message.length > QUICK_START_MESSAGE_SPILL_LIMIT || listEntityRefs(message).length > 0 || readTriageCountHint(message) !== undefined) return null;
  const { getConfig, isFallbackConfig } = await import('../config-manager.js');
  const config = await getConfig();
  if (isFallbackConfig(config) || !config.hosts?.[host]) return null;
  const title = (typeof c.taskTitle === 'string' && c.taskTitle.trim()) || `Routine: ${job.name}`;
  const project = (typeof c.project === 'string' && c.project.trim()) || 'Routines';
  const model = typeof c.model === 'string' && c.model.trim() ? c.model.trim() : undefined;
  // How this Mac starts a fresh Claude Code session there (sessions/fresh-claude-start.ts), the
  // routine naming no engine or mode of its own.
  let start: Awaited<ReturnType<typeof import('../sessions/fresh-claude-start.js').freshClaudeStart>>;
  try {
    // The project's default effort, as a routine run on the Mac takes it (sessions/claude-launch-defaults.ts).
    const projectEffort = (await (await import('../sessions/project-launch-defaults.js')).projectLaunchDefaultsOf(project).catch(() => ({ effort: undefined }))).effort;
    start = await (await import('../sessions/fresh-claude-start.js')).freshClaudeStart({
      config, host, cwd, task: { title, project }, ...(projectEffort ? { defaults: { effort: projectEffort } } : {}),
    });
  } catch (err) {
    // A run without its context would differ from this Mac's: it stays here.
    log.cron.warn('clock placement: no session context for a routine run on its host; it stays the Mac\'s to start', { host, jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  if (!start) return null;
  const spec = validateClockStartSpec({
    home, host, title, project, cwd,
    message: (await import('../sessions/send-frame.js')).frameAsWalnut(message, 'routine', `routine:${job.id}:${job.name}`),
    mode: start.mode, modeNamed: false,
    ...(model ?? start.model ? { model: model ?? start.model } : {}), ...(start.effort ? { effort: start.effort } : {}), ...(start.context ? { context: start.context } : {}),
  });
  if (!spec.ok) {
    log.cron.debug('clock placement: a routine run cannot start on its host', { host, jobId: job.id, error: spec.error });
    return null;
  }
  return spec.spec;
}
