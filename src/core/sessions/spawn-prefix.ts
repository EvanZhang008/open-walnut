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
 *
 * MODEL AND EFFORT ARE NOT READ FROM ARGV. They are the only two parts of the
 * prefix a live session can CHANGE after spawn (`applyModel`/`applyEffort` push
 * `apply_flag_settings`, no respawn), so the argv is frozen at whatever the
 * process launched with. A parent switched to Fable 5.1 at medium still shows
 * `--model …fable-5 --effort xhigh` in its argv, and a fork built from that argv
 * launches under the OLD model and effort — both of which are part of the
 * prompt-cache key, so the thread pays a full prefix write and the CLI also
 * strips the history's signed thinking as belonging to another model. That is the
 * 2026-09-21 "btw is slow" root cause. Authority here, most→least trusted:
 * the live CLI's applied settings (`refreshAppliedSettings`) → the record (Walnut
 * writes it on every switch) → argv (last resort, a process nobody can reach).
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
 * What the live CLI says it is CURRENTLY running, or null when unreachable.
 * There is NO default implementation on purpose: the only holder of live applied
 * settings is the session runner, and importing it here would drag the whole
 * provider graph into every unit test that touches a prefix. Callers that can
 * reach a live session inject `liveAppliedSettings` (side-thread-fork does);
 * everyone else gets the record, which Walnut writes on every switch.
 */
export type AppliedSettingsReader = (
  sessionId: string,
) => Promise<{ model: string | null; effort: SessionEffort | null } | null>;

/**
 * Current model/effort for a fork of `parent`. Never argv (see the file header).
 * A `null` from the CLI means "unreachable", NOT "unset": fall through to the
 * record rather than treating it as an explicit clear.
 */
async function currentModelAndEffort(
  parent: SessionRecord,
  read?: AppliedSettingsReader,
): Promise<{ model?: string; effort?: SessionEffort; source: 'live-settings' | 'record' }> {
  let applied: Awaited<ReturnType<AppliedSettingsReader>> = null;
  try {
    applied = (await read?.(parent.claudeSessionId)) ?? null;
  } catch (err) {
    log.session.debug('spawn prefix: applied-settings read threw', {
      sessionId: parent.claudeSessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  const model = applied?.model || parent.cliModel;
  const effort = applied?.effort ?? parent.effort;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    source: applied?.model || applied?.effort ? 'live-settings' : 'record',
  };
}

/**
 * Resolve the prefix a fork of `parent` must reproduce. When the live process
 * answers, its prompt is also written back to the parent record so the parent's
 * own next cold resume keeps the same prefix (and so a later fork can answer
 * from the record when the process is gone).
 */
export async function readParentSpawnPrefix(
  parent: SessionRecord,
  deps: {
    readLiveArgs?: LiveArgsReader;
    liveAppliedSettings?: AppliedSettingsReader;
    persist?: (sid: string, prompt: string) => Promise<unknown>;
  } = {},
): Promise<SpawnPrefix> {
  const readLiveArgs = deps.readLiveArgs ?? defaultLiveArgsReader;
  const hostKey = parent.host || '__local__';
  const current = await currentModelAndEffort(parent, deps.liveAppliedSettings);
  let live: string[] | null = null;
  try {
    live = await readLiveArgs(hostKey, parent.claudeSessionId);
  } catch (err) {
    log.session.debug('spawn prefix: live argv read threw', {
      sessionId: parent.claudeSessionId, error: err instanceof Error ? err.message : String(err),
    });
  }
  if (live && live.length > 0) {
    const fromArgs = parseSpawnPrefixFromArgs(live);
    // Argv owns the immutable half (append prompt, permission mode) outright and
    // is only the LAST resort for model/effort: dropping it when nothing else
    // answered would spawn the fork with no --model at all, landing it on the
    // CLI's default model — a worse miss than a stale one.
    const model = current.model ?? fromArgs.model;
    const effort = current.effort ?? fromArgs.effort;
    const prefix: SpawnPrefix = {
      appendSystemPrompt: fromArgs.appendSystemPrompt,
      ...(fromArgs.permissionMode ? { permissionMode: fromArgs.permissionMode } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      source: 'live-process',
    };
    if (fromArgs.model !== model || fromArgs.effort !== effort) {
      // Loud on purpose: this line IS the bug's fingerprint. A fork built from
      // argv here would have paid a full prefix rewrite.
      log.session.info('spawn prefix: argv model/effort superseded by current settings', {
        sessionId: parent.claudeSessionId,
        argvModel: fromArgs.model ?? null, currentModel: model ?? null,
        argvEffort: fromArgs.effort ?? null, currentEffort: effort ?? null,
        currentSource: current.source,
      });
    }
    const remembered = parent.appliedAppendSystemPrompt ?? undefined;
    const actual = fromArgs.appendSystemPrompt ?? '';
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
  // No live process: the record is the only source, and it also carries the
  // current model/effort (Walnut persists both on every switch).
  const fromRecord = spawnPrefixFromRecord(parent);
  return {
    ...fromRecord,
    ...(current.model ? { model: current.model } : {}),
    ...(current.effort ? { effort: current.effort } : {}),
  };
}
