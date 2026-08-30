/**
 * Engine availability probe — answers "can this host actually run engine X?"
 * for GET /api/engines and the web engine catalog.
 *
 * Three rules this module exists to obey (each one is a shipped incident):
 *   1. NEVER execSync. A version probe on the server's event loop freezes every
 *      route, so every child process here is async execFile with its own
 *      timeout.
 *   2. Answer within a deadline. `probeEngines` resolves with whatever is known
 *      when its budget expires (cached, possibly stale, or "still checking")
 *      instead of waiting out a wedged binary. The in-flight probe keeps
 *      running and fills the cache, so the next request is exact.
 *   3. Never accept a node_modules binary. npm prepends node_modules/.bin to
 *      PATH, and a bundled provider CLI can carry a different auth chain than
 *      the user's system install (same fail-closed rule as
 *      acp-session.resolveSystemCodexPath).
 *
 * Results are cached per engine for ENGINE_PROBE_TTL_MS so a page full of
 * catalog readers costs one spawn per engine per minute.
 *
 * `WALNUT_ENGINE_PROBE_ALL=1` forces every engine to `installed: true` and
 * spawns nothing — the Playwright fixture needs a deterministic catalog on a
 * machine that has none of these CLIs installed.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { SessionEngine } from '../types.js';
import { resolveClaudeCliExecutable } from '../claude-cli-detect.js';
import { ENGINE_REGISTRY, type EngineCapabilities } from './engine-registry.js';

const execFileAsync = promisify(execFile);

/** How long a probe result stays fresh. */
export const ENGINE_PROBE_TTL_MS = 60_000;

/** Per-binary budget for `binary --version`. Longer than the batch deadline on purpose (see probeEngines). */
export const ENGINE_VERSION_TIMEOUT_MS = 5_000;

/** Batch budget: what a caller waits before taking the stale/partial answer. */
export const ENGINE_PROBE_DEADLINE_MS = 2_500;

/** Config key the `custom` engine takes its adapter argv from. */
export const CUSTOM_ADAPTER_CMD_KEY = 'engines.custom.adapter_cmd';

export interface EngineAvailability {
  /** True when walnut can start a session on this engine right now. */
  installed: boolean;
  /** First line of `binary --version`, or null when unknown / not run. */
  version: string | null;
  /** Why it is unusable. Set only when installed is false. */
  reason: string | null;
}

export interface EngineProbeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Extra fixed directories probed after PATH and the per-user bin dirs. */
  systemDirectories?: readonly string[];
  /** Batch budget in ms (default ENGINE_PROBE_DEADLINE_MS). */
  deadlineMs?: number;
  /** Injected `binary versionArgs` runner (tests). Must never throw. */
  runVersion?: (binary: string, args: readonly string[]) => Promise<string | null>;
  /** Injected walnut config reader; only called for the config-sourced engine. */
  loadConfig?: () => Promise<unknown>;
  /** Injected presence check for the bundled ACP adapter entry. */
  bundledAdapterPresent?: (binaryName: string) => boolean;
  now?: () => number;
}

interface CacheEntry {
  at: number;
  value: EngineAvailability;
}

const cache = new Map<SessionEngine, CacheEntry>();
const inFlight = new Map<SessionEngine, Promise<EngineAvailability>>();

/** Test hook: forget every cached/in-flight probe. */
export function _resetEngineProbeCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Test hook: pin an engine's availability so a probe never spawns anything. */
export function _seedEngineProbeCache(engineId: SessionEngine, value: EngineAvailability, at = Date.now()): void {
  cache.set(engineId, { at, value });
}

function probeAllOverride(env: NodeJS.ProcessEnv): boolean {
  return env.WALNUT_ENGINE_PROBE_ALL === '1';
}

/** Env var that pins an engine's executable, e.g. WALNUT_CODEX_PATH. */
export function enginePathOverrideVar(engineId: SessionEngine): string {
  return `WALNUT_${engineId.toUpperCase()}_PATH`;
}

const DEFAULT_SYSTEM_DIRS = process.platform === 'win32'
  ? []
  : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/**
 * Locate an engine's executable the way the daemon would: inherited PATH first,
 * then the per-user install dirs a service process often lacks, then the fixed
 * system dirs. Mirrors resolveClaudeCliExecutable's directory list (that one is
 * claude-specific and boolean-only) plus the node_modules ban.
 */
