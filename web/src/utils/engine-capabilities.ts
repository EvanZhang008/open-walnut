/**
 * Flat capability view of an engine, for the LIVE session surfaces.
 *
 * Every "can this session rewind / fork / cycle a Claude permission mode /
 * discover its models from the provider" question is answered from the
 * GET /api/engines catalog row, never from a comparison against a vendor id.
 * utils/engines owns the catalog shape, the row lookup and its fallbacks; this
 * module is the one-line-per-question projection those panels read, so a
 * component never walks `entry.capabilities.modeControl === 'config-options'`
 * in JSX and no two panels can disagree about what a capability means.
 *
 * Fallback semantics come from engineEntry: a registered engine the catalog
 * hasn't described yet reads as an ACP engine (no rewind, no fork,
 * provider-advertised models, provider config options for modes), while a
 * string this build doesn't know at all degrades to the default engine.
 */
import {
  engineEntry,
  engineLockReason,
  type EngineCatalog,
  type EngineCatalogEntry,
} from '@/utils/engines';
import type { SessionEngine } from '@/types/session';

/** One engine's capabilities as the session surfaces consume them. */
export interface EngineUiCaps {
  /** Effective engine id for the record value (the default engine when absent). */
  id: SessionEngine;
  /** Label for pills, tooltips and transcript attribution. */
  displayName: string;
  /** True for the default engine. */
  isDefault: boolean;
  /** ACP worker family: models come from the provider, modes are config options. */
  isAcp: boolean;
  /** Turn rewind (fork-based checkpointing) is available. */
  rewind: boolean;
  /** Session fork is available. */
  fork: boolean;
  /** Model list is discovered from the live provider session, not a static catalog. */
  providerModelCatalog: boolean;
  /** Permission modes are provider config options, not the Claude mode set. */
  configModes: boolean;
  /** The engine's CLI/adapter is present on this machine. */
  installed: boolean;
  /** Why the engine is unusable, when it is; null when usable. */
  unavailableReason: string | null;
}

/**
 * Product label for a session surface. A native engine is "<name> Code" (the
 * console has always attributed transcript bubbles to "Claude Code", while the
 * server-side registry shortens the same engine to "Claude" for error prose) —
 * the same derivation utils/engines uses for the engine-toggle tooltip.
 */
export function engineLabel(entry: EngineCatalogEntry): string {
  return entry.runtimeKind === 'native' ? `${entry.displayName} Code` : entry.displayName;
}

/** Capability view for a record's `engine` value, from a catalog snapshot. */
export function engineCaps(engine: unknown, catalog: EngineCatalog): EngineUiCaps {
  const entry = engineEntry(catalog, engine);
  return {
    id: entry.id,
    displayName: engineLabel(entry),
    isDefault: entry.isDefault,
    isAcp: entry.runtimeKind === 'acp',
    rewind: entry.capabilities.rewind,
    fork: entry.capabilities.fork,
    providerModelCatalog: entry.capabilities.modelCatalog === 'provider-advertised',
    configModes: entry.capabilities.modeControl === 'config-options',
    installed: entry.availability.installed,
    // Host-independent half of the lock rule: availability only. The local-only
    // half needs a host, which only the launch surfaces have.
    unavailableReason: engineLockReason(entry, undefined),
  };
}
