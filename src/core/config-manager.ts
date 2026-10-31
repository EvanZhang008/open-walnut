import { log } from '../logging/index.js';
import { CLOUD_MODE, CONFIG_FILE } from '../constants.js';
import {
  VALID_PRIORITIES,
  type Config,
  type PushTokenEntry,
  type TaskPriority,
} from './types.js';
import { MODEL_CATALOG } from '../model/providers/model-catalog.js';
import { KNOWN_PROVIDERS } from '../model/providers/defaults.js';
import { scanSshConfig } from './ssh-config-scanner.js';
import { realSshReachAllowed } from '../lib/real-ssh-guard.js';
import { injectCloudBoxHost, withoutCloudBoxHost } from './hosts/cloud-box-host.js';
import { isHostReplicaProgram } from './server-role.js';
import { COMPANION_ALIAS, migrateLegacyCompanionKeep } from './replication/companion-keep.js';
import {
  dumpConfig,
  modifyConfigDoc,
  readConfigDoc,
  refreshConfigBackup,
  withWriteLock,
  writeConfigWithBackup,
} from './config-store.js';
export {
  ConfigBusyError,
  ConfigUnreadableError,
  _configRepairIdleForTest,
  _resetWriteLockForTest,
  _setBeforeConfigCommitForTest,
  _setConfigTimingsForTest,
  announceConfigWritten,
  configContentHash,
  isOwnConfigWrite,
  onConfigWritten,
  refreshConfigBackup,
  writeFileAtomic,
} from './config-store.js';

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
  // getConfig() spreads the parsed file OVER these defaults at the TOP level, so
  // anything put in this object is dropped by any config.yaml that has an `agent:`
  // section at all. Per-key defaults belong at their reader.
  agent: {},
};

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
 * config.yaml as stored (after the sidecar fallback), or null when it cannot be
 * read and parsed: missing with no backup, empty, or not a YAML mapping. For a
 * caller that must decide NOTHING on a broken file: getConfig never throws and
 * answers DEFAULT_CONFIG then, which reads as "no API keys, no rows". Unmerged
 * (no discovered hosts, no cloud box).
 */
export async function readStoredConfig(): Promise<Partial<Config> | null> {
  if (isHostReplicaProgram()) return (await import('./replication/kinds/config.js')).readConfigCopy() as Promise<Partial<Config> | null>;
  try {
    const read = await readConfigDoc();
    if (read.source === 'primary') return read.doc as Partial<Config>;
    // The backup stands in for a file that is gone or empty. A file that does not
    // parse holds the user's newest text, which the backup may not: decide nothing.
    if (read.source === 'backup' && (read.state === 'missing' || read.state === 'empty')) return read.doc as Partial<Config>;
    return null;
  } catch {
    return null;
  }
}

/**
 * getConfig() on a host replica (docs/plan/walnut-replica-servers-impl.md WP5): the
 * Mac's config as the copy holds it (allowlisted keys only, replication/config-allowlist.ts)
 * over the defaults, the defaults alone before the first round. No ssh hosts merged,
 * no cloud box row: a replica reaches no host of its own. `favorites` is not in
 * the config copy (the allowlist drops it): it is the prefs copy's
 * (replication/kinds/prefs.ts), so every favorites read through getConfig() (the
 * project list, the phone's GET /api/v1/favorites, the notes routes) gets the
 * Mac's favorites, and none when that copy is not here.
 */
async function replicaConfig(): Promise<Config> {
  const [copy, favorites] = await Promise.all([
    import('./replication/kinds/config.js').then((m) => m.readConfigCopy()),
    import('./replication/kinds/prefs.js').then((m) => m.readFavoritesCopy()),
  ]);
  const { favorites: _never, ...copied } = (copy ?? {}) as Record<string, unknown>;
  return normalizeReadConfig({ ...DEFAULT_CONFIG, ...copied, ...(favorites ? { favorites } : {}) } as Config);
}

/**
 * What every read of a stored config gets in memory (the Mac's config.yaml, or a
 * host replica's copy of it, which holds what the yaml holds): retired fields
 * migrated, a legacy priority mapped to the 3-tier values, the model defaults
 * seeded. One function, so the two servers read the same config the same way.
 */
