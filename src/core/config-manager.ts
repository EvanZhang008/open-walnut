import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { log } from '../logging/index.js';
import { CONFIG_FILE } from '../constants.js';
import {
  VALID_PRIORITIES,
  DEFAULT_AGENT_ENGINE_PROVIDER,
  FALLBACK_AGENT_ENGINE_PROVIDER,
  VALID_AGENT_ENGINE_PROVIDERS,
  type AgentEngineProvider,
  type Config,
  type PushTokenEntry,
  type TaskPriority,
} from './types.js';
import { MODEL_CATALOG } from '../agent/providers/model-catalog.js';
import { scanSshConfig } from './ssh-config-scanner.js';

const DEFAULT_CONFIG: Config = {
  version: 1,
  user: {},
  // New tasks default to Inbox (no project) and stay local, so quick-add is
  // instant and never silently routed to an external sync target.
  // `platform: 'local'` makes the source explicit. Existing users keep whatever
  // `defaults` is already on disk (getConfig spreads parsed over DEFAULT_CONFIG),
  // so this never re-routes an established setup.
  defaults: { priority: 'none', platform: 'local' },
  provider: { type: 'claude-code' },
  // Which ENGINE answers a Personal AI chat turn. 'walnut-agent' = today's in-process
  // agent loop; 'claude-code' routes the turn into a lane-bound `claude` session.
  // NOTE: getConfig() spreads the parsed file OVER these defaults at the TOP
  // level, so a config.yaml with any `agent:` section replaces this whole object
  // — resolveAgentEngineProvider() (below) is what actually applies the default.
  agent: { provider: DEFAULT_AGENT_ENGINE_PROVIDER },
};

/**
 * The engine that answers a Personal AI chat turn, defaulted + validated.
 *
 * Read through this rather than `config.agent?.provider` directly: getConfig()
 * merges the parsed YAML over DEFAULT_CONFIG at the top level only, so any user
 * config with an `agent:` section drops the default — and an unknown string from
 * a hand-edited file must degrade to today's behavior, never to "no engine".
 */
export function resolveAgentEngineProvider(config: Config): AgentEngineProvider {
  const raw = config.agent?.provider;
  if (typeof raw === 'string' && VALID_AGENT_ENGINE_PROVIDERS.has(raw)) {
    return raw as AgentEngineProvider;
  }
  // Unset → the default engine. An unrecognized STRING → the fallback engine
  // (the frozen in-process loop) — two separate constants on purpose, so
  // flipping the default can never route a corrupt config onto the new engine.
  return raw === undefined ? DEFAULT_AGENT_ENGINE_PROVIDER : FALLBACK_AGENT_ENGINE_PROVIDER;
}

// ── One-time config migration: category removal (project-only model) ────────

/**
 * Strip the retired category fields from a parsed config object, in place.
 *
 * Field-level and idempotent (same pattern as the available_models seed):
 *   - `defaults.category`      → deleted (Inbox is now "no project")
 *   - `local.categories`       → deleted (whole `local` section goes with it)
 *   - `favorites.categories`   → deleted (`favorites.projects` already flat)
 *   - `ordering.categories` + nested `ordering.projects` map
 *                              → flat `ordering.projects: string[]`, expanded in
 *                                old category order, NOCASE-deduped
 *   - `plugins.jira.category`  → `plugins.jira.project`
 *
 * Returns true when something changed (i.e. the file needs rewriting).
 */
export function migrateConfigToProjectOnly(config: Record<string, unknown>): boolean {
  let changed = false;

  const defaults = config.defaults as Record<string, unknown> | undefined;
  if (defaults && 'category' in defaults) {
    delete defaults.category;
    changed = true;
  }

  if ('local' in config) {
    delete config.local;
    changed = true;
  }

  const favorites = config.favorites as Record<string, unknown> | undefined;
  if (favorites && 'categories' in favorites) {
    delete favorites.categories;
    changed = true;
  }

  const ordering = config.ordering as Record<string, unknown> | undefined;
  if (ordering && ('categories' in ordering || !Array.isArray(ordering.projects))) {
    const catOrder = Array.isArray(ordering.categories) ? (ordering.categories as unknown[]) : [];
    const nested = ordering.projects;
    const flat: string[] = [];
    const seen = new Set<string>();
    const push = (raw: unknown): void => {
      const name = typeof raw === 'string' ? raw.trim() : '';
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      flat.push(name);
    };
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const byCategory = nested as Record<string, unknown>;
      // Categories in their configured order first, then any leftover keys.
      const ordered = [
        ...catOrder.map((c) => (typeof c === 'string' ? c : '')),
        ...Object.keys(byCategory).filter(
          (k) => !catOrder.some((c) => typeof c === 'string' && c.toLowerCase() === k.toLowerCase()),
        ),
      ];
      for (const cat of ordered) {
        const key = Object.keys(byCategory).find((k) => k.toLowerCase() === cat.toLowerCase());
        if (!key) continue;
        const list = byCategory[key];
        if (Array.isArray(list)) for (const p of list) push(p);
      }
    } else if (Array.isArray(nested)) {
      for (const p of nested) push(p);
    }
    delete ordering.categories;
    ordering.projects = flat;
    changed = true;
  }

  // Generic across ALL plugin entries (not just jira): validateProjectSource and
  // seedProjectsFromConfig read plugins.<id>.project generically, so any plugin
  // still carrying the legacy `category` key would silently lose its name
  // reservation (observed in real configs on third-party sync plugins).
  const plugins = config.plugins as Record<string, unknown> | undefined;
  for (const entry of Object.values(plugins ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const plugin = entry as Record<string, unknown>;
    if ('category' in plugin) {
      if (plugin.project === undefined && typeof plugin.category === 'string') {
        plugin.project = plugin.category;
      }
      delete plugin.category;
      changed = true;
    }
    // The retired local plugin's `categories` reservation list has no project-only
    // equivalent (Inbox is unclaimable by design) — drop it.
    if ('categories' in plugin) {
      delete plugin.categories;
      changed = true;
    }
  }

  return changed;
}

