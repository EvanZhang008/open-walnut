/**
 * Engine catalog — the browser's copy of "which coding agents exist, what can
 * they do, and are they installed on this machine".
 *
 * Server truth is the engine registry + availability probe behind
 * GET /api/engines. This module mirrors it the same way useModelCatalog mirrors
 * host model catalogs: a module-level store (shared by every component), seeded
 * from localStorage for an instant first paint, hydrated from the endpoint on
 * first subscribe and re-pulled after a TTL.
 *
 * Why a store and not a per-component fetch: the launcher renders the engine
 * toggle inside three different surfaces, and every one of them must agree on
 * what will actually launch. One store means one answer.
 *
 * A cold browser starts from DEFAULT_ENGINE_CATALOG (claude + codex, both
 * installed), which is exactly what the UI hardcoded before this existed — so
 * nothing about the first paint changes, and an old server without /api/engines
 * simply keeps that default forever.
 */
import { useSyncExternalStore } from 'react';
import { apiGet } from '@/api/client';
import { log } from '@/utils/log';
import {
  DEFAULT_ENGINE_CATALOG,
  isSessionEngine,
  type EngineCatalog,
  type EngineCatalogEntry,
} from '@/utils/engines';

// The catalog SHAPE lives in utils/engines (pure, importable from api/ and
// components/); re-exported here so a consumer of the store needs one import.
export type {
  EngineCatalog,
  EngineCatalogEntry,
  EngineAvailability,
  EngineCatalogCapabilities,
} from '@/utils/engines';

const STORAGE_KEY = 'walnut.engineCatalog.v1';
/** Installed-ness can change under us (a CLI gets installed, config edited), but
 *  not often — one pull per minute per tab is plenty. */
const HYDRATE_TTL_MS = 60_000;
/** How long to wait before the one re-pull that answers a PENDING catalog. */
const PENDING_REPULL_MS = 3_000;

/**
 * Availability reasons that mean "ask again", not "not installed". The probe
 * carries its own deadline and answers 'still checking availability' when a
 * slow `--version` outruns it (engine-probe); the route answers 'availability
 * check unavailable' when the probe itself threw. Both become `installed:false`
 * on the wire, which is indistinguishable from a real missing binary — so a
 * catalog carrying either must never be cached (TTL) or persisted, or one slow
 * probe locks the engine toggle for a minute and then for every later page load.
 */
const PENDING_AVAILABILITY_REASONS: ReadonlySet<string> = new Set([
  'still checking availability',
  'availability check unavailable',
]);

let catalog: EngineCatalog = loadFromStorage() ?? DEFAULT_ENGINE_CATALOG;
const listeners = new Set<() => void>();
let lastHydrateAt = 0;
let hydrating: Promise<void> | null = null;
/** One outstanding pending re-pull, cleared only by a settled answer — so a
 *  catalog that stays pending never grows a timer chain. */
let pendingRepull: ReturnType<typeof setTimeout> | null = null;
let pendingRepullScheduled = false;

/** True when a single row's availability is still being determined. */
function isPendingRow(e: EngineCatalogEntry): boolean {
  return e.availability.reason !== null && PENDING_AVAILABILITY_REASONS.has(e.availability.reason);
}

/** True when any row's availability is still being determined. */
function isPendingCatalog(rows: EngineCatalog): boolean {
  return rows.some(isPendingRow);
}

/**
 * Apply a freshly-parsed catalog, but never let a row whose availability is
 * still PENDING overwrite a row we already know is installed. A pending row
 * means "ask again"; downgrading a known-good engine to a disabled toggle for
 * the re-pull window is worse than holding the last settled answer. Rows we
 * have no prior installed answer for still take the pending row (we genuinely
 * don't know yet). Capabilities are static, so keeping the known row whole is
 * safe.
 */
function mergePending(next: EngineCatalog, prev: EngineCatalog): EngineCatalog {
  const prevById = new Map(prev.map((e) => [e.id, e]));
  return next.map((row) => {
    if (!isPendingRow(row)) return row;
    const known = prevById.get(row.id);
    return known && known.availability.installed ? known : row;
  });
}

/** Accept only rows this build can act on: a known engine id and the two
 *  capability/availability objects. A malformed row is dropped rather than
 *  poisoning a lock reason or an idProvisioning decision. */