export function normalizeReadConfig(config: Config): Config {
  // In-memory field migration so readers never see retired category fields,
  // even before seedConfigDefaults() persists the cleanup.
  migrateConfigToProjectOnly(config as unknown as Record<string, unknown>);
  // The companion's keep choice where an older build kept it: read from cloud_bridge.
  migrateLegacyCompanionKeep(config as unknown as Record<string, unknown>);
  // Sanitize legacy priority values to new 3-tier system
  if (config.defaults?.priority && !(VALID_PRIORITIES as readonly string[]).includes(config.defaults.priority)) {
    const p = config.defaults.priority as string;
    config.defaults = { ...config.defaults };
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
  return config;
}

/** Configs getConfig made up because config.yaml could not be read. */
const fallbackConfigs = new WeakSet<object>();

/**
 * True for the defaults getConfig answers with when config.yaml could not be
 * read (or the backup it answers with while config.yaml does not parse): its
 * `hosts` says nothing sure about which hosts exist, so a caller that acts on a
 * host being gone must not act on it.
 */
export function isFallbackConfig(config: object): boolean {
  return fallbackConfigs.has(config);
}

/**
 * Read config.yaml. Returns default config if file doesn't exist.
 * Also merges auto-discovered SSH hosts.
 */
export async function getConfig(): Promise<Config> {
  if (isHostReplicaProgram()) return replicaConfig();
  try {
    const read = await readConfigDoc();
    if (read.source === 'none') throw new Error('no config file and no backup');
    if (read.source === 'broken') throw new Error(`config.yaml is ${read.state}${read.error ? `: ${read.error}` : ''}`);
    const parsed = read.doc as unknown as Config;
    const config = normalizeReadConfig({ ...DEFAULT_CONFIG, ...parsed });
    // Merge auto-discovered SSH hosts
    await mergeSshDiscoveredHosts(config);
    // The paired cloud box, reached over the daemon tunnel (in memory only:
    // saveConfig / updateConfig strip it again, see withoutCloudBoxHost).
    injectCloudBoxHost(config, CLOUD_MODE);
    // A backup answering for a file that does not parse runs the system on the
    // last good settings, but says nothing about what the user's newest text
    // holds: a caller that acts on something being absent must not act on it.
    if (read.source === 'backup' && read.state !== 'missing' && read.state !== 'empty') fallbackConfigs.add(config);
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
    // Spread DEFAULT_CONFIG.agent — do NOT replace the object, so a key added to
    // the defaults keeps surviving this path. Dropping one here reads to the user
    // as an unrelated outage: on 2026-08-28 06:03 a lost `agent:` section sent one
    // turn at credentials this box does not keep, and the phone reported "Could
    // not load credentials from any providers".
    const fallback: Config = {
      ...DEFAULT_CONFIG,
      agent: { ...DEFAULT_CONFIG.agent, available_models: defaultModels, main_model: defaultModels[0] },
    };
    fallbackConfigs.add(fallback);
    return fallback;
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
  // A server under test reads no real ~/.ssh/config: its hosts would be swept
  // over real ssh at startup (src/lib/real-ssh-guard.ts).
  if (!realSshReachAllowed()) return;
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
    // Skip if the alias OR the machine (hostname) is already configured. `companion`
    // names the cloud companion (replication/companion-keep.ts): no host takes it.
    if (alias === COMPANION_ALIAS || config.hosts[alias] || knownHostnames.has(host.hostname.toLowerCase())) {
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


/**
 * Write config object to config.yaml (full replacement).
 * Injects a comment above `available_models` so users know it's managed by us.
 *
 * WARNING: This replaces the entire file. Use `updateConfig()` for partial updates
 * to avoid accidentally dropping unmentioned sections.
 */
export async function saveConfig(config: Config): Promise<void> {
  return withWriteLock(async () => {
    // A caller that read config through getConfig() holds the injected cloud
    // box row; it is never persisted.
    const hosts = withoutCloudBoxHost(config.hosts);
    const toWrite = (hosts === config.hosts ? { ...config } : { ...config, hosts }) as Config;
    migrateLegacyCompanionKeep(toWrite as unknown as Record<string, unknown>);
    await writeConfigWithBackup(dumpConfig(toWrite as unknown as Record<string, unknown>));
  });
}

/**
 * Partial config update — read-merge-write.
 * Each top-level key in `partial` replaces the corresponding key in the existing config,
 * but UNMENTIONED keys are preserved. This prevents accidental data loss when callers
 * send incomplete config objects (e.g., PUT /api/config from SettingsPage).
 *
 * The base is config.yaml as it stands after any save in flight lands (modifyConfigDoc):
 * merging into `{}` or into an older backup used to persist a config with every
 * unmentioned section (stt, hosts, plugins, tools) dropped, or roll back an edit the
 * user had just saved. A file that does not parse is refused, never replaced.
 */
export async function updateConfig(partial: Partial<Config>): Promise<void> {
  return modifyConfigDoc((existing) => {
    // The companion's keep choice where an older build kept it moves to cloud_bridge
    // first, so a partial that replaces `hosts` or `cloud_bridge` never drops it.
    migrateLegacyCompanionKeep(existing);
    // Merge: each top-level key in partial replaces the existing key
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        existing[key] = value;
      }
    }
    migrateLegacyCompanionKeep(existing);
    // A whole `hosts` map sent back from a getConfig() read carries the
    // injected cloud box row; it must never reach config.yaml.
    if (existing.hosts && typeof existing.hosts === 'object') {
      existing.hosts = withoutCloudBoxHost(existing.hosts as Record<string, unknown>);
    }
    return { write: true, result: undefined };
  });
}

/** Atomically patch one Plugin namespace without replacing sibling settings. */
export async function updatePluginConfig(
  pluginId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  return modifyConfigDoc((existing) => {
    const plugins = existing.plugins && typeof existing.plugins === 'object' && !Array.isArray(existing.plugins)
      ? { ...(existing.plugins as Record<string, Record<string, unknown>>) }
      : {};
    const current = plugins[pluginId] && typeof plugins[pluginId] === 'object'
      ? plugins[pluginId]
      : {};
    const next = { ...current, ...patch };
    plugins[pluginId] = next;
    existing.plugins = plugins;
    return { write: true, result: next };
  });
}

/**
 * Where one plugin's jobs run (`plugin_jobs.<id>.run_on`, src/core/plugin-jobs/):
 * a host key, or `''` for this computer (the entry is then removed).
 */
export async function setPluginJobsRunOn(pluginId: string, runOn: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  await modifyConfigDoc((existing) => {
    const all = existing.plugin_jobs && typeof existing.plugin_jobs === 'object' && !Array.isArray(existing.plugin_jobs)
      ? { ...(existing.plugin_jobs as Record<string, Record<string, unknown>>) }
      : {};
    if (!runOn || runOn === '__local__') delete all[pluginId];
    else all[pluginId] = { ...(all[pluginId] ?? {}), run_on: runOn };
    if (Object.keys(all).length > 0) existing.plugin_jobs = all;
    else delete existing.plugin_jobs;
    return { write: true, result: undefined };
  });
}

/**
 * Atomically patch one host's `server` section (`hosts.<key>.server`, the server
 * this Mac keeps on that host: core/host-server/). Each patched key replaces
 * its value; `expose` is replaced whole. Throws for a host config.yaml does not
 * name. Returns the section as written.
 */
export async function updateHostServerConfig(
  hostKey: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return modifyConfigDoc((existing) => {
    const hosts = existing.hosts && typeof existing.hosts === 'object' && !Array.isArray(existing.hosts)
      ? { ...(existing.hosts as Record<string, Record<string, unknown>>) }
      : {};
    const host = hosts[hostKey];
    if (!host || typeof host !== 'object') throw new Error(`No host named ${hostKey} in config.yaml`);
    const current = host.server && typeof host.server === 'object' ? host.server as Record<string, unknown> : {};
    const next: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) delete next[k];
      else next[k] = v;
    }
    hosts[hostKey] = { ...host, server: next };
    existing.hosts = hosts;
    return { write: true, result: next };
  });
}

