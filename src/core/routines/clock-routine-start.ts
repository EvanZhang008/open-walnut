/**
 * What a host starts a claude-code routine's run from (clock-host-start-v1), the one place that
 * builds it: clock-placement.ts places clocks and re-exports this for its callers.
 */

import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { START_TASK_TOKEN, validateClockStartSpec, type ClockStartSpec } from '../../providers/trigger-clock-core.js';
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
 * their cards), an absolute folder, the Claude Code engine for that host, and no SDK
 * session server (which would run it another way).
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
  const [{ getConfig, isFallbackConfig }, { resolveDefaultEngine }, { normalizeEngine }, { VALID_SESSION_EFFORT_IDS }] = await Promise.all([
    import('../config-manager.js'), import('../agents/default-engine.js'), import('../agents/engine-registry.js'), import('../types.js'),
  ]);
  const config = await getConfig();
  if (isFallbackConfig(config) || !config.hosts?.[host] || config.session_server?.enabled) return null;
  if (normalizeEngine(resolveDefaultEngine(config, { host })) !== undefined) return null;
  const title = (typeof c.taskTitle === 'string' && c.taskTitle.trim()) || `Routine: ${job.name}`;
  const project = (typeof c.project === 'string' && c.project.trim()) || 'Routines';
  const model = typeof c.model === 'string' && c.model.trim() ? c.model.trim() : undefined;
  const effort = config.agent?.session_effort && VALID_SESSION_EFFORT_IDS.has(config.agent.session_effort) ? config.agent.session_effort : undefined;
  let context = '';
  try {
    const { buildSessionContext } = await import('../sessions/session-context.js');
    const task = { id: START_TASK_TOKEN, title, project } as unknown as import('../types.js').Task;
    context = (await buildSessionContext(START_TASK_TOKEN, cwd, host, { task })).systemPrompt;
  } catch (err) {
    // A run without its context would differ from this Mac's: it stays here.
    log.cron.warn('clock placement: no session context for a routine run on its host; it stays the Mac\'s to start', { host, jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
  const spec = validateClockStartSpec({
    home, host, title, project, cwd,
    message: (await import('../sessions/send-frame.js')).frameAsWalnut(message, 'routine', `routine:${job.id}:${job.name}`),
    mode: (await (await import('../../providers/claude-launch-mode.js')).resolveClaudeLaunchMode(host, cwd)).mode, modeNamed: false,
    ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(context ? { context } : {}),
  });
  if (!spec.ok) {
    log.cron.debug('clock placement: a routine run cannot start on its host', { host, jobId: job.id, error: spec.error });
    return null;
  }
  return spec.spec;
}
