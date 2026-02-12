/**
 * Integration Plugin Loader
 *
 * Discovers and loads plugins from:
 * 1. Built-in dir: src/integrations/ (dev) or dist/integrations/ (prod)
 * 2. External dir: ~/.walnut/plugins/
 *
 * For each plugin subdirectory:
 *   - Read manifest.json → validate required fields
 *   - Read config.yaml plugins.{id} → check enabled flag
 *   - Validate config against manifest's configSchema (basic type checking)
 *   - Dynamic import index.ts/index.js → create PluginApi → call default export
 *   - Validate registerSync was called → register into registry
 *
 * The 'local' plugin is always registered and cannot be disabled.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { WALNUT_HOME, TASKS_FILE, CONFIG_FILE } from '../constants.js';
import { createSubsystemLogger } from '../logging/index.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { getConfig } from './config-manager.js';
import type { TaskStore } from './types.js';
import type { IntegrationRegistry } from './integration-registry.js';
import type {
  PluginManifest,
  PluginApi,
  IntegrationSync,
  CategoryClaimFn,
  DisplayMeta,
  MigrateFn,
  HttpRoute,
  RegisteredPlugin,
} from './integration-types.js';

const log = createSubsystemLogger('plugin-loader');

// ── Built-in integrations dir resolution ──
// Same walk-up pattern used by BUILTIN_COMMANDS_DIR in constants.ts.
// In dev (tsx): import.meta.url → src/core/integration-loader.ts → walk up to find src/integrations/
// In prod (tsup bundle): import.meta.url → dist/... → walk up to find dist/integrations/ or src/integrations/

function resolveBuiltinDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    // Check both direct child and dist/ child (handles prod bundles)
    for (const candidate of [
      path.join(dir, 'integrations'),
      path.join(dir, 'dist', 'integrations'),
    ]) {
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch { /* keep walking */ }
    }
    dir = path.dirname(dir);
  }
  // Fallback: sibling of this file's parent (src/core/ → src/integrations/)
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'integrations');
}

const BUILTIN_DIR = resolveBuiltinDir();
const EXTERNAL_DIR = path.join(WALNUT_HOME, 'plugins');

// ── Basic JSON Schema validation (type-only, no ajv needed) ──

function validateConfigValue(value: unknown, schema: Record<string, unknown>, fieldPath: string): string[] {
  const errors: string[] = [];
  const schemaType = schema.type as string | undefined;

  if (schemaType) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (schemaType === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`${fieldPath}: expected integer, got ${typeof value}`);
      }
    } else if (actualType !== schemaType) {
      errors.push(`${fieldPath}: expected ${schemaType}, got ${actualType}`);
    }
  }

  // Validate object properties
  if (schemaType === 'object' && typeof value === 'object' && value !== null) {
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = schema.required as string[] | undefined;

    if (required) {
      for (const key of required) {
        if (!(key in (value as Record<string, unknown>))) {
          errors.push(`${fieldPath}.${key}: required field missing`);
        }
      }
    }

    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        const propValue = (value as Record<string, unknown>)[key];
        if (propValue !== undefined) {
          errors.push(...validateConfigValue(propValue, propSchema, `${fieldPath}.${key}`));
        }
      }
    }
  }

  // Validate array items
  if (schemaType === 'array' && Array.isArray(value)) {
    const itemSchema = schema.items as Record<string, unknown> | undefined;
    if (itemSchema) {
      for (let i = 0; i < value.length; i++) {
        errors.push(...validateConfigValue(value[i], itemSchema, `${fieldPath}[${i}]`));
      }
    }
  }

  // Enum validation
  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues && !enumValues.includes(value)) {
    errors.push(`${fieldPath}: value must be one of [${enumValues.join(', ')}]`);
  }

  return errors;
}

// ── PluginApi builder: creates a mutable PluginApi that collects registrations ──

interface PluginApiBuilder {
  api: PluginApi;
  collected: {
    sync: IntegrationSync | null;
    claim: { fn: CategoryClaimFn; priority: number } | null;
    display: DisplayMeta | null;
    agentContext: string | null;
    migrations: MigrateFn[];
    httpRoutes: HttpRoute[];
  };
}

