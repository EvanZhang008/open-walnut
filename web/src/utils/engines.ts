/**
 * Engine helpers — the browser's answer to "which coding agent will this launch
 * run on, and what can it do".
 *
 * The server's engine registry (src/core/agents/engine-registry.ts) is NOT
 * importable here (it pulls config/fs), so the capability answers arrive as DATA
 * over GET /api/engines and live in the module store next door
 * (hooks/useEngineCatalog.ts). This file is the pure half: the catalog SHAPE, a
 * compiled-in default, and every derivation a component needs. No React, no
 * network, no localStorage — so it is safe to import from api/, hooks/ and
 * components/ alike.
 *
 * Two rules the rest of the UI depends on:
 *   · Storage shape is unchanged — the default engine persists as `undefined`,
 *     every other engine explicitly (`normalizeEngine`).
 *   · The compiled-in default catalog holds exactly the engines this build knew
 *     about before hydration (claude + codex), so a cold page paints the same
 *     toggle it always did instead of flashing a longer row.
 */
import { SESSION_ENGINE_IDS, type SessionEngine } from '@/types/session';

/** The engine a record/launch with no explicit `engine` runs on. */
export const DEFAULT_ENGINE: SessionEngine = 'claude';

/** Engine as it may be PERSISTED on a launch/task meta: the default engine is
 *  never written out, so a set value always means a non-default engine. */
export type LaunchEngine = Exclude<SessionEngine, 'claude'>;

/** A directory's remembered launch config (working-dirs `lastLaunch`, draft
 *  launch memory). Absent engine = the default engine. */
export interface LaunchMemory {
  model?: string;
  engine?: LaunchEngine;
}

/** Capability axes GET /api/engines projects from the server-side registry. */
export interface EngineCatalogCapabilities {
  rewind: boolean;
  fork: boolean;
  modelCatalog: 'static' | 'provider-advertised';
  modeControl: 'claude-modes' | 'config-options';
  idProvisioning: 'preassigned' | 'provider-issued';
}

export interface EngineAvailability {
  installed: boolean;
  version: string | null;
  /** Why it is unusable (not installed / not configured). null when installed. */
  reason: string | null;
}

export interface EngineCatalogEntry {
  id: SessionEngine;
  displayName: string;
  runtimeKind: 'native' | 'acp';
  isDefault: boolean;
  /** Sessions on this engine can only spawn on the local machine (every ACP
   *  engine today — the worker is not deployed to remote daemons). */
  localOnly: boolean;
  capabilities: EngineCatalogCapabilities;
  availability: EngineAvailability;
}

/** The catalog as every consumer sees it: a plain array in registry order.
 *  NOT `readonly` — components annotate their own `EngineCatalogEntry[]` locals,
 *  and nothing mutates the store's array (the store REPLACES it). */
export type EngineCatalog = EngineCatalogEntry[];

const ACP_CAPABILITIES: EngineCatalogCapabilities = {
  rewind: false,
  fork: false,
  modelCatalog: 'provider-advertised',
  modeControl: 'config-options',
  idProvisioning: 'provider-issued',
};

/**
 * What this build knows without asking the server. Deliberately just the two
 * engines that shipped before the catalog existed, with `installed: true`, so
 * the first paint of the engine toggle is byte-for-byte today's two buttons —
 * hydration only ever ADDS rows or marks one unavailable.
 */
export const DEFAULT_ENGINE_CATALOG: EngineCatalog = [
  {
    id: 'claude',
    displayName: 'Claude',
    runtimeKind: 'native',
    isDefault: true,
    localOnly: false,
    capabilities: {
      rewind: true,
      fork: true,
      modelCatalog: 'static',
      modeControl: 'claude-modes',
      idProvisioning: 'preassigned',
    },
    availability: { installed: true, version: null, reason: null },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    runtimeKind: 'acp',
    isDefault: false,
    localOnly: true,
    capabilities: ACP_CAPABILITIES,
    availability: { installed: true, version: null, reason: null },
  },
];