export function findEngineBinary(
  binaryName: string,
  options: { env?: NodeJS.ProcessEnv; cwd?: string; systemDirectories?: readonly string[] } = {},
): string | null {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const dirs = [
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean),
    path.join(home, '.toolbox', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    ...(options.systemDirectories ?? DEFAULT_SYSTEM_DIRS),
  ];
  const names = process.platform === 'win32'
    ? [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`, binaryName]
    : [binaryName];

  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.resolve(cwd, dir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const usable = usableExecutable(candidate);
      if (usable) return usable;
    }
  }
  return null;
}

/**
 * An absolute candidate is usable when it is a real, executable file that is not
 * one of walnut's own bundled binaries. Returns the REQUESTED path (not the
 * realpath): dispatch wrappers can care about argv[0].
 *
 * The node_modules ban is deliberately SCOPED, because "realpath contains
 * node_modules" is not the hazard and rejects real installs: homebrew and
 * `npm i -g` put every node CLI under a node_modules dir
 * (/opt/homebrew/bin/gemini realpaths into
 * Cellar/gemini-cli/*_/libexec/lib/node_modules/...), so a blanket ban reports
 * two of the three ACP CLIs on this machine as "not installed". What must never
 * be selected is a binary npm injected into PATH (any candidate PATH entry
 * inside a node_modules dir) or one that resolves into THIS walnut install's
 * node_modules, since those can carry a different auth chain than the user's
 * system install.
 */
export function usableExecutable(candidate: string): string | null {
  const verdict = inspectExecutable(candidate);
  return verdict.executable ?? null;
}

/** Why a candidate was refused. The two node_modules cases need DIFFERENT fixes, so they are distinct. */
export type ExecutableRejection = 'npm_injected_path' | 'walnut_bundled' | 'not_executable';

/** usableExecutable with the cause, for callers that report it (an explicit override). */
export function inspectExecutable(candidate: string): { executable?: string; rejection?: ExecutableRejection } {
  if (hasNodeModulesSegment(candidate)) return { rejection: 'npm_injected_path' };
  try {
    const canonical = fs.realpathSync(candidate);
    if (isWalnutBundledPath(canonical)) return { rejection: 'walnut_bundled' };
    if (!fs.statSync(canonical).isFile()) return { rejection: 'not_executable' };
    fs.accessSync(candidate, fs.constants.X_OK);
    return { executable: candidate };
  } catch {
    return { rejection: 'not_executable' };
  }
}

function hasNodeModulesSegment(candidate: string): boolean {
  return path.resolve(candidate).split(path.sep).some((segment) => segment.toLowerCase() === 'node_modules');
}

let walnutNodeModulesDirs: string[] | null = null;

/**
 * node_modules dir belonging to THIS walnut install's OWN deps — anchored to the
 * nearest ancestor that owns a package.json, never every ancestor node_modules.
 *
 * A global install lives at `<prefix>/node_modules/open-walnut/…`, so banning
 * every ancestor node_modules would also ban `<prefix>/node_modules` — the
 * shared registry root that holds sibling provider CLIs installed with
 * `npm i -g` (gemini/opencode/goose), falsely reporting them "not installed"
 * and throwing at launch. Ban walnut's OWN node_modules, never the registry
 * root it happens to sit inside.
 */
function walnutNodeModulesRoots(): string[] {
  if (walnutNodeModulesDirs) return walnutNodeModulesDirs;
  const found: string[] = [];
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 8; up++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      const own = path.join(dir, 'node_modules');
      if (fs.existsSync(own)) found.push(fs.realpathSync(own));
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  walnutNodeModulesDirs = found;
  return found;
}

function isWalnutBundledPath(canonical: string): boolean {
  return walnutNodeModulesRoots().some((root) => canonical === root || canonical.startsWith(root + path.sep));
}

/** Run `binary versionArgs` with a hard timeout. Never throws; null when it fails. */
async function readVersion(binary: string, args: readonly string[]): Promise<string | null> {
  if (args.length === 0) return null;
  try {
    const { stdout, stderr } = await execFileAsync(binary, [...args], {
      timeout: ENGINE_VERSION_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    const text = (stdout || stderr || '').split('\n').map((l) => l.trim()).find((l) => l.length > 0);
    return text ? text.slice(0, 120) : null;
  } catch {
    return null;
  }
}

/** Adapter entry each 'bundled'-source engine needs under this install, by probed binary. */
const BUNDLED_ADAPTER_ENTRIES: Record<string, string> = {
  codex: path.join('node_modules', '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'),
};

/**
 * Is the bundled ACP adapter present in this install? The path depth differs
 * between source (src/core/agents) and the tsup bundle (dist/), so walk up to
 * the first ancestor that owns the adapter — same shape as
 * acp-session.resolveAcpArtifacts, which builds the argv from it.
 */
function bundledAdapterExists(binaryName: string): boolean {
  const rel = BUNDLED_ADAPTER_ENTRIES[binaryName];
  if (!rel) return false;
  let root = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (fs.existsSync(path.join(root, rel))) return true;
    const parent = path.dirname(root);
    if (parent === root) break;
    root = parent;
  }
  return false;
}

/** Read `engines.custom.adapter_cmd` structurally, so this module does not depend on the config type shape. */
function readCustomAdapterCmd(config: unknown): string[] | null {
  const engines = (config as { engines?: Record<string, unknown> } | null | undefined)?.engines;
  const custom = (engines as { custom?: { adapter_cmd?: unknown } } | undefined)?.custom;
  const cmd = custom?.adapter_cmd;
  if (!Array.isArray(cmd)) return null;
  const argv = cmd.filter((part): part is string => typeof part === 'string' && part.length > 0);
  return argv.length > 0 ? argv : null;
}

async function loadWalnutConfig(options: EngineProbeOptions): Promise<unknown> {
  if (options.loadConfig) return options.loadConfig();
  // Lazy: keeps the probe (and anything importing it) free of the config
  // manager's yaml + ssh-discovery cost until the custom engine is asked about.
  const { getConfig } = await import('../config-manager.js');
  return getConfig();
}

function unavailable(reason: string): EngineAvailability {
  return { installed: false, version: null, reason };
}

/** Each rejection has its own fix, so say which one happened. */
function overrideReason(overrideVar: string, override: string, rejection?: ExecutableRejection): string {
  switch (rejection) {
    case 'npm_injected_path':
      return `${overrideVar} points inside a node_modules directory (${override}); npm-injected copies are never used, choose a system install`;
    case 'walnut_bundled':
      return `${overrideVar} resolves into walnut's own bundled copy (${override}); point it at the provider's system install instead`;
    default:
      return `${overrideVar} is not an executable file: ${override}`;
  }
}

/**
 * The presence verdict, plus an OPTIONAL background version fetch. Installed-ness
 * is decided synchronously from binary/adapter presence; the `binary --version`
 * spawn only produces the cosmetic `version` string, so it must never gate the
 * verdict. Coupling them made the always-installed default engine report "still
 * checking" whenever a loaded host's version spawn outran the batch deadline
 * (this machine runs under load &gt;100 routinely) — see probeEngine.
 */
interface ProbeResult {
  availability: EngineAvailability;
  fillVersion?: () => Promise<string | null>;
}

async function runProbe(caps: EngineCapabilities, options: EngineProbeOptions): Promise<ProbeResult> {
  const env = options.env ?? process.env;
  const runVersion = options.runVersion ?? readVersion;
  const adapter = caps.acpAdapter;

  // Native engines (claude today): walnut's own session substrate. Treated as
  // installed unconditionally — the CLI is walnut's baseline dependency, and a
  // spawn failure reports itself far more precisely than a catalog flag can.
  if (!adapter) {
    const binary = caps.id === 'claude' ? resolveClaudeCliExecutable(env) : findEngineBinary(caps.id, options);
    return {
      availability: { installed: true, version: null, reason: null },
      fillVersion: binary ? () => runVersion(binary, ['--version']) : undefined,
    };
  }

  if (adapter.source === 'config') {
    const config = await loadWalnutConfig(options).catch(() => null);
    const argv = readCustomAdapterCmd(config);
    if (!argv) return { availability: unavailable(`configure ${CUSTOM_ADAPTER_CMD_KEY} (the ACP adapter argv) to use ${caps.displayName}`) };
    return { availability: { installed: true, version: null, reason: null } };
  }

  const binaryName = adapter.binary;
  if (!binaryName) return { availability: unavailable(`${caps.displayName} has no probe target configured`) };

  // An override is exact and fail-closed: we never fall back to PATH discovery
  // after the operator named a specific executable (an unnoticed fallback is how
  // a session ends up on a different auth chain than the one asked for).
  const overrideVar = enginePathOverrideVar(caps.id);
  const override = env[overrideVar];
  let binary: string | null;
  if (override) {
    const verdict = inspectExecutable(path.resolve(options.cwd ?? process.cwd(), override));
    if (!verdict.executable) return { availability: unavailable(overrideReason(overrideVar, override, verdict.rejection)) };
    binary = verdict.executable;
  } else {
    binary = findEngineBinary(binaryName, { ...options, env });
    if (!binary) return { availability: unavailable(`${caps.displayName} CLI not found: install \`${binaryName}\` on PATH or set ${overrideVar}`) };
  }

  // 'bundled' engines need BOTH the provider CLI (auth + model access) and the
  // adapter that speaks ACP to it; either one missing means no session.
  if (adapter.source === 'bundled') {
    const present = (options.bundledAdapterPresent ?? bundledAdapterExists)(binaryName);
    if (!present) {
      return { availability: unavailable(`the bundled ${binaryName}-acp adapter is missing from this walnut install (run npm install)`) };
    }
  }

  const resolvedBinary = binary;
  return {
    availability: { installed: true, version: null, reason: null },
    fillVersion: () => runVersion(resolvedBinary, adapter.versionArgs),
  };
}

