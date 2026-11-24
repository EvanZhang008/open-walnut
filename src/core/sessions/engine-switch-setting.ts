/**
 * An engine switch (or move) a setting refuses: a Codex provider that reaches nothing on the
 * task's host (codex-engine-config.ts codexProviderForPlace), or another engines.codex value a
 * start refuses. Answered as a start answers it (task-start.ts): 422 `engine_config` with the
 * setting's own words, never a 502 an agent would retry as it is, and recorded on the task's
 * failed switch with its message held, so the person can send it here or pick again once the
 * setting is changed.
 *
 *   settingPreflight  asked before anything changes (the old session keeps its process and its
 *                     rows; a running turn is not stopped for a switch that cannot start)
 *   settingRefusal    a start that a setting refused anyway (the setting changed meanwhile)
 */
import { ENGINE_CONFIG_CODE, isCodexEngineConfigError } from '../../providers/codex-engine-config.js';
import type { SessionEngine } from '../types.js';
import { engineCaps, resolveEngine } from '../agents/engine-registry.js';
import { LOCAL_HOST, normalizeHost } from '../transfer/planner.js';
import { QuickStartError } from './quick-start.js';

/** An answer with a status and a code (EngineSwitchError's shape, built by the caller). */
type MakeError = (message: string, status: number, code: string) => Error;

/** The setting's words of `err` (its cause chain walked), or null when no setting refused it. */
function settingWords(err: unknown): string | null {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    if (isCodexEngineConfigError(e)) return e.transient ? null : e.message;
    e = (e as { cause?: unknown }).cause;
  }
  if (err instanceof QuickStartError && err.body?.code === ENGINE_CONFIG_CODE) return err.message;
  return null;
}

/**
 * What a refusal by a setting says: `words` for the task's failed switch (the panel's line puts
 * "The switch to X did not start:" before it and a full stop after), `as` the caller's answer.
 */
function refusalOf(words: string, to: { engine: SessionEngine; host: string }, from: { engine?: SessionEngine; move: boolean; stays?: string }, make: MakeError): { words: Error; as: Error } {
  const bare = words.trim().replace(/[.\s]+$/, '');
  const where = to.host === LOCAL_HOST ? 'this Mac' : to.host;
  const answer = from.move
    ? `The move to ${where} did not happen: ${bare}. ${from.stays ? `${from.stays} Move` : 'The task stays where it was; move'} it again once that setting is changed.`
    : `The switch to ${engineCaps(to.engine).displayName} did not start: ${bare}. The task stays on ${engineCaps(resolveEngine(from.engine)).displayName}; pick ${engineCaps(to.engine).displayName} again once that setting is changed.`;
  return { words: new Error(bare), as: make(answer, 422, ENGINE_CONFIG_CODE) };
}

/** The start on `to` that a setting refuses now, before anything changes; null when none does. */
export async function settingPreflight(
  to: { engine: SessionEngine; host: string }, from: { engine?: SessionEngine; move: boolean }, make: MakeError,
): Promise<{ words: Error; as: Error } | null> {
  if (resolveEngine(to.engine) !== 'codex') return null;
  const host = normalizeHost(to.host);
  const { codexStartRefusal } = await import('../../providers/codex-engine-source.js');
  const refused = await codexStartRefusal({ host: host === LOCAL_HOST ? undefined : host });
  return refused ? refusalOf(refused.message, { ...to, host }, from, make) : null;
}

/**
 * A start that a setting refused (`err` from task-start.ts), said as that setting; null for any
 * other failure. `from.stays`: where a move's task and its copied work are now (the work was
 * copied before the start refused).
 */
export function settingRefusal(
  err: unknown, to: { engine: SessionEngine; host: string }, from: { engine?: SessionEngine; move: boolean; stays?: string }, make: MakeError,
): { words: Error; as: Error } | null {
  const words = settingWords(err);
  return words ? refusalOf(words, { ...to, host: normalizeHost(to.host) }, from, make) : null;
}