function parseEntry(value: unknown): EngineCatalogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!isSessionEngine(row.id)) return null;
  const caps = row.capabilities as Record<string, unknown> | undefined;
  const avail = row.availability as Record<string, unknown> | undefined;
  if (!caps || typeof caps !== 'object' || !avail || typeof avail !== 'object') return null;
  return {
    id: row.id,
    displayName: typeof row.displayName === 'string' && row.displayName ? row.displayName : row.id,
    runtimeKind: row.runtimeKind === 'acp' ? 'acp' : 'native',
    isDefault: row.isDefault === true,
    localOnly: row.localOnly === true,
    capabilities: {
      rewind: caps.rewind === true,
      fork: caps.fork === true,
      modelCatalog: caps.modelCatalog === 'provider-advertised' ? 'provider-advertised' : 'static',
      modeControl: caps.modeControl === 'config-options' ? 'config-options' : 'claude-modes',
      idProvisioning: caps.idProvisioning === 'provider-issued' ? 'provider-issued' : 'preassigned',
    },
    availability: {
      installed: avail.installed === true,
      version: typeof avail.version === 'string' ? avail.version : null,
      reason: typeof avail.reason === 'string' ? avail.reason : null,
    },
  };
}

function parseCatalog(value: unknown): EngineCatalog | null {
  if (!Array.isArray(value)) return null;
  const rows = value.map(parseEntry).filter((e): e is EngineCatalogEntry => e !== null);
  // An empty/entirely-invalid answer must NOT wipe the toggle — keep what we have.
  return rows.length ? rows : null;
}

function loadFromStorage(): EngineCatalog | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const stored = raw ? parseCatalog(JSON.parse(raw)) : null;
    // Self-heal a pending catalog written by an older build: seeding first paint
    // from it would show a usable engine as unavailable until hydration lands.
    return stored && isPendingCatalog(stored) ? null : stored;
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(catalog));
  } catch { /* quota / private mode — the store stays in-memory */ }
}

function notify(): void {
  for (const l of listeners) l();
}

/** `persistIt=false` applies the rows in memory only (a PENDING answer is
 *  correct for this paint but must not seed the next page load). */
function replace(next: EngineCatalog, persistIt = true): void {
  // Value-compare before publishing: this hydrates on every subscribe, and the
  // answer is the same on all but the rare change — a new array identity would
  // re-render every engine toggle on the page for nothing.
  if (JSON.stringify(next) === JSON.stringify(catalog)) return;
  catalog = next;
  if (persistIt) persist();
  notify();
}

/** ONE bounded re-pull for a pending answer. Not a retry loop: a still-pending
 *  re-pull leaves no timer behind, and the un-stamped TTL means the next
 *  subscribe pulls again anyway. */
function schedulePendingRepull(): void {
  if (pendingRepullScheduled) return;
  pendingRepullScheduled = true;
  pendingRepull = setTimeout(() => {
    pendingRepull = null;
    void hydrate();
  }, PENDING_REPULL_MS);
}

async function hydrate(): Promise<void> {
  if (Date.now() - lastHydrateAt < HYDRATE_TTL_MS) return;
  if (!hydrating) {
    hydrating = apiGet<{ engines: unknown }>('/api/engines')
      .then((res) => {
        const parsed = parseCatalog(res?.engines);
        // Merge BEFORE deciding pending: a pending row backed by a known-good
        // prior answer resolves here, so it neither locks the toggle nor keeps
        // us re-pulling.
        const applied = parsed ? mergePending(parsed, catalog) : null;
        const pending = applied !== null && isPendingCatalog(applied);
        // A pending answer is NOT a hydration: leaving lastHydrateAt alone is
        // what lets the next subscribe (and the scheduled re-pull) ask again.
        if (!pending) {
          lastHydrateAt = Date.now();
          pendingRepullScheduled = false;
        }
        if (applied) replace(applied, !pending);
        if (pending) schedulePendingRepull();
      })
      .catch((err) => {
        // Old server / offline: the compiled-in default is a correct answer for
        // the engines that shipped with this build, so this is not user-facing.
        lastHydrateAt = Date.now();
        log.warn('engine-catalog', 'engine catalog hydrate failed', { error: String(err) });
      })
      .finally(() => { hydrating = null; });
  }
  return hydrating;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  void hydrate();
  return () => { listeners.delete(cb); };
}

/** Reactive read — re-renders when the catalog hydrates or changes. Registry
 *  order, so a caller can map it straight onto buttons. */
export function useEngineCatalog(): EngineCatalogEntry[] {
  return useSyncExternalStore(subscribe, () => catalog);
}

/** Imperative read for non-hook call sites (launch payload assembly, api layer). */
export function getEngineCatalog(): EngineCatalogEntry[] {
  return catalog;
}

/** Force the next read to re-pull (e.g. after a config change that can add a
 *  custom adapter). Fire-and-forget. */
export function refreshEngineCatalog(): void {
  lastHydrateAt = 0;
  void hydrate();
}

/** Test hook — back to the compiled-in default, nothing hydrated. */
export function _resetEngineCatalogStore(): void {
  catalog = DEFAULT_ENGINE_CATALOG;
  lastHydrateAt = 0;
  hydrating = null;
  if (pendingRepull) clearTimeout(pendingRepull);
  pendingRepull = null;
  pendingRepullScheduled = false;
  notify();
}
