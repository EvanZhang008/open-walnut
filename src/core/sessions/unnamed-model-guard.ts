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
 * environment the CLI will have (this process's for the local host, each settings file's `env` laid
 * over it), whose ANTHROPIC_MODEL outranks `model` in the files Settings > Engines declares
 * (engine-settings/claude.ts), in the CLI's order. An alias is judged by what its
 * ANTHROPIC_DEFAULT_<FAMILY>_MODEL pin sends it to, since a user may pin `opus` to anything.
 * A Claude default (an alias, a `claude` provider id, or unset) is kept: it is the user's own
 * Claude choice. Any other default is replaced by the family alias of Walnut's own main model
 * (`agent.main_model`, else Opus) whose pin still names Claude (claudeFallback). Not seen from
 * here: a remote host's shell environment, and a routine's own folder while the Mac is away (its
 * host template reads the user's settings only). A read that
 * fails or runs out of time keeps the old behavior and says so in the log: a guard must never
 * stop a session from starting. Answers are kept 30 s per host and folder, so a burst of starts
 * reads once.
 *
 * Every spawn path that may leave `--model` out is listed in
 * tests/core/sessions/unnamed-model-guard-ratchet.test.ts.
 */

import { log } from '../../logging/index.js';
import { SESSION_MODEL_FAMILIES } from '../types.js';
import { DEFAULT_MODEL } from '../../model/providers/defaults.js';

/** Claude Code's own model aliases (`claude --help`, `/model`), any with a `[1m]` suffix. */
const CLAUDE_ALIASES = new Set<string>(['default', 'best', 'opusplan', ...SESSION_MODEL_FAMILIES]);

type Family = (typeof SESSION_MODEL_FAMILIES)[number];
/** The model each family alias stands for, as the CLI's ANTHROPIC_DEFAULT_<FAMILY>_MODEL pins say. */
export type AliasPins = Partial<Record<Family, string>>;

/** True when this id, taken literally, is a Claude model or alias. Empty = the CLI's built-in default. */
export function isClaudeModelId(id: string | null | undefined): boolean {
  const v = (id ?? '').trim().toLowerCase();
  if (!v) return true;
  const base = v.replace(/\[1m\]$/, '');
  if (CLAUDE_ALIASES.has(base)) return true;
  // Provider ids name the family: claude-opus-5-5, global.anthropic.claude-opus-5-5, an ARN of one.
  return base.includes('claude');
}

/** The family an alias stands for; the built-in default and its other names count as opus. Null for a model id. */
function familyOfAlias(id: string | null | undefined): Family | null {
  const base = (id ?? '').trim().toLowerCase().replace(/\[1m\]$/, '');
  if (!base || base === 'default' || base === 'best' || base === 'opusplan') return 'opus';
  return (SESSION_MODEL_FAMILIES as readonly string[]).includes(base) ? base as Family : null;
}

/** What the CLI runs for this value: an alias goes through its family's pin (the user may pin opus to anything). */
export function resolvedModel(value: string | null | undefined, pins: AliasPins | undefined): string {
  const family = familyOfAlias(value);
  if (family) return pins?.[family]?.trim() || (value ?? '');
  return value ?? '';
}

/**
 * The Claude model a session with a non-Claude CLI default starts on: the family alias of Walnut's
 * main model, else another family whose pin still names Claude, else Walnut's main model as a
 * full id (an alias every pin sends elsewhere would land outside Claude again).
 */
export function claudeFallback(mainModel: string | null | undefined, pins?: AliasPins): string {
  const lower = (mainModel ?? '').toLowerCase();
  const mainIsClaude = !!lower && isClaudeModelId(lower);
  const mainFamily = mainIsClaude ? SESSION_MODEL_FAMILIES.find((f) => lower.includes(f)) : undefined;
  const order = [...new Set<Family>([...(mainFamily ? [mainFamily] : []), 'opus', 'sonnet', 'haiku', 'fable'])];
  for (const f of order) {
    const pin = pins?.[f];
    if (!pin || isClaudeModelId(pin)) return f;
  }
  return mainIsClaude && !familyOfAlias(mainModel) ? mainModel!.trim() : DEFAULT_MODEL;
}

export interface UnnamedModelDecision {
  /** The CLI's default as read, null when nothing sets one, undefined when it could not be read. */
  cliDefault: string | null | undefined;
  /** What that default resolves to through the alias pins, when it differs. */
  resolved?: string;
  /** Where it came from: the env variable's name, or the settings file's path. */
  from?: string;
  /** The `--model` value to add; absent = leave the spawn as it is. */
  use?: string;
  /** Why the default could not be read (the spawn goes on unchanged). */
  error?: string;
}

/** The CLI's default model as read on a host: the value, where it came from, and the alias pins in force. */
export interface CliModelDefault {
  value: string | null;
  from?: string;
  pins?: AliasPins;
}

/** The decision alone, for a default already read (pure). */
export function decideUnnamedModel(read: CliModelDefault, mainModel: string | null | undefined): string | undefined {
  return isClaudeModelId(resolvedModel(read.value, read.pins)) ? undefined : claudeFallback(mainModel, read.pins);
}

export interface UnnamedModelDeps {
  /** The CLI's default model on that host and folder, where it came from, and the alias pins. */
  readDefault(host: string, cwd: string | undefined): Promise<CliModelDefault>;
  mainModel(): Promise<string | undefined>;
}

const READ_DEADLINE_MS = 5_000;

/** The files the CLI reads `model` from, highest first (its own precedence: local over shared over user). */
const MODEL_FILES = ['project-local', 'project', 'user'] as const;
const MAX_SETTINGS_BYTES = 1024 * 1024;

interface SettingsModelPart {
  model: string | null;
  env: Record<string, string>;
}

/** `model` and the string `env` entries of a settings file's text; nothing from a file the CLI could not use. */
export function modelPartOfSettingsText(text: string | null): SettingsModelPart {
  const none: SettingsModelPart = { model: null, env: {} };
  if (!text) return none;
  try {
    const o = JSON.parse(text) as { model?: unknown; env?: unknown };
    const model = typeof o?.model === 'string' && o.model.trim() ? o.model.trim() : null;
    const env: Record<string, string> = {};
    if (o?.env && typeof o.env === 'object' && !Array.isArray(o.env)) {
      for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) if (typeof v === 'string') env[k] = v;
    }
    return { model, env };
  } catch {
    return none;
  }
}

