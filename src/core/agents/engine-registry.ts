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
 * src/core/ or src/web/ outside this directory.
 *
 * Storage contract (unchanged by P0): session records persist `engine:
 * 'codex'` explicitly and leave the default engine as `undefined`, which
 * means claude. `normalizeEngine` preserves exactly that shape;
 * `resolveEngine` gives the effective engine for capability lookup.
 */

import type { SessionEngine } from '../types.js';

/** How the engine's runtime is reached (which provider class / daemon command family). */
export type EngineRuntimeKind = 'native' | 'acp';

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
};

/** All registered engines, keyed by id. Order = presentation preference. */
export const ENGINE_REGISTRY: ReadonlyMap<SessionEngine, EngineCapabilities> = new Map([
  ['claude', CLAUDE],
  ['codex', CODEX],
]);

/** The engine a record without an explicit `engine` field runs on. */
export const DEFAULT_ENGINE: SessionEngine = 'claude';

/**
 * Effective engine for a record/status value. Absent or unknown values mean
 * the default engine — unknown rather than throwing so a record written by a
 * NEWER build (an engine this build doesn't know) degrades to claude-shaped
 * behavior instead of crashing the session list.
 */
export function resolveEngine(engine: unknown): SessionEngine {
  return engine === 'codex' ? 'codex' : DEFAULT_ENGINE;
}

/**
 * Normalize untrusted input (route params, tool args) onto the STORAGE shape:
 * 'codex' stays explicit, everything else — including 'claude' — becomes
 * undefined (the persisted default). Keeps record JSON byte-identical with
 * pre-registry behavior.
 */
export function normalizeEngine(engine: unknown): SessionEngine | undefined {
  return engine === 'codex' ? 'codex' : undefined;
}

/** Capability record for an engine value as stored on a session record. */
export function engineCaps(engine: unknown): EngineCapabilities {
  return ENGINE_REGISTRY.get(resolveEngine(engine)) ?? CLAUDE;
}

/** True when the engine's runtime is the ACP worker family. */
export function isAcpEngine(engine: unknown): boolean {
  return engineCaps(engine).runtimeKind === 'acp';
}

/** Type guard for route/tool input validation ("engine must be one of ..."). */
export function isKnownEngine(value: unknown): value is SessionEngine {
  return typeof value === 'string' && ENGINE_REGISTRY.has(value as SessionEngine);
}