const KNOWN_ENGINE_IDS: ReadonlySet<string> = new Set(SESSION_ENGINE_IDS);

export function isSessionEngine(value: unknown): value is SessionEngine {
  return typeof value === 'string' && KNOWN_ENGINE_IDS.has(value);
}

/** Effective engine of a stored/requested value. Unknown or absent → default,
 *  never a throw: a record written by a newer build must degrade, not crash. */
export function resolveEngine(value: unknown): SessionEngine {
  return isSessionEngine(value) ? value : DEFAULT_ENGINE;
}

/** Onto the STORAGE shape: known non-default engines stay explicit, everything
 *  else (including the default and unknown values) becomes undefined. */
export function normalizeEngine(value: unknown): LaunchEngine | undefined {
  return isSessionEngine(value) && value !== DEFAULT_ENGINE
    ? (value as LaunchEngine)
    : undefined;
}

/**
 * The catalog row for an engine. An engine the catalog does not carry (stale
 * hydration, a record from a newer build) falls back to the compiled-in default
 * row, then to a CONSERVATIVE synthetic row: unknown non-default engines are
 * treated as uninstalled ACP engines, so nothing mints a preassigned session id
 * or offers a pre-launch model list for a runtime we can't describe.
 */
export function engineEntry(catalog: EngineCatalog, engine: unknown): EngineCatalogEntry {
  const id = resolveEngine(engine);
  return catalog.find((e) => e.id === id)
    ?? DEFAULT_ENGINE_CATALOG.find((e) => e.id === id)
    ?? {
      id,
      displayName: id.charAt(0).toUpperCase() + id.slice(1),
      runtimeKind: 'acp',
      isDefault: false,
      localOnly: true,
      capabilities: ACP_CAPABILITIES,
      availability: { installed: false, version: null, reason: `${id} is not available on this server` },
    };
}

export function engineDisplayName(catalog: EngineCatalog, engine: unknown): string {
  return engineEntry(catalog, engine).displayName;
}

/** Tooltip for an engine button. Same two strings the hand-written Claude/Codex
 *  toggle used, derived from the runtime kind. */
export function engineTitle(entry: EngineCatalogEntry): string {
  return entry.runtimeKind === 'acp'
    ? `${entry.displayName} (via ACP)`
    : `${entry.displayName} Code (native)`;
}

/** True for a host value that is not this machine. */
export function isRemoteHost(host?: string | null): boolean {
  return !!host && host !== '__local__';
}

/**
 * THE local-only rule, one definition.
 *
 * A local-only engine picked on a remote host tab does not launch there: the
 * quick-start drops the flag and the session comes up on the default engine. Every
 * surface that shows "what will actually launch" (the toggle's active button, the
 * draft's model pill, MainPage's launch payload) must agree, so they all call this
 * instead of re-deriving `engine === '<vendor>' && !remoteHost`.
 */
export function resolveEngineForHost(
  engine: unknown,
  host: string | null | undefined,
  catalog: EngineCatalog,
): SessionEngine {
  const resolved = resolveEngine(engine);
  if (resolved === DEFAULT_ENGINE) return resolved;
  return engineEntry(catalog, resolved).localOnly && isRemoteHost(host)
    ? DEFAULT_ENGINE
    : resolved;
}

/** `resolveEngineForHost` in the wire/storage shape (undefined = default). */
export function launchEngineForHost(
  engine: unknown,
  host: string | null | undefined,
  catalog: EngineCatalog,
): LaunchEngine | undefined {
  return normalizeEngine(resolveEngineForHost(engine, host, catalog));
}

/**
 * Why this engine can't be picked right now, or null when it can. Availability
 * first (a missing binary is the more actionable answer), then the local-only
 * lock on a remote host tab.
 */
export function engineLockReason(
  entry: EngineCatalogEntry,
  host: string | null | undefined,
): string | null {
  if (!entry.availability.installed) {
    return entry.availability.reason ?? `${entry.displayName} is not installed`;
  }
  if (entry.localOnly && isRemoteHost(host)) {
    return `${entry.displayName} sessions are local-only for now`;
  }
  return null;
}