function createPluginApiBuilder(manifest: PluginManifest, pluginConfig: Record<string, unknown>): PluginApiBuilder {
  const pluginLogger = createSubsystemLogger(`plugin/${manifest.id}`);

  const collected: PluginApiBuilder['collected'] = {
    sync: null,
    claim: null,
    display: null,
    agentContext: null,
    migrations: [],
    httpRoutes: [],
  };

  const api: PluginApi = {
    id: manifest.id,
    name: manifest.name,
    config: pluginConfig,
    logger: pluginLogger,

    registerSync(sync: IntegrationSync) {
      if (collected.sync) {
        throw new Error(`Plugin "${manifest.id}" called registerSync() more than once.`);
      }
      collected.sync = sync;
    },

    registerSourceClaim(fn: CategoryClaimFn, opts?: { priority?: number }) {
      collected.claim = { fn, priority: opts?.priority ?? 0 };
    },

    registerDisplay(meta: DisplayMeta) {
      collected.display = meta;
    },

    registerAgentContext(snippet: string) {
      collected.agentContext = snippet;
    },

    registerMigration(fn: MigrateFn) {
      collected.migrations.push(fn);
    },

    registerHttpRoute(route: HttpRoute) {
      collected.httpRoutes.push(route);
    },
  };

  return { api, collected };
}

// ── Plugin directory scanner ──

async function discoverPluginDirs(): Promise<Array<{ dir: string; isBuiltin: boolean }>> {
  const results: Array<{ dir: string; isBuiltin: boolean }> = [];

  // Scan built-in dir
  try {
    const entries = await fsp.readdir(BUILTIN_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = path.join(BUILTIN_DIR, entry.name, 'manifest.json');
        try {
          await fsp.access(manifestPath, fs.constants.R_OK);
          results.push({ dir: path.join(BUILTIN_DIR, entry.name), isBuiltin: true });
        } catch {
          // Not a plugin directory (no manifest.json)
        }
      }
    }
  } catch {
    log.debug('Built-in integrations dir not found', { dir: BUILTIN_DIR });
  }

  // Scan external dir
  try {
    const entries = await fsp.readdir(EXTERNAL_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = path.join(EXTERNAL_DIR, entry.name, 'manifest.json');
        try {
          await fsp.access(manifestPath, fs.constants.R_OK);
          results.push({ dir: path.join(EXTERNAL_DIR, entry.name), isBuiltin: false });
        } catch {
          // Not a plugin directory (no manifest.json)
        }
      }
    }
  } catch {
    // External plugins dir doesn't exist — that's fine
  }

  return results;
}

// ── Manifest validation ──

function validateManifest(raw: unknown, filePath: string): PluginManifest | null {
  if (!raw || typeof raw !== 'object') {
    log.warn('Invalid manifest: not an object', { filePath });
    return null;
  }

  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !obj.id) {
    log.warn('Invalid manifest: missing or empty "id"', { filePath });
    return null;
  }
  if (typeof obj.name !== 'string' || !obj.name) {
    log.warn('Invalid manifest: missing or empty "name"', { filePath });
    return null;
  }

  return {
    id: obj.id,
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    version: typeof obj.version === 'string' ? obj.version : undefined,
    configSchema: obj.configSchema && typeof obj.configSchema === 'object'
      ? obj.configSchema as Record<string, unknown>
      : undefined,
    uiHints: obj.uiHints && typeof obj.uiHints === 'object'
      ? obj.uiHints as Record<string, { label?: string; help?: string }>
      : undefined,
  };
}

// ── Single plugin loader ──