/**
 * Sidecar copy of the last successfully written config.
 *
 * config.yaml holds settings that exist NOWHERE else — the STT engine + model
 * paths, SSH hosts, provider credentials. When the file vanished (a git-sync
 * merge carried a remote deletion of a still-tracked path, 2026-07-25) every
 * reader silently fell back to DEFAULT_CONFIG and the next writer persisted
 * that skeleton, so voice input died with "No STT engine configured" and no
 * error anywhere. The sidecar makes that loss recoverable instead of terminal.
 *
 * Gitignored + untracked by git-sync's CRITICAL_IGNORES — it must never sync.
 */
const CONFIG_BACKUP_FILE = `${CONFIG_FILE}.bak`;

/**
 * Read the raw config file, falling back to the sidecar backup when the primary
 * is missing or unreadable.
 *
 * Returns null only when BOTH are absent — a genuine first run, where defaults
 * are the correct answer. Distinguishing those two cases is the whole point: a
 * first run and a wiped config used to be indistinguishable.
 */
async function readRawConfigContent(): Promise<string | null> {
  try {
    return await fs.readFile(CONFIG_FILE, 'utf-8');
  } catch (primaryErr) {
    let backup: string;
    try {
      backup = await fs.readFile(CONFIG_BACKUP_FILE, 'utf-8');
    } catch {
      return null; // No config and no backup — first run.
    }
    if (!backup.trim()) return null;
    // Loud: losing the primary config is never normal operation.
    log.session.error('config-manager: config.yaml missing/unreadable — recovering from config.yaml.bak', {
      error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      backup: CONFIG_BACKUP_FILE,
    });
    // Put the primary back so the rest of the system (and the user's editor)
    // sees a real file again. Best-effort: recovery must not throw.
    try {
      await fs.writeFile(CONFIG_FILE, backup, 'utf-8');
    } catch { /* read-only FS or a racing writer — the in-memory value still holds */ }
    return backup;
  }
}

