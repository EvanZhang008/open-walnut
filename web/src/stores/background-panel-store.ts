/**
 * Background tasks panel store — who opened the panel, for which session, and
 * what the chat knows about the agents it lists.
 *
 * The panel's open state cannot live in the chip that opened it: a chip is a
 * transient component. The streaming chip for a spawn burst unmounts the moment
 * history absorbs the Agent tool_call and a history chip takes its place, so a
 * panel owned by the chip would close under the reader at every turn end. Here
 * the panel is owned by one always-mounted host per session panel
 * (`BackgroundTasksPanelHost`), and every chip only says "open on this agent".
 *
 * Chips also register the agents they know (title, prompt, live lane, preloaded
 * transcript) so the panel can list agents the ledger never saw (a session whose
 * CLI process is gone) and read a running agent straight from the stream. The
 * registration key is the burst's first toolUseId, which the streaming chip and
 * its history successor share, so the hand-over is seamless.
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import type { KnownAgent } from '@/components/sessions/BackgroundTasksPanel';
import { EMPTY_TOOL_SOURCE, type ToolSource } from '@/stream/command-view';

interface OpenState {
  sessionId: string;
  /** Row to select on open: a ledger taskId, a toolUseId, or an agentId. */
  initialKey?: string;
  /** Bumps on every open so re-opening on another agent re-selects. */
  nonce: number;
}

let open: OpenState | null = null;
let nonce = 0;
const openListeners = new Set<() => void>();

const knownBySession = new Map<string, Map<string, KnownAgent[]>>();
const knownFlat = new Map<string, KnownAgent[]>();
const knownListeners = new Map<string, Set<() => void>>();

function notifyOpen(): void { for (const l of openListeners) l(); }
function notifyKnown(sessionId: string): void {
  const set = knownListeners.get(sessionId);
  if (set) for (const l of set) l();
}

export function openBackgroundPanel(sessionId: string, initialKey?: string): void {
  open = { sessionId, initialKey, nonce: ++nonce };
  notifyOpen();
}

export function closeBackgroundPanel(): void {
  if (!open) return;
  open = null;
  notifyOpen();
}

/** The open request for THIS session's host, or null. */
export function useBackgroundPanelOpen(sessionId: string | undefined): OpenState | null {
  return useSyncExternalStore(
    (l) => { openListeners.add(l); return () => { openListeners.delete(l); }; },
    () => (open && sessionId && open.sessionId === sessionId ? open : null),
  );
}

function rebuildFlat(sessionId: string): void {
  const groups = knownBySession.get(sessionId);
  const flat: KnownAgent[] = [];
  if (groups) for (const agents of groups.values()) flat.push(...agents);
  knownFlat.set(sessionId, flat);
}

/** A chip publishes what it knows about its burst; called on every render of the
 *  chip (the live lane closure must be fresh), keyed by the burst's first agent. */
export function registerKnownAgents(sessionId: string, chipKey: string, agents: KnownAgent[]): void {
  let groups = knownBySession.get(sessionId);
  if (!groups) { groups = new Map(); knownBySession.set(sessionId, groups); }
  if (groups.get(chipKey) === agents) return;
  groups.set(chipKey, agents);
  rebuildFlat(sessionId);
  notifyKnown(sessionId);
}

export function unregisterKnownAgents(sessionId: string, chipKey: string): void {
  const groups = knownBySession.get(sessionId);
  if (!groups?.delete(chipKey)) return;
  if (groups.size === 0) knownBySession.delete(sessionId);
  rebuildFlat(sessionId);
  notifyKnown(sessionId);
}

const NO_AGENTS: KnownAgent[] = [];

/** Plain read (what the hook snapshots). */
export function getKnownAgents(sessionId: string | undefined): KnownAgent[] {
  if (!sessionId) return NO_AGENTS;
  return knownFlat.get(sessionId) ?? NO_AGENTS;
}

export function useKnownAgents(sessionId: string | undefined): KnownAgent[] {
  return useSyncExternalStore(
    (l) => {
      if (!sessionId) return () => {};
      let set = knownListeners.get(sessionId);
      if (!set) { set = new Set(); knownListeners.set(sessionId, set); }
      set.add(l);
      return () => { set!.delete(l); if (set!.size === 0) knownListeners.delete(sessionId); };
    },
    () => getKnownAgents(sessionId),
  );
}

// ── Live lanes: a running agent's transcript straight from the stream buffer ──

export type LaneRenderer = () => ReactNode;
const EMPTY_LANES: ReadonlyMap<string, LaneRenderer> = new Map();
const lanesBySession = new Map<string, ReadonlyMap<string, LaneRenderer>>();
const laneListeners = new Map<string, Set<() => void>>();

/** The chat publishes, per render, a renderer for every lane the stream holds
 *  whose agent is still running, keyed by the root Agent toolUseId. */
export function setLiveLanes(sessionId: string, lanes: ReadonlyMap<string, LaneRenderer>): void {
  const prev = lanesBySession.get(sessionId);
  if (lanes.size === 0 && (!prev || prev.size === 0)) return;
  lanesBySession.set(sessionId, lanes);
  const set = laneListeners.get(sessionId);
  if (set) for (const l of set) l();
}

export function getLiveLanes(sessionId: string | undefined): ReadonlyMap<string, LaneRenderer> {
  if (!sessionId) return EMPTY_LANES;
  return lanesBySession.get(sessionId) ?? EMPTY_LANES;
}

export function useLiveLanes(sessionId: string | undefined): ReadonlyMap<string, LaneRenderer> {
  return useSyncExternalStore(
    (l) => {
      if (!sessionId) return () => {};
      let set = laneListeners.get(sessionId);
      if (!set) { set = new Set(); laneListeners.set(sessionId, set); }
      set.add(l);
      return () => { set!.delete(l); if (set!.size === 0) laneListeners.delete(sessionId); };
    },
    () => getLiveLanes(sessionId),
  );
}

// ── Tool source: where the panel reads a shell command's input and output ──────
// The chat publishes its current stream buffer and history rows (references, not
// copies) so a Command row can find the Bash tool call the ledger points at and
// the TaskOutput reads of it (stream/command-view.ts). Published from the same
// effect as the lanes; a publish that changes neither reference is a no-op.

const sourceBySession = new Map<string, ToolSource>();
const sourceListeners = new Map<string, Set<() => void>>();

export function setToolSource(sessionId: string, source: ToolSource): void {
  const prev = sourceBySession.get(sessionId);
  if (prev && prev.blocks === source.blocks && prev.messages === source.messages) return;
  if (!prev && source.blocks.length === 0 && source.messages.length === 0) return;
  sourceBySession.set(sessionId, source);
  const set = sourceListeners.get(sessionId);
  if (set) for (const l of set) l();
}

export function getToolSource(sessionId: string | undefined): ToolSource {
  if (!sessionId) return EMPTY_TOOL_SOURCE;
  return sourceBySession.get(sessionId) ?? EMPTY_TOOL_SOURCE;
}

export function useToolSource(sessionId: string | undefined): ToolSource {
  return useSyncExternalStore(
    (l) => {
      if (!sessionId) return () => {};
      let set = sourceListeners.get(sessionId);
      if (!set) { set = new Set(); sourceListeners.set(sessionId, set); }
      set.add(l);
      return () => { set!.delete(l); if (set!.size === 0) sourceListeners.delete(sessionId); };
    },
    () => getToolSource(sessionId),
  );
}