async function loadPlugin(
  pluginDir: string,
  isBuiltin: boolean,
  pluginConfigs: Record<string, Record<string, unknown> & { enabled?: boolean }>,
  registry: IntegrationRegistry,
): Promise<void> {
  const manifestPath = path.join(pluginDir, 'manifest.json');

  // Read and validate manifest
  let manifestRaw: unknown;
  try {
    const content = await fsp.readFile(manifestPath, 'utf-8');
    manifestRaw = JSON.parse(content);
  } catch (err) {
    log.warn('Failed to read manifest.json', { dir: pluginDir, error: String(err) });
    return;
  }

  const manifest = validateManifest(manifestRaw, manifestPath);
  if (!manifest) return;

  const pluginId = manifest.id;
  const isLocal = pluginId === 'local';

  // Skip if already registered (built-in takes precedence over external with same id)
  if (registry.has(pluginId)) {
    log.debug('Skipping duplicate plugin', { id: pluginId, dir: pluginDir });
    return;
  }

  // Check enabled flag from config (local plugin cannot be disabled)
  const configEntry = pluginConfigs[pluginId] ?? {};
  if (!isLocal && configEntry.enabled === false) {
    log.debug('Plugin disabled in config', { id: pluginId });
    return;
  }

  // Validate config against configSchema
  const { enabled: _enabled, ...pluginConfig } = configEntry;
  if (manifest.configSchema && Object.keys(pluginConfig).length > 0) {
    const errors = validateConfigValue(pluginConfig, manifest.configSchema, `plugins.${pluginId}`);
    if (errors.length > 0) {
      log.warn('Plugin config validation errors', { id: pluginId, errors });
      // Continue anyway — log warning but don't block plugin load
    }
  }

  // Dynamic import — try index.ts first (dev), then index.js, then index.mjs
  let registerFn: ((api: PluginApi) => void | Promise<void>) | null = null;
  const candidates = ['index.ts', 'index.js', 'index.mjs'];

  for (const filename of candidates) {
    const entryPath = path.join(pluginDir, filename);
    try {
      await fsp.access(entryPath, fs.constants.R_OK);
      const moduleUrl = pathToFileURL(entryPath).href;
      const mod = await import(moduleUrl);
      registerFn = mod.default;
      break;
    } catch {
      // Try next candidate
    }
  }

  if (!registerFn || typeof registerFn !== 'function') {
    log.warn('No valid entry point found', { id: pluginId, dir: pluginDir, tried: candidates });
    return;
  }

  // Create PluginApi and call the register function
  const builder = createPluginApiBuilder(manifest, pluginConfig);

  try {
    await registerFn(builder.api);
  } catch (err) {
    log.error('Plugin registration threw an error', { id: pluginId, error: String(err) });
    return;
  }

  // Validate: registerSync must have been called
  if (!builder.collected.sync) {
    log.error('Plugin did not call registerSync()', { id: pluginId });
    return;
  }

  // Build RegisteredPlugin and register
  const registered: RegisteredPlugin = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    config: pluginConfig,
    sync: builder.collected.sync,
    claim: builder.collected.claim ?? undefined,
    display: builder.collected.display ?? undefined,
    agentContext: builder.collected.agentContext ?? undefined,
    migrations: builder.collected.migrations,
    httpRoutes: builder.collected.httpRoutes,
  };

  registry.register(pluginId, registered);
  log.info('Plugin loaded', {
    id: pluginId,
    name: manifest.name,
    version: manifest.version ?? 'n/a',
    builtin: isBuiltin,
    hasClaim: !!registered.claim,
    hasDisplay: !!registered.display,
    migrations: registered.migrations.length,
    httpRoutes: registered.httpRoutes.length,
  });
}

// ── Main entry: load all plugins ──

export async function loadPlugins(registry: IntegrationRegistry): Promise<void> {
  log.info('Loading plugins', { builtinDir: BUILTIN_DIR, externalDir: EXTERNAL_DIR });

  // Read plugin configs from config.yaml
  const config = await getConfig();
  const pluginConfigs = config.plugins ?? {};

  // Discover plugin directories
  const pluginDirs = await discoverPluginDirs();
  log.debug('Discovered plugin dirs', { count: pluginDirs.length, dirs: pluginDirs.map(d => d.dir) });

  // Load built-in plugins first (they take precedence), then external
  const builtins = pluginDirs.filter(d => d.isBuiltin);
  const externals = pluginDirs.filter(d => !d.isBuiltin);

  // Load local plugin first (must always be present)
  const localIdx = builtins.findIndex(d => path.basename(d.dir) === 'local');
  if (localIdx >= 0) {
    const [localDir] = builtins.splice(localIdx, 1);
    await loadPlugin(localDir.dir, true, pluginConfigs, registry);
  } else {
    log.error('Local plugin not found in built-in integrations directory', { dir: BUILTIN_DIR });
  }

  // Load remaining built-ins
  for (const { dir } of builtins) {
    await loadPlugin(dir, true, pluginConfigs, registry);
  }

  // Load external plugins
  for (const { dir } of externals) {
    await loadPlugin(dir, false, pluginConfigs, registry);
  }

  const loaded = registry.getAll();
  log.info('Plugin loading complete', {
    total: loaded.length,
    ids: loaded.map(p => p.id),
  });
}

