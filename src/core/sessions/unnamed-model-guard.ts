/**
 * A Claude Code session whose starter named no model runs a Claude model.
 *
 * "No model" means Walnut passes no `--model` and the CLI picks its own default from its
 * settings layers (env ANTHROPIC_MODEL, the project's .claude/settings{,.local}.json, the user's
 * ~/.claude/settings.json). That default is the user's terminal choice and may name a model
 * outside Claude, routed by a local proxy (2026-11-07: the Mac's settings.json said
 * `gpt-6.1-sol`, written by an unrecorded writer on 2026-11-06, and every task session started
 * there without a model ran Sol, one of which ran a sign-in tool and cleared the SSH agent; the
 * user asked "why u use sol in the first place, is it explicit setting?"). It was not.
 *
 * So before a spawn without `--model`, Walnut reads that default on the session's host: the
 * environment's ANTHROPIC_MODEL (local host only, its env is this process's), then `model` in the
 * files Settings > Engines declares for it (engine-settings/claude.ts), in the CLI's order.
 * A Claude default (an alias, a `claude` provider id, or unset) is kept: it is the user's own
 * Claude choice. Any other default is replaced by the family alias of Walnut's own main model
 * (`agent.main_model`, else Opus), which the CLI maps through the user's alias pins. A read that
 * fails or runs out of time keeps the old behavior and says so in the log: a guard must never
 * stop a session from starting. Answers are kept 30 s per host and folder, so a burst of starts
 * reads once.
 *
 * Every spawn path that may leave `--model` out is listed in
 * tests/core/sessions/unnamed-model-guard-ratchet.test.ts.
 */

import { log } from '../../logging/index.js';
import { SESSION_MODEL_FAMILIES } from '../types.js';

/** Claude Code's own model aliases (`claude --help`, `/model`), any with a `[1m]` suffix. */
const CLAUDE_ALIASES = new Set<string>(['default', 'best', 'opusplan', ...SESSION_MODEL_FAMILIES]);

/** True when the CLI resolves this model id to a Claude model. Empty = the CLI's built-in (Claude) default. */
export function isClaudeModelId(id: string | null | undefined): boolean {
  const v = (id ?? '').trim().toLowerCase();
  if (!v) return true;
  const base = v.replace(/\[1m\]$/, '');
  if (CLAUDE_ALIASES.has(base)) return true;
  // Provider ids name the family: claude-opus-5-5, global.anthropic.claude-opus-5-5, an ARN of one.
  return base.includes('claude');
}

/** The Claude alias a session with a non-Claude CLI default starts on: the family of Walnut's main model, else opus. */
export function claudeFallbackAlias(mainModel: string | null | undefined): string {
  const lower = (mainModel ?? '').toLowerCase();
  if (lower && isClaudeModelId(lower)) {
    for (const family of SESSION_MODEL_FAMILIES) if (lower.includes(family)) return family;
  }
  return 'opus';
}

export interface UnnamedModelDecision {
  /** The CLI's default as read, null when nothing sets one, undefined when it could not be read. */
  cliDefault: string | null | undefined;
  /** Where it came from: the env variable's name, or the settings file's id. */
  from?: string;
  /** The `--model` value to add; absent = leave the spawn as it is. */
  use?: string;
  /** Why the default could not be read (the spawn goes on unchanged). */
  error?: string;
}

/** The decision alone, for a default already read (pure). */
export function decideUnnamedModel(cliDefault: string | null, mainModel: string | null | undefined): string | undefined {
  return isClaudeModelId(cliDefault) ? undefined : claudeFallbackAlias(mainModel);
}

export interface UnnamedModelDeps {
  /** The CLI's default model on that host and folder, and where it came from. */
  readDefault(host: string, cwd: string | undefined): Promise<{ value: string | null; from?: string }>;
  mainModel(): Promise<string | undefined>;
}

const READ_DEADLINE_MS = 5_000;

