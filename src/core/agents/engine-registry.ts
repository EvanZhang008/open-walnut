/**
 * Engine registry — the ONE place that knows what each coding-agent engine
 * can do (docs/plan/agent-provider-platform.md, P0).
 *
 * Every call site that used to test `record.engine === 'codex'` was really
 * asking a capability question ("where does history live?", "can this session
 * fork?", "is liveness sid-keyed?"). Those sites now read the answer from
 * this registry via `engineCaps()`. Adding an engine means adding a
 * descriptor here — NOT editing session lifecycle / health monitor / task
 * start again. A ratchet test (tests/core/engine-branch-ratchet.test.ts)
 * fails the build if a new `engine === '<vendor>'` comparison appears in
 * src/core/, src/web/, src/ops/, src/commands/ or src/utils/ outside this
 * directory — for any registered engine, not just the shipped two.
 *
 * Storage contract (unchanged): session records persist every non-default
 * engine explicitly ('codex', 'gemini', ...) and leave the default engine as
 * `undefined`, which means claude. `normalizeEngine` preserves exactly that
 * shape; `resolveEngine` gives the effective engine for capability lookup.
 */

import { SESSION_ENGINE_IDS, type SessionEngine } from '../types.js';

/** How the engine's runtime is reached (which provider class / daemon command family). */
export type EngineRuntimeKind = 'native' | 'acp';

/** How the ACP adapter process is obtained. Absent for native engines. */
export interface EngineAcpAdapter {
  /**
   * 'bundled' = node + an adapter package under node_modules (codex);
   * 'cli' = the provider CLI itself speaks ACP;
   * 'config' = argv comes from walnut config engines.custom.adapter_cmd.
   */
  readonly source: 'bundled' | 'cli' | 'config';
  /** Binary probed for availability/version (PATH lookup); null when source==='config'. */
  readonly binary: string | null;
  /** argv TAIL after the resolved absolute binary path; null unless source==='cli'. */
  readonly args: readonly string[] | null;
  readonly versionArgs: readonly string[];
}

export interface EngineCapabilities {
  /** Stable engine id (matches SessionEngine values). */
  readonly id: SessionEngine;
  /** Human label for import titles / error prose ("Claude", "Codex"). */
  readonly displayName: string;
  /**
   * Transport strategy: 'native' = long-running CLI over FIFO stream-json
   * (sessionRunner.findByClaudeId); 'acp' = ACP worker + journal
   * (sessionRunner.findAcpSession / findOrAttachAcpSession).
   */
  readonly runtimeKind: EngineRuntimeKind;
  /**
   * Where resumable conversation history lives: the provider's own JSONL
   * transcript (~/.claude/projects) vs the walnut-owned ACP journal.
   */
  readonly historySource: 'provider-jsonl' | 'acp-journal';
  /**
   * Whether walnut can mint the session id before spawn ('preassigned') or
   * must learn it from the provider's session/new ('provider-issued').
   */
  readonly idProvisioning: 'preassigned' | 'provider-issued';
  /**
   * Permission-mode surface: claude exposes the fixed mode set
   * (default/plan/acceptEdits/bypassPermissions); ACP engines advertise
   * arbitrary config options (collaboration_mode etc.).
   */
  readonly modeControl: 'claude-modes' | 'config-options';
  /**
   * Whether permission resolution can carry AskUserQuestion answer patches.
   * ACP providers have no AskUserQuestion tool, so answers are dropped.
   */
  readonly permissionAnswers: boolean;
  /** Mid-session model switch path: live flag push vs ACP config option. */
  readonly modelSwitch: 'live-flag' | 'config-option';
  /** Turn rewind support (fork-based checkpointing) — claude only today. */
  readonly rewind: 'fork-based' | 'unsupported';
  /** Session fork support (claude --fork-session; no ACP session.fork yet). */
  readonly fork: boolean;
  /**
   * Health monitor: whether P2 snapshot pulls apply. ACP sessions project
   * state from the journal instead of pull-based snapshots.
   */
  readonly snapshotPull: boolean;
  /**
   * Health monitor: whether a pid+jsonl sid probe answers liveness. ACP
   * liveness is acpState-keyed — a sid probe always answers dead and would
   * relabel a resumable session as terminally errored.
   */
  readonly sidLivenessProbe: boolean;
  /** Whether skill sync pushes the walnut skill pack into the engine's home. */
  readonly skillSync: boolean;
  /** Whether external (walnut-unaware) sessions of this engine are importable. */
  readonly externalImport: boolean;
  /**
   * Where the model list comes from: a walnut-configured static catalog
   * (claude) vs runtime discovery from the provider's advertised
   * capabilities (ACP engines). Gates the per-session model catalog route.
   */
  readonly modelCatalog: 'static' | 'provider-advertised';
  /** How the ACP adapter process is obtained. Absent for native engines. */
  readonly acpAdapter?: EngineAcpAdapter;
}

const CLAUDE: EngineCapabilities = {
  id: 'claude',
  displayName: 'Claude',
  runtimeKind: 'native',
  historySource: 'provider-jsonl',
  idProvisioning: 'preassigned',
  modeControl: 'claude-modes',
  permissionAnswers: true,
  modelSwitch: 'live-flag',
  rewind: 'fork-based',
  fork: true,
  snapshotPull: true,
  sidLivenessProbe: true,
  skillSync: true,
  externalImport: true,
  modelCatalog: 'static',
};

