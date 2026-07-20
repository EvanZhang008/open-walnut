/**
 * Host-level last-known model catalog store.
 *
 * The CLI's model menu is a pure function of (host machine, settings.json):
 * every CLI spawned on the same host with the same settings produces an
 * identical `models[]`. That makes the catalog a HOST property, not a session
 * property — so the last catalog ANY session fetched on a host is exactly what
 * a NEW session on that host will see.
 *
 * Consumers (all "no live CLI to ask" surfaces):
 *   - Quick-session model dropdown (session doesn't exist yet)
 *   - ModelPicker on a dead/unreachable session
 * Writers: every successful ClaudeCodeSession.getModelCatalog() round-trip.
 *
 * Keyed per-host (NOT per-cwd): model config (availableModels/modelOverrides)
 * lives in user-level ~/.claude/settings.json in practice. Project-level
 * .claude/settings.json CAN theoretically carry model keys, so the `cwd` the
 * catalog came from is recorded for a future (host, cwd) upgrade — and any
 * per-folder drift self-corrects seconds after a real session spawns there
 * (its live catalog overwrites the preview).
 *
 * Local host key: '__local__' (same normalization as session records).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { HOST_MODEL_CATALOG_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import type { SessionModelCatalogEntry } from './types.js';

export const LOCAL_HOST_KEY = '__local__';

export interface HostModelCatalog {
  /** Catalog rows exactly as the CLI returned them (post-allowlist, post-overrides). */
  models: SessionModelCatalogEntry[];
  /** cwd of the session that fetched this catalog (recorded for a future per-folder upgrade). */
  cwd?: string;
  /** ISO timestamp of the fetch. */
  fetchedAt: string;
  /** Epoch ms the ANSWERING CLI process spawned. Freshness gate: long-lived
   *  CLI processes run OLD binaries whose model registry lacks newer families
   *  — their (degraded) answer must never clobber a catalog from a newer
   *  process, because a NEW session spawns the current binary and sees the
   *  newer process's view. Fetch wall-time can't express this (an old process
   *  can answer later); spawn time can. */
  sourceSpawnTs?: number;
}

type StoreShape = Record<string, HostModelCatalog>;

/** Normalize a session record's host field to a store key. */
export function hostCatalogKey(host?: string | null): string {
  return host && host.trim() ? host : LOCAL_HOST_KEY;
}

// In-memory mirror; loaded lazily, written through on every update.
let cache: StoreShape | null = null;
let loadPromise: Promise<StoreShape> | null = null;
// Serialize writes so concurrent session fetches can't interleave partial files.
let writeChain: Promise<void> = Promise.resolve();

async function load(): Promise<StoreShape> {
  if (cache) return cache;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fsp.readFile(HOST_MODEL_CATALOG_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as StoreShape;
        cache = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        cache = {}; // missing/corrupt file → start fresh (it's a cache, not source of truth)
      }
      return cache;
    })();
  }
  return loadPromise;
}

function persist(): void {
  const snapshot = JSON.stringify(cache, null, 2);
  writeChain = writeChain.then(async () => {
    try {
      await fsp.mkdir(path.dirname(HOST_MODEL_CATALOG_FILE), { recursive: true });
      // Same-dir temp file + rename = atomic on the same filesystem (EXDEV rule).
      const tmp = `${HOST_MODEL_CATALOG_FILE}.tmp`;
      await fsp.writeFile(tmp, snapshot, 'utf-8');
      await fsp.rename(tmp, HOST_MODEL_CATALOG_FILE);
    } catch (err) {
      log.session.warn('host model catalog persist failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/** Record a freshly-fetched catalog for a host. Fire-and-forget safe.
 *  Freshness gate: an answer from an OLDER CLI process (by spawn time) never
 *  overwrites one from a newer process — long-lived CLIs run old binaries/
 *  settings snapshots and would clobber the catalog new sessions actually see.
 *  Returns whether the write was accepted, so callers can gate their own
 *  client push on the same decision. */
export async function saveHostModelCatalog(
  host: string | null | undefined,
  models: SessionModelCatalogEntry[],
  cwd?: string,
  sourceSpawnTs?: number,
): Promise<boolean> {
  if (!models.length) return false;
  const store = await load();
  const key = hostCatalogKey(host);
  const prev = store[key];
  // Freshness matrix (unknown spawn time = ATTACHED process = long-lived old
  // CLI whose registry can lack newer model families; live-verified: attached
  // CLI answered 3 raw-ID rows where a fresh spawn answers 6 proper rows):
  //   known ≥ stored-known → accept · known vs stored-unknown → accept
  //   unknown vs stored-unknown → accept (last writer wins — no basis to rank)
  //   unknown vs stored-known → REJECT · known < stored-known → REJECT
  if (prev?.sourceSpawnTs && (!sourceSpawnTs || sourceSpawnTs < prev.sourceSpawnTs)) {
    log.session.info('host catalog write skipped — answering CLI not newer than stored source', {
      host: key, sourceSpawnTs: sourceSpawnTs ?? null, storedSpawnTs: prev.sourceSpawnTs,
    });
    return false;
  }
  store[key] = {
    models,
    ...(cwd ? { cwd } : {}),
    fetchedAt: new Date().toISOString(),
    ...(sourceSpawnTs ? { sourceSpawnTs } : {}),
  };
  persist();
  return true;
}

/** Last-known catalog for a host, or null if this host never answered list_models. */
export async function getHostModelCatalog(host?: string | null): Promise<HostModelCatalog | null> {
  const store = await load();
  return store[hostCatalogKey(host)] ?? null;
}

/** All stored host catalogs (for the hosts route / pickers that show every host). */
export async function listHostModelCatalogs(): Promise<Record<string, HostModelCatalog>> {
  const store = await load();
  return { ...store };
}

/** Test hook: drop in-memory state so a fresh file is re-read. */
export function _resetHostModelCatalogCache(): void {
  cache = null;
  loadPromise = null;
}