/** The files the CLI reads `model` from, highest first (its own precedence: local over shared over user). */
const MODEL_FILES = ['project-local', 'project', 'user'] as const;
const MAX_SETTINGS_BYTES = 1024 * 1024;

/** `model` of a settings file's text, null when absent or unreadable (an unreadable file sets nothing the CLI uses). */
export function modelOfSettingsText(text: string | null): string | null {
  if (!text) return null;
  try {
    const v = (JSON.parse(text) as { model?: unknown })?.model;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

async function defaultDeps(): Promise<UnnamedModelDeps> {
  return {
    async readDefault(host, cwd) {
      // The local daemon inherits this process's environment (as the engines route reads it);
      // a remote host's environment is not visible from here.
      const env = host === '__local__' ? process.env : undefined;
      const fromEnv = env?.ANTHROPIC_MODEL?.trim();
      if (fromEnv) return { value: fromEnv, from: 'ANTHROPIC_MODEL' };
      const { CLAUDE_SETTINGS } = await import('../agents/engine-settings/claude.js');
      const { resolveSettingsFilePath } = await import('../agents/engine-settings-service.js');
      const { DaemonFileReader } = await import('../daemon-file-reader.js');
      const reader = new DaemonFileReader(host);
      const paths = MODEL_FILES.map((id) => {
        const decl = CLAUDE_SETTINGS.files.find((f) => f.id === id);
        return decl ? resolveSettingsFilePath(decl, env, cwd) : undefined;
      });
      // A file that cannot be read sets nothing here: the guard decides on what it can read.
      const texts = await Promise.all(paths.map((p) => (p
        ? reader.readFile(p).then((t) => (t && t.length <= MAX_SETTINGS_BYTES ? t : null), () => null)
        : Promise.resolve(null))));
      for (let i = 0; i < paths.length; i++) {
        const value = modelOfSettingsText(texts[i]);
        if (value) return { value, from: paths[i] };
      }
      return { value: null };
    },
    async mainModel() {
      const { getConfig } = await import('../config-manager.js');
      return (await getConfig()).agent?.main_model;
    },
  };
}

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; decision: UnnamedModelDecision }>();

/** Tests: forget every kept answer. */
export function _resetUnnamedModelGuardCache(): void {
  cache.clear();
}

/** Read the host's CLI default and decide. Never throws; a failed read is not kept. */
export async function guardUnnamedModel(
  host: string | undefined, cwd: string | undefined, deps?: UnnamedModelDeps, deadlineMs = READ_DEADLINE_MS,
): Promise<UnnamedModelDecision> {
  const where = host && host.trim() ? host : '__local__';
  const key = `${where}\n${cwd ?? ''}`;
  const kept = deps ? undefined : cache.get(key);
  if (kept && Date.now() - kept.at < CACHE_MS) return kept.decision;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const d = deps ?? await defaultDeps();
    const read = await Promise.race([
      d.readDefault(where, cwd),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs} ms`)), deadlineMs); }),
    ]);
    const use = decideUnnamedModel(read.value, isClaudeModelId(read.value) ? undefined : await d.mainModel());
    const decision: UnnamedModelDecision = { cliDefault: read.value, ...(read.from ? { from: read.from } : {}), ...(use ? { use } : {}) };
    if (!deps) {
      const now = Date.now();
      if (cache.size > 200) for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
      cache.set(key, { at: now, decision });
    }
    return decision;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.session.warn('unnamed model guard: could not read the CLI default model; spawning without --model', { host: where, cwd, error });
    return { cliDefault: undefined, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Put `--model <use>` into a spawn argv that has none, in place (after the permission mode, else at the end). */
export function insertModelArg(args: string[], use: string): string[] {
  if (args.includes('--model')) return args;
  const at = args.indexOf('--permission-mode');
  const pos = at !== -1 && at + 1 < args.length ? at + 2 : args.length;
  args.splice(pos, 0, '--model', use);
  return args;
}
