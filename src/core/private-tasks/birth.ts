/**
 * Where a new task in a project that syncs to an outside service starts (2026-11-01, the user:
 * "it will always create local first and do these eval and then if error always warn user").
 *
 * Every new task bound for an outside service is born LOCAL (`source: 'local'`, so nothing and
 * no older Walnut pushes it) with a `sync_hold` saying why and where it would go:
 *
 *   - its text matches one of the user's private words: `private` (by words), final;
 *   - the creator chose Local: `chosen` (by user), final;
 *   - else, with the model check on: `checking`, and sync-gate.ts asks the small model; only a
 *     task it judges to be work gets its project's source and is pushed;
 *   - with the check off (the user turned it off, or a test server with no model): the project's
 *     source at once, after the words found nothing.
 *
 * Pure: the caller (addTask, the cloud outbox's create) writes what this decides.
 */
import type { PrivateTasksConfig, SyncHold, TaskSource } from '../types.js';
import { matchPrivateWords } from './private-words.js';

export interface BirthText {
  title: string;
  description?: string;
  note?: string;
}

export interface BirthDecision {
  source: TaskSource;
  hold?: SyncHold;
}

/** The words entry a task's text matches, or null. */
export function privateWordIn(cfg: PrivateTasksConfig | undefined, text: BirthText): string | null {
  return matchPrivateWords(cfg?.words, [text.title, text.description, text.note]);
}

/** The line a task kept local by the user's words shows. */
export function wordsReason(entry: string): string {
  return `It matches your private word "${entry}"`;
}

/**
 * The source and hold of a task about to be created with `target` as its project's outside
 * service. `explicitLocal`: the creator asked for Local. `canJudge`: the model check may run
 * (config on, and a model to ask).
 */
export function decideBirth(
  target: TaskSource,
  text: BirthText,
  cfg: PrivateTasksConfig | undefined,
  opts: { explicitLocal?: boolean; canJudge: boolean; now?: string },
): BirthDecision {
  const at = opts.now ?? new Date().toISOString();
  if (!target || target === 'local') return { source: 'local' };
  if (opts.explicitLocal) {
    return { source: 'local', hold: { target, state: 'chosen', by: 'user', reason: 'Kept local when it was created', at } };
  }
  const entry = privateWordIn(cfg, text);
  if (entry) return { source: 'local', hold: { target, state: 'private', by: 'words', reason: wordsReason(entry), at } };
  if (opts.canJudge) return { source: 'local', hold: { target, state: 'checking', reason: 'Walnut is checking whether it is private', at } };
  return { source: target };
}

/** The model check is on unless the user turned it off. */
export function modelCheckOn(cfg: PrivateTasksConfig | undefined): boolean {
  return cfg?.model_check !== false;
}