/** `model` of a settings file's text, null when absent or unreadable. */
export function modelOfSettingsText(text: string | null): string | null {
  return modelPartOfSettingsText(text).model;
}

/**
 * The CLI's default from what a host holds, as the CLI reads it: every settings file's `env` is
 * laid over the process environment (user, then the project's shared, then its local file), and
 * ANTHROPIC_MODEL there outranks `model` in any file, highest file first.
 * `parts` are in MODEL_FILES order (highest first).
 */
export function cliDefaultOf(processEnv: Readonly<Record<string, string | undefined>> | undefined, parts: SettingsModelPart[], paths: (string | undefined)[]): CliModelDefault {
  const env: Record<string, string | undefined> = { ...(processEnv ?? {}) };
  for (let i = parts.length - 1; i >= 0; i--) Object.assign(env, parts[i].env);
  const pins: AliasPins = {};
  for (const f of SESSION_MODEL_FAMILIES) {
    const v = env[`ANTHROPIC_DEFAULT_${f.toUpperCase()}_MODEL`]?.trim();
    if (v) pins[f] = v;
  }
  const fromEnv = env.ANTHROPIC_MODEL?.trim();
  if (fromEnv) return { value: fromEnv, from: 'ANTHROPIC_MODEL', pins };
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].model) return { value: parts[i].model, ...(paths[i] ? { from: paths[i] } : {}), pins };
  }
  return { value: null, pins };
}

async function defaultDeps(): Promise<UnnamedModelDeps> {
  return {
    async readDefault(host, cwd) {
      // The local daemon inherits this process's environment (as the engines route reads it);
      // a remote host's own environment is not visible from here, only its settings files.
      const env = host === '__local__' ? process.env : undefined;
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
      return cliDefaultOf(env, texts.map(modelPartOfSettingsText), paths);
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
    const resolved = resolvedModel(read.value, read.pins);
    const use = isClaudeModelId(resolved) ? undefined : decideUnnamedModel(read, await d.mainModel());
    const decision: UnnamedModelDecision = {
      cliDefault: read.value,
      ...(resolved && resolved !== read.value ? { resolved } : {}),
      ...(read.from ? { from: read.from } : {}),
      ...(use ? { use } : {}),
    };
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