// ── Config migration: move top-level legacy integration keys to plugins.* ──

// Known non-plugin top-level config keys — everything else is treated as a legacy plugin key.
const KNOWN_NON_PLUGIN_KEYS = new Set([
  'version', 'user', 'defaults', 'provider', 'agent', 'local',
  'favorites', 'ordering', 'session_server', 'hosts', 'session_limits',
  'heartbeat', 'tools', 'search', 'git_versioning', 'session_hooks', 'plugins',
]);

/**
 * One-time migration: move legacy top-level integration config keys
 * into the new plugins.{id} section.
 * Scans all unknown top-level object keys (anything not in KNOWN_NON_PLUGIN_KEYS)
 * and moves them to plugins.*. Converts underscores to hyphens for the plugin ID.
 * Reads raw config.yaml, checks for legacy keys, moves them, writes back.
 * Safe to call multiple times — no-ops if already migrated.
 */
export async function migrateConfigToPlugins(): Promise<boolean> {
  let raw: Record<string, unknown>;
  try {
    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    raw = (yaml.load(content) as Record<string, unknown>) ?? {};
  } catch {
    return false; // No config file — nothing to migrate
  }

  let changed = false;
  const plugins = (raw.plugins ?? {}) as Record<string, Record<string, unknown>>;

  for (const [key, val] of Object.entries(raw)) {
    if (KNOWN_NON_PLUGIN_KEYS.has(key)) continue;
    if (typeof val === 'object' && val !== null) {
      const pluginId = key.replace(/_/g, '-'); // ms_todo → ms-todo
      if (!plugins[pluginId]) {
        plugins[pluginId] = { enabled: true, ...(val as Record<string, unknown>) };
        log.info(`config migration: moved ${key} → plugins.${pluginId}`);
        changed = true;
      }
      delete raw[key];
      changed = true;
    }
  }

  if (changed) {
    raw.plugins = plugins;
    let content = yaml.dump(raw, { indent: 2, lineWidth: 120 });
    // Preserve the available_models comment (same as config-manager.ts)
    content = content.replace(
      /^(\s+)available_models:/m,
      '$1# Predefined Bedrock model IDs for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await fsp.writeFile(CONFIG_FILE, content, 'utf-8');
    log.info('config migration complete: legacy integration keys moved to plugins section');
  }

  return changed;
}

// ── Plugin task data migrations ──

/**
 * Run all registered plugin migrations against the task store.
 * Called once after plugins are loaded. Each plugin's MigrateFn receives
 * the full task array and returns the (possibly mutated) array.
 * Writes back to disk only if any migration modified the data.
 */
export async function runPluginMigrations(registry: IntegrationRegistry): Promise<void> {
  const plugins = registry.getAll();
  const migrationsToRun = plugins.flatMap(p =>
    p.migrations.map(fn => ({ pluginId: p.id, fn }))
  );

  if (migrationsToRun.length === 0) {
    log.debug('No plugin migrations to run');
    return;
  }

  // Read the task store directly (bypass task-manager to avoid circular deps)
  const EMPTY_STORE: TaskStore = { version: 1, tasks: [] };
  const store = await readJsonFile<TaskStore>(TASKS_FILE, { ...EMPTY_STORE, tasks: [] });
  const originalJson = JSON.stringify(store.tasks);

  // Run each plugin's migrations in order
  let tasks = store.tasks;
  for (const { pluginId, fn } of migrationsToRun) {
    try {
      tasks = await fn(tasks);
    } catch (err) {
      log.error('Plugin migration failed', {
        pluginId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue with other migrations — don't block on one failure
    }
  }

  // Write back only if data changed
  store.tasks = tasks;
  const newJson = JSON.stringify(store.tasks);
  if (newJson !== originalJson) {
    await writeJsonFile(TASKS_FILE, store);
    // Count tasks with ext data for debugging
    const extCounts: Record<string, number> = {};
    for (const t of tasks) {
      if (t.ext) {
        for (const key of Object.keys(t.ext)) {
          extCounts[key] = (extCounts[key] ?? 0) + 1;
        }
      }
    }
    log.info('Plugin migrations applied and saved', {
      plugins: migrationsToRun.map(m => m.pluginId),
      totalTasks: tasks.length,
      extCounts,
    });
  } else {
    log.debug('Plugin migrations ran but no changes detected');
  }
}
