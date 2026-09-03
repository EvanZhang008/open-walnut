/**
 * Spawn prefix: what a session's claude process was ACTUALLY launched with.
 *
 * A fork (`claude --resume <parent> --fork-session`) reuses the parent's prompt
 * cache only when its first API call is byte-identical to the parent's prefix,
 * and the prefix starts with the system prompt. The system prompt is shaped by
 * the spawn argv: `--append-system-prompt`, `--model`, `--effort`,
 * `--permission-mode`. So the fork must copy those from the parent's LIVE
 * process, not rebuild them: a parent that was cold-resumed without an append
 * prompt runs a shorter system prompt than the one its record remembers, and a
 * freshly built prompt matches neither. Measured on a 300K-token parent: fresh
 * build = 195K tokens re-written, 47s to first text; verbatim copy = full hit.
 *
 * Source order: the daemon's registry for the live process (host-local truth,
 * `status` with `includeArgs`) → the record's stored spawn-time prompt → none.
 * A fork NEVER falls back to a fresh build.
 */

import type { SessionEffort, SessionRecord } from '../types.js';
import { log } from '../../logging/index.js';

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Same cap as the spawn-side persist: the value rides a shell-quoted argv. */
export const MAX_SPAWN_PROMPT_BYTES = 65536;

export interface SpawnPrefix {
  /** The exact `--append-system-prompt` value; null = the process runs WITHOUT one. */
  appendSystemPrompt: string | null;
  model?: string;
  effort?: SessionEffort;
  permissionMode?: string;
  source: 'live-process' | 'record' | 'unknown';
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : undefined;
}

/** Pure: read the prefix-shaping flags out of a claude argv. */
export function parseSpawnPrefixFromArgs(args: readonly string[]): SpawnPrefix {
  const prompt = flagValue(args, '--append-system-prompt');
  return {
    appendSystemPrompt: prompt !== undefined && Buffer.byteLength(prompt, 'utf8') <= MAX_SPAWN_PROMPT_BYTES
      ? prompt
      : null,
    ...(flagValue(args, '--model') ? { model: flagValue(args, '--model') } : {}),
    ...(EFFORTS.includes(flagValue(args, '--effort') ?? '')
      ? { effort: flagValue(args, '--effort') as SessionEffort } : {}),
    ...(flagValue(args, '--permission-mode') ? { permissionMode: flagValue(args, '--permission-mode') } : {}),
    source: 'live-process',
  };
}

/** Pure: the record's remembered spawn-time prompt ('' means explicitly none). */
export function spawnPrefixFromRecord(record: Pick<SessionRecord, 'appliedAppendSystemPrompt'>): SpawnPrefix {
  const stored = record.appliedAppendSystemPrompt;
  if (stored === undefined || stored === null) return { appendSystemPrompt: null, source: 'unknown' };
  const usable = stored.length > 0 && Buffer.byteLength(stored, 'utf8') <= MAX_SPAWN_PROMPT_BYTES;
  return { appendSystemPrompt: usable ? stored : null, source: 'record' };
}

/** Injectable for tests; production reads the daemon registry. */
export type LiveArgsReader = (hostKey: string, sessionId: string) => Promise<string[] | null>;

async function defaultLiveArgsReader(hostKey: string, sessionId: string): Promise<string[] | null> {
  const { probeDaemonSessionArgs } = await import('../../providers/daemon-connection.js');
  return probeDaemonSessionArgs(hostKey, sessionId);
}

/**
 * Resolve the prefix a fork of `parent` must reproduce. When the live process
 * answers, its prompt is also written back to the parent record so the parent's
 * own next cold resume keeps the same prefix (and so a later fork can answer
 * from the record when the process is gone).
 */
export async function readParentSpawnPrefix(
  parent: SessionRecord,
  deps: { readLiveArgs?: LiveArgsReader; persist?: (sid: string, prompt: string) => Promise<unknown> } = {},
): Promise<SpawnPrefix> {
  const readLiveArgs = deps.readLiveArgs ?? defaultLiveArgsReader;
  const hostKey = parent.host || '__local__';
  let live: string[] | null = null;
  try {
    live = await readLiveArgs(hostKey, parent.claudeSessionId);
  } catch (err) {
    log.session.debug('spawn prefix: live argv read threw', {
      sessionId: parent.claudeSessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (live && live.length > 0) {
    const prefix = parseSpawnPrefixFromArgs(live);
    const remembered = parent.appliedAppendSystemPrompt ?? undefined;
    const actual = prefix.appendSystemPrompt ?? '';
    if (remembered !== actual) {
      const persist = deps.persist ?? (async (sid, prompt) => {
        const { updateSessionRecord } = await import('../session-tracker.js');
        return updateSessionRecord(sid, { appliedAppendSystemPrompt: prompt });
      });
      // Best-effort: the fork already has the truth in hand; this only keeps the
      // parent's NEXT cold resume on the same prefix.
      void persist(parent.claudeSessionId, actual).catch((err: unknown) => {
        log.session.warn('spawn prefix: backfill of applied prompt failed', {
          sessionId: parent.claudeSessionId, error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return prefix;
  }
  return spawnPrefixFromRecord(parent);
}