const CODEX: EngineCapabilities = {
  id: 'codex',
  displayName: 'Codex',
  runtimeKind: 'acp',
  historySource: 'acp-journal',
  idProvisioning: 'provider-issued',
  modeControl: 'config-options',
  permissionAnswers: false,
  modelSwitch: 'config-option',
  rewind: 'unsupported',
  fork: false,
  snapshotPull: false,
  sidLivenessProbe: false,
  skillSync: true,
  externalImport: true,
  modelCatalog: 'provider-advertised',
  acpAdapter: { source: 'bundled', binary: 'codex', args: null, versionArgs: ['--version'] },
};

// The other ACP engines ride the SAME acp-worker transport as codex, so they
// share every capability axis with it; what differs is the label, how the
// adapter argv is obtained, and whether walnut can import/skill-sync them.

const GEMINI: EngineCapabilities = {
  ...CODEX,
  id: 'gemini',
  displayName: 'Gemini',
  acpAdapter: { source: 'cli', binary: 'gemini', args: ['--experimental-acp'], versionArgs: ['--version'] },
  externalImport: false,
  skillSync: true,
};

const OPENCODE: EngineCapabilities = {
  ...CODEX,
  id: 'opencode',
  displayName: 'OpenCode',
  acpAdapter: { source: 'cli', binary: 'opencode', args: ['acp'], versionArgs: ['--version'] },
  externalImport: false,
  skillSync: true,
};

const GOOSE: EngineCapabilities = {
  ...CODEX,
  id: 'goose',
  displayName: 'Goose',
  acpAdapter: { source: 'cli', binary: 'goose', args: ['acp'], versionArgs: ['--version'] },
  externalImport: false,
  skillSync: true,
};

/** User-supplied ACP adapter: argv comes from config, so there is no binary to probe. */
const CUSTOM: EngineCapabilities = {
  ...CODEX,
  id: 'custom',
  displayName: 'Custom (ACP)',
  acpAdapter: { source: 'config', binary: null, args: null, versionArgs: [] },
  externalImport: false,
  skillSync: false,
};

/**
 * One descriptor per SESSION_ENGINE_IDS entry. The Record type is the
 * completeness guard: widening the tuple without adding a descriptor here is a
 * compile error, not a runtime "unknown engine".
 */
const DESCRIPTORS: Record<SessionEngine, EngineCapabilities> = {
  claude: CLAUDE,
  codex: CODEX,
  gemini: GEMINI,
  opencode: OPENCODE,
  goose: GOOSE,
  custom: CUSTOM,
};

/** All registered engines, keyed by id. Order = SESSION_ENGINE_IDS (presentation preference). */
export const ENGINE_REGISTRY: ReadonlyMap<SessionEngine, EngineCapabilities> = new Map(
  SESSION_ENGINE_IDS.map((id) => [id, DESCRIPTORS[id]] as const),
);

/** The engine a record without an explicit `engine` field runs on. */
export const DEFAULT_ENGINE: SessionEngine = 'claude';

/**
 * Effective engine for a record/status value. Absent or unknown values mean
 * the default engine — unknown rather than throwing so a record written by a
 * NEWER build (an engine this build doesn't know) degrades to claude-shaped
 * behavior instead of crashing the session list.
 */
export function resolveEngine(engine: unknown): SessionEngine {
  return isKnownEngine(engine) ? engine : DEFAULT_ENGINE;
}

/**
 * Normalize untrusted input (route params, tool args) onto the STORAGE shape:
 * every known non-default engine stays explicit, everything else — including
 * 'claude' and unknown values — becomes undefined (the persisted default).
 * Keeps record JSON byte-identical with pre-registry behavior.
 */
export function normalizeEngine(engine: unknown): Exclude<SessionEngine, 'claude'> | undefined {
  // The return type spells out what the body guarantees: the default engine can
  // never come back, so persisted shapes (SessionRecord.engine, LaunchPrefs.engine)
  // can be typed as "explicit non-default engine or absent" without a cast.
  return isKnownEngine(engine) && engine !== DEFAULT_ENGINE
    ? engine as Exclude<SessionEngine, 'claude'>
    : undefined;
}

/** Capability record for an engine value as stored on a session record. */
export function engineCaps(engine: unknown): EngineCapabilities {
  return ENGINE_REGISTRY.get(resolveEngine(engine)) ?? CLAUDE;
}

/** True when the engine's runtime is the ACP worker family. */
export function isAcpEngine(engine: unknown): boolean {
  return engineCaps(engine).runtimeKind === 'acp';
}

/**
 * Every engine whose runtime is the ACP worker family, in registry order. The
 * dependency-free routing table in src/providers/agent-command-map.ts hardcodes
 * the same set; a consistency test compares the two.
 */
export function acpEngineIds(): SessionEngine[] {
  return [...ENGINE_REGISTRY.values()].filter((c) => c.runtimeKind === 'acp').map((c) => c.id);
}

/** Type guard for route/tool input validation ("engine must be one of ..."). */
export function isKnownEngine(value: unknown): value is SessionEngine {
  return typeof value === 'string' && ENGINE_REGISTRY.has(value as SessionEngine);
}