/** Mirror freshly written config to the sidecar. Never throws. */
async function writeConfigWithBackup(content: string): Promise<void> {
  await fs.writeFile(CONFIG_FILE, content, 'utf-8');
  try {
    await fs.writeFile(CONFIG_BACKUP_FILE, content, 'utf-8');
  } catch (err) {
    log.session.warn('config-manager: failed to update config backup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read config.yaml. Returns default config if file doesn't exist.
 * Also merges auto-discovered SSH hosts.
 */
export async function getConfig(): Promise<Config> {
  try {
    const content = await readRawConfigContent();
    if (content === null) throw new Error('no config file and no backup');
    const parsed = yaml.load(content) as Config;
    const config = { ...DEFAULT_CONFIG, ...parsed };
    // In-memory field migration so readers never see retired category fields,
    // even before seedConfigDefaults() persists the cleanup.
    migrateConfigToProjectOnly(config as unknown as Record<string, unknown>);
    // Sanitize legacy priority values to new 3-tier system
    if (config.defaults?.priority && !(VALID_PRIORITIES as readonly string[]).includes(config.defaults.priority)) {
      const p = config.defaults.priority as string;
      if (p === 'high') config.defaults.priority = 'immediate';
      else if (p === 'medium' || p === 'low') config.defaults.priority = 'backlog';
      else config.defaults.priority = 'none';
    }
    // Seed defaults from MODEL_CATALOG
    if (!config.agent?.available_models) {
      config.agent = { ...config.agent, available_models: (MODEL_CATALOG.bedrock ?? []).map(m => m.id) };
    }
    if (!config.agent?.main_model) {
      config.agent = { ...config.agent, main_model: (MODEL_CATALOG.bedrock ?? [])[0]?.id };
    }
    // Merge auto-discovered SSH hosts
    await mergeSshDiscoveredHosts(config);
    return config;
  } catch (err) {
    // Was log.debug — invisible in prod, which is precisely why a wiped
    // config.yaml went unnoticed for hours twice (2026-07-25 voice input,
    // 2026-07-26 `host "<alias>" not found`). Falling back to defaults is only correct on
    // a genuine first run; any other time it means settings that exist nowhere
    // else are gone, so say so at a level that shows up.
    const firstRun = err instanceof Error && err.message === 'no config file and no backup';
    const detail = { error: err instanceof Error ? err.message : String(err), configFile: CONFIG_FILE };
    if (firstRun) log.session.info('config-manager: no config.yaml and no backup — first run, using defaults', detail);
    else log.session.error('config-manager: config.yaml UNREADABLE and backup did not cover it — falling back to DEFAULTS. Machine-local settings (hosts/plugins/stt/provider) are missing until this is fixed.', detail);
    const defaultModels = (MODEL_CATALOG.bedrock ?? []).map(m => m.id);
    return { ...DEFAULT_CONFIG, agent: { available_models: defaultModels, main_model: defaultModels[0] } };
  }
}

/**
 * Merge auto-discovered SSH config hosts into config.hosts.
 * Rules:
 *  - Discovered hosts are added with enabled=true, discovered=true
 *  - Existing manual hosts are never touched (enabled defaults to true if unset)
 *  - A discovered host is skipped when its alias OR its hostname already exists
 *    in config — the user's entry IS that machine (e.g. user-defined 'clouddev'
 *    pointing at the same dev box); showing the raw FQDN again is just noise.
 */
async function mergeSshDiscoveredHosts(config: Config): Promise<void> {
  const discovered = await scanSshConfig();
  if (discovered.size === 0) return;

  // Initialize hosts if not present
  if (!config.hosts) {
    config.hosts = {};
  }

  // Hostnames already covered by an existing entry (manual or previously merged).
  const knownHostnames = new Set(
    Object.values(config.hosts).map((h) => h.hostname.toLowerCase()),
  );

  for (const [alias, host] of discovered) {
    // Skip if the alias OR the machine (hostname) is already configured.
    if (config.hosts[alias] || knownHostnames.has(host.hostname.toLowerCase())) {
      continue;
    }

    // Add discovered host
    config.hosts[alias] = {
      hostname: host.hostname,
      user: host.user,
      port: host.port,
      label: host.label,
      enabled: true,
      discovered: true,
    };
    knownHostnames.add(host.hostname.toLowerCase());
  }
}

// ── Write lock: serializes config read-modify-write operations ──
let writeLock: Promise<void> = Promise.resolve();

/** Reset write lock for testing. Prevents cross-test lock chain stalls. */
export function _resetWriteLockForTest(): void {
  writeLock = Promise.resolve();
}

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

/**
 * Write config object to config.yaml (full replacement).
 * Injects a comment above `available_models` so users know it's managed by us.
 *
 * WARNING: This replaces the entire file. Use `updateConfig()` for partial updates
 * to avoid accidentally dropping unmentioned sections.
 */
export async function saveConfig(config: Config): Promise<void> {
  return withWriteLock(async () => {
    let content = yaml.dump(config, { indent: 2, lineWidth: 120 });
    // Add comment above available_models (js-yaml strips comments, so we inject after dump)
    content = content.replace(
      /^(\s+)available_models:/m,
      '$1# Available models for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await writeConfigWithBackup(content);
  });
}

/**
 * Partial config update — read-merge-write.
 * Each top-level key in `partial` replaces the corresponding key in the existing config,
 * but UNMENTIONED keys are preserved. This prevents accidental data loss when callers
 * send incomplete config objects (e.g., PUT /api/config from SettingsPage).
 */
export async function updateConfig(partial: Partial<Config>): Promise<void> {
  return withWriteLock(async () => {
    // Read raw config from disk (not getConfig() which fills in defaults).
    // Uses the backup-aware reader: if the primary file was deleted underneath
    // us, merging into `{}` would persist a config with EVERY unmentioned
    // section (stt, hosts, plugins, tools) silently dropped. That is how a
    // deleted config.yaml turned into a permanently broken mic.
    let existing: Record<string, unknown> = {};
    try {
      const content = await readRawConfigContent();
      existing = content === null ? {} : ((yaml.load(content) as Record<string, unknown>) ?? {});
    } catch (err) {
      log.session.warn('config-manager: existing config unreadable, starting from empty', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Merge: each top-level key in partial replaces the existing key
    const merged = { ...existing };
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }

    let content = yaml.dump(merged, { indent: 2, lineWidth: 120 });
    content = content.replace(
      /^(\s+)available_models:/m,
      '$1# Available models for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await writeConfigWithBackup(content);
  });
}

/** Atomically patch one Plugin namespace without replacing sibling settings. */
export async function updatePluginConfig(
  pluginId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  return withWriteLock(async () => {
    let existing: Record<string, unknown> = {};
    try {
      const raw = await readRawConfigContent();
      existing = raw === null ? {} : ((yaml.load(raw) as Record<string, unknown>) ?? {});
    } catch (err) {
      log.session.warn('config-manager: Plugin config patch could not read existing config', {
        pluginId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const plugins = existing.plugins && typeof existing.plugins === 'object' && !Array.isArray(existing.plugins)
      ? { ...(existing.plugins as Record<string, Record<string, unknown>>) }
      : {};
    const current = plugins[pluginId] && typeof plugins[pluginId] === 'object'
      ? plugins[pluginId]
      : {};
    const next = { ...current, ...patch };
    plugins[pluginId] = next;
    existing.plugins = plugins;

    let content = yaml.dump(existing, { indent: 2, lineWidth: 120 });
    content = content.replace(
      /^(\s+)available_models:/m,
      '$1# Available models for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await writeConfigWithBackup(content);
    return next;
  });
}

/**
 * Atomically read-modify-write `push_tokens` under the config write lock.
 *
 * `updateConfig` only locks the WRITE, so a caller that reads the array with
 * `getConfig()`, edits it, and passes the whole array back races every other
 * push writer: two phones registering at once, or a foreground lease renewal
 * landing beside a preference change, and one of them is silently lost. There
 * are four such writers (register, unregister, preferences, active), so the
 * read has to happen inside the same lock as the write.
 *
 * `mutate` receives the current rows and returns the next ones, or null to make
 * the whole thing a no-op (no write, no backup churn).
 */
export async function updatePushTokens(
  mutate: (tokens: PushTokenEntry[]) => PushTokenEntry[] | null,
): Promise<PushTokenEntry[]> {
  return withWriteLock(async () => {
    let existing: Record<string, unknown> = {};
    try {
      const raw = await readRawConfigContent();
      existing = raw === null ? {} : ((yaml.load(raw) as Record<string, unknown>) ?? {});
    } catch (err) {
      log.session.warn('config-manager: push token patch could not read existing config', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const current = Array.isArray(existing.push_tokens)
      ? (existing.push_tokens as PushTokenEntry[])
      : [];
    const next = mutate(current);
    if (next === null) return current;
    existing.push_tokens = next;

    let content = yaml.dump(existing, { indent: 2, lineWidth: 120 });
    content = content.replace(
      /^(\s+)available_models:/m,
      '$1# Available models for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await writeConfigWithBackup(content);
    return next;
  });
}

/**
 * One-time migration: strip the retired category fields from config.yaml on disk.
 *
 * Full-file rewrite (not `updateConfig`, which can only replace top-level keys —
 * it has no way to DELETE `local:`). Runs before the available_models seed at
 * startup; idempotent, so a second run is a cheap parse + no write.
 */
export async function migrateConfigFileToProjectOnly(): Promise<boolean> {
  return withWriteLock(async () => {
    let parsed: Record<string, unknown>;
    try {
      const content = await readRawConfigContent();
      if (content === null) return false; // first run — DEFAULT_CONFIG is already clean
      parsed = (yaml.load(content) as Record<string, unknown>) ?? {};
    } catch (err) {
      log.session.warn('config-manager: skipping project-only migration, config unreadable', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    if (!migrateConfigToProjectOnly(parsed)) return false;

    let content = yaml.dump(parsed, { indent: 2, lineWidth: 120 });
    content = content.replace(
      /^(\s+)available_models:/m,
      '$1# Available models for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await writeConfigWithBackup(content);
    log.session.info('config-manager: migrated config.yaml to the project-only model');
    return true;
  });
}

/**
 * One-time migration: seed `agent.available_models` into config.yaml if missing.
 * Called at startup from init.ts.
 */
export async function seedConfigDefaults(): Promise<void> {
  await migrateConfigFileToProjectOnly();
  const config = await getConfig();
  let needsWrite = false;

  // Read raw file to check if available_models is actually on disk (vs filled in by getConfig)
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    if (!raw.includes('available_models')) {
      needsWrite = true;
    }
  } catch (err) {
    log.session.debug('config-manager: no config file found, will write defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
    needsWrite = true;
  }

  if (needsWrite) {
    // Use updateConfig to preserve existing keys (like stt) that may already be on disk
    await updateConfig({
      agent: config.agent,
      version: config.version,
      user: config.user,
      defaults: config.defaults,
      provider: config.provider,
    });
  }
}