/**
 * Availability for ONE engine. Serves a fresh cache entry without spawning, and
 * dedupes concurrent callers onto one in-flight probe.
 */
export function probeEngine(engineId: SessionEngine, options: EngineProbeOptions = {}): Promise<EngineAvailability> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const caps = ENGINE_REGISTRY.get(engineId);
  if (!caps) return Promise.resolve(unavailable(`unknown engine: ${engineId}`));
  if (probeAllOverride(env)) return Promise.resolve({ installed: true, version: null, reason: null });

  const cached = cache.get(engineId);
  if (cached && now() - cached.at < ENGINE_PROBE_TTL_MS) return Promise.resolve(cached.value);

  const existing = inFlight.get(engineId);
  if (existing) return existing;

  const started = runProbe(caps, options)
    .catch((err: unknown): ProbeResult => ({ availability: unavailable(err instanceof Error ? err.message : String(err)) }))
    .then(async (result) => {
      const { availability, fillVersion } = result;
      // Cache the presence verdict NOW, before the version spawn — a batch
      // probeEngines() reads the cache at its deadline and must see `installed`
      // the instant the (synchronous) binary/adapter checks are done, never wait
      // out a loaded host's `--version` (which is purely cosmetic).
      cache.set(engineId, { at: now(), value: availability });
      if (!fillVersion || !availability.installed) return availability;
      // The direct caller (and a within-TTL cache read) still gets the version:
      // fill it, then update the cache — but only while our presence verdict is
      // still the current entry (a fresher probe or a test seed must win).
      const version = await fillVersion().catch(() => null);
      const full = version === null ? availability : { ...availability, version };
      const entry = cache.get(engineId);
      if (entry && entry.value === availability) cache.set(engineId, { at: entry.at, value: full });
      return full;
    })
    .finally(() => {
      inFlight.delete(engineId);
    });
  inFlight.set(engineId, started);
  return started;
}

/**
 * Availability for every registered engine, bounded by `deadlineMs`.
 *
 * On deadline the answer degrades instead of hanging: a stale cache entry if
 * there is one, otherwise a "still checking" entry. The probe promise is NOT
 * cancelled, so it lands in the cache and the next call is exact. This is the
 * whole reason a route may call it on the request path.
 */
export async function probeEngines(options: EngineProbeOptions = {}): Promise<Map<SessionEngine, EngineAvailability>> {
  const env = options.env ?? process.env;
  const ids = [...ENGINE_REGISTRY.keys()];
  if (probeAllOverride(env)) {
    return new Map(ids.map((id) => [id, { installed: true, version: null, reason: null }] as const));
  }

  const pending = ids.map((id) => probeEngine(id, options));
  const deadlineMs = options.deadlineMs ?? ENGINE_PROBE_DEADLINE_MS;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, deadlineMs);
      // Never hold the process open for a probe nobody is waiting on.
      timer.unref?.();
    }),
  ]);

  const out = new Map<SessionEngine, EngineAvailability>();
  for (const id of ids) {
    const entry = cache.get(id);
    out.set(id, entry ? entry.value : {
      installed: false,
      version: null,
      reason: 'still checking availability',
    });
  }
  return out;
}