/**
 * Atomically delete one Plugin namespace (`plugins.<id>`), settings and all. A no-op, with
 * no write, when the key is not there. Returns whether a key was removed.
 *
 * What "remove" means for a plugin that ships in the bundled store: without the key its
 * folder is not installed, so discovery skips it again on every later boot.
 */
export async function removePluginConfig(pluginId: string): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  return modifyConfigDoc((existing) => {
    const plugins = existing.plugins && typeof existing.plugins === 'object' && !Array.isArray(existing.plugins)
      ? { ...(existing.plugins as Record<string, unknown>) }
      : null;
    if (!plugins || !(pluginId in plugins)) return { write: false, result: false };
    delete plugins[pluginId];
    existing.plugins = plugins;
    return { write: true, result: true };
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
 * the whole thing a no-op (no write, no backup churn). It runs again when
 * config.yaml changed between the read and the write (modifyConfigDoc), so a
 * count it keeps starts from zero inside it.
 */
export async function updatePushTokens(
  mutate: (tokens: PushTokenEntry[]) => PushTokenEntry[] | null,
): Promise<PushTokenEntry[]> {
  return modifyConfigDoc((existing) => {
    const current = Array.isArray(existing.push_tokens)
      ? (existing.push_tokens as PushTokenEntry[])
      : [];
    const next = mutate(current);
    if (next === null) return { write: false, result: current };
    existing.push_tokens = next;
    return { write: true, result: next };
  });
}

/**
 * Read-modify-write the whole stored mapping, for a migration that must delete or
 * move keys (updateConfig only replaces top-level keys). `mutate` edits the mapping
 * in place and returns whether it changed anything; nothing is written otherwise.
 */
export async function migrateStoredConfig(mutate: (doc: Record<string, unknown>) => Promise<boolean> | boolean): Promise<boolean> {
  return modifyConfigDoc(async (doc) => {
    const changed = await mutate(doc);
    return { write: changed, result: changed };
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
  // A replica migrates nothing: its config is the Mac's copy, already migrated there.
  if (isHostReplicaProgram()) return false;
  try {
    return await migrateStoredConfig((parsed) => {
      const projectOnly = migrateConfigToProjectOnly(parsed);
      const companionKeep = migrateLegacyCompanionKeep(parsed);
      if (projectOnly || companionKeep) log.session.info('config-manager: migrated config.yaml', { projectOnly, companionKeep });
      return projectOnly || companionKeep;
    });
  } catch (err) {
    log.session.warn('config-manager: skipping project-only migration, config unreadable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Does the seed below belong in this stored config? Only when Walnut's own calls run
 * on a Claude provider: none named (the default is Claude Code, else Bedrock), or one
 * whose protocol serves the Claude catalog. Exported for the ratchet.
 */
export function seedsClaudeDefaults(doc: Record<string, unknown>): boolean {
  const agent = doc.agent as { main_provider?: unknown } | undefined;
  const name = typeof agent?.main_provider === 'string' ? agent.main_provider.trim() : '';
  if (!name) return true;
  const providers = doc.providers as Record<string, { api?: unknown }> | undefined;
  const api = providers?.[name]?.api ?? KNOWN_PROVIDERS[name]?.api;
  return CLAUDE_CATALOG_PROTOCOLS.has(String(api));
}

/** Protocols whose models are the Claude catalog the seed lists. */
export const CLAUDE_CATALOG_PROTOCOLS: ReadonlySet<string> = new Set(['bedrock', 'anthropic-messages', 'claude-cli']);

/**
 * One-time migration: seed `agent.available_models` into config.yaml if missing.
 * Called at startup from init.ts.
 */
export async function seedConfigDefaults(): Promise<void> {
  if (isHostReplicaProgram()) return;
  await migrateConfigFileToProjectOnly();
  try {
    await modifyConfigDoc((existing) => {
      // available_models must be ON DISK (getConfig fills it in memory either way).
      const agent = existing.agent as { available_models?: unknown } | undefined;
      if (agent && typeof agent === 'object' && agent.available_models !== undefined) return { write: false, result: undefined };
      // The seed is the Claude default set (a Claude model list, `provider: claude-code`).
      // A file that picked another main provider (Ollama, OpenAI, a local server) keeps
      // only what its user wrote (2026-10-30: a Path D config grew 13 Claude ids).
      if (!seedsClaudeDefaults(existing)) return { write: false, result: undefined };
      // Seeded from the stored file itself, inside the lock, so a save that landed
      // after boot began is what gets the defaults, not an older read of it.
      const config = normalizeReadConfig({ ...DEFAULT_CONFIG, ...structuredClone(existing) } as Config);
      const seeded = { agent: config.agent, version: config.version, user: config.user, defaults: config.defaults, provider: config.provider };
      for (const [key, value] of Object.entries(seeded)) if (value !== undefined) existing[key] = value;
      return { write: true, result: undefined };
    });
  } catch (err) {
    // A config.yaml that does not parse stays as the user left it; boot goes on
    // with what getConfig answers (the backup, else the defaults).
    log.session.error('config-manager: could not seed config defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // An edit made while Walnut was not running reaches the sidecar too.
  await refreshConfigBackup().catch(() => false);
}
