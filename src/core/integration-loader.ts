/**
 * Integration Plugin Loader
 *
 * Discovers and loads plugins from:
 * 1. Built-in dir: src/integrations/ (dev) or dist/integrations/ (prod)
 * 2. External dir: ~/.open-walnut/plugins/
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { WALNUT_HOME, CONFIG_FILE } from '../constants.js';
import { createSubsystemLogger } from '../logging/index.js';
import { getConfig } from './config-manager.js';
import { bulkMigrateTasks } from './task-manager.js';
import { ensureExtIndexes } from './task-db.js';
import { setExtIndexes } from './ext-index-registry.js';
import type { IntegrationRegistry } from './integration-registry.js';
import type {
  PluginManifest,
  PluginApi,
  IntegrationSync,
  ProjectClaimFn,
  DisplayMeta,
  MigrateFn,
  HttpRoute,
  RegisteredPlugin,
  ExtIndexSpec,
  UnconfiguredPlugin,
  TaskFieldSpec,
} from './integration-types.js';

const log = createSubsystemLogger('plugin-loader');

// ── On-the-fly bundling for external .ts plugins ──
// External plugins ship as .ts source with relative imports that reference the
// open-walnut src/ tree (e.g. '../../core/config-manager.js'). These paths only
// resolve correctly when the plugin is inside src/integrations/. At runtime,
// plugins live in ~/.open-walnut/plugins/ so the paths break. We use esbuild to
// bundle the plugin on-the-fly, rebasing parent imports to the real src/ tree.
async function bundleExternalPlugin(
  pluginDir: string,
  entryFile: string,
): Promise<string | null> {
  try {
    const { build } = await import('esbuild');
    const pluginName = path.basename(pluginDir);

    // BUILTIN_DIR is always {root}/dist/integrations or {root}/src/integrations
    const projectRoot = path.dirname(path.dirname(BUILTIN_DIR));

    // CRITICAL: write the bundled mjs INSIDE the walnut project so Node's
    // ESM resolver can walk up from the bundle file to walnut's node_modules
    // when resolving externals like 'better-sqlite3'. If we write to os.tmpdir(),
    // Node looks for node_modules in /private/var/folders/... and fails.
    // esbuild's `nodePaths` option only affects build-time resolution — Node
    // ignores it at runtime, so the file's actual on-disk location matters.
    const cacheDir = path.join(projectRoot, '.plugin-cache');
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* exists */ }
    const outfile = path.join(cacheDir, `${pluginName}-${Date.now()}.mjs`);

    await build({
      entryPoints: [entryFile],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // Mark ALL npm packages external — we only bundle to rebase the plugin's
      // own relative imports onto walnut's src/ tree; npm packages (native ones
      // like better-sqlite3 / node-pty included) resolve at runtime from
      // walnut's node_modules. Listing packages individually was whack-a-mole:
      // any new transitively-reached native dep broke the bundle (better-sqlite3,
      // then node-pty). `packages: 'external'` kills that whole class.
      packages: 'external',
      nodePaths: [path.join(projectRoot, 'node_modules')],
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
      logLevel: 'warning',
      plugins: [{
        name: 'rebase-open-walnut-imports',
        setup(b) {
          // Rebase parent-directory imports (../../core/, ../../utils/, etc.)
          // to the open-walnut src/ tree so they resolve correctly.
          // Use src/ (not dist/) because tsup bundles everything — dist/ lacks individual module files.
          // BUILTIN_DIR = {project}/dist/integrations → srcBase = {project}/src/integrations
          const srcBase = path.join(path.dirname(path.dirname(BUILTIN_DIR)), 'src', 'integrations');
          const rebaseDir = fs.existsSync(srcBase) ? srcBase : BUILTIN_DIR;
          b.onResolve({ filter: /^\.\.\// }, (args) => {
            // Only rebase imports originating from the plugin directory itself.
            // Once resolved into the open-walnut src/ tree, let esbuild handle natively.
            if (!args.importer.startsWith(pluginDir + '/')) return undefined;
            const subPath = path.relative(pluginDir, args.importer);
            const assumedImporter = path.join(rebaseDir, pluginName, subPath);
            const resolved = path.resolve(path.dirname(assumedImporter), args.path);
            // Try .ts extension (esbuild resolves .js → .ts naturally in the src tree)
            for (const candidate of [
              resolved.replace(/\.js$/, '.ts'),
              resolved,
              path.join(resolved.replace(/\.js$/, ''), 'index.ts'),
            ]) {
              try { if (fs.statSync(candidate).isFile()) return { path: candidate }; } catch { /* expected: candidate doesn't exist */ }
            }
            return undefined;
          });
        },
      }],
    });

    return outfile;
  } catch (err) {
    log.warn('failed to bundle external plugin', {
      dir: pluginDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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
      } catch { /* expected: candidate doesn't exist, keep walking */ }
    }
    dir = path.dirname(dir);
  }
  // Fallback: sibling of this file's parent (src/core/ → src/integrations/)
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'integrations');
}

const BUILTIN_DIR = resolveBuiltinDir();
const EXTERNAL_DIR = path.join(WALNUT_HOME, 'plugins');

// Plugins discovered on disk but skipped for missing required config.
// Reset on each loadPlugins() run; served via /api/integrations for the Settings UI.
const unconfiguredPlugins: UnconfiguredPlugin[] = [];

/** Plugins that were found but not loaded because required config is missing. */
export function getUnconfiguredPlugins(): UnconfiguredPlugin[] {
  return unconfiguredPlugins;
}

/** Plugins skipped because their manifest declares only capabilities this
 *  Walnut version doesn't implement yet (manifest v2 forward-compat). */
const unsupportedPlugins: Array<{ id: string; name: string; capabilities: string[] }> = [];

export function getUnsupportedPlugins(): Array<{ id: string; name: string; capabilities: string[] }> {
  return unsupportedPlugins;
}

/** Plugin ids skipped because another plugin with the same id loaded first
 *  (built-in > ~/.open-walnut/plugins/ > store clones). */
const duplicatePluginIds: string[] = [];

export function getDuplicatePluginIds(): string[] {
  return duplicatePluginIds;
}

/** Capability types this Walnut version can load. Everything else is reserved. */
const SUPPORTED_CAPABILITIES = new Set(['sync']);

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
    claim: { fn: ProjectClaimFn; priority: number } | null;
    display: DisplayMeta | null;
    agentContext: string | null;
    migrations: MigrateFn[];
    httpRoutes: HttpRoute[];
    extIndex: ExtIndexSpec | null;
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
    extIndex: null,
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

    registerSourceClaim(fn: ProjectClaimFn, opts?: { priority?: number }) {
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

    registerExtIndex(spec: ExtIndexSpec) {
      if (collected.extIndex) {
        throw new Error(`Plugin "${manifest.id}" called registerExtIndex() more than once.`);
      }
      if (spec.source !== manifest.id) {
        throw new Error(
          `Plugin "${manifest.id}" tried to register ext-index for source "${spec.source}". ` +
          `spec.source must equal the plugin id.`,
        );
      }
      if (!Array.isArray(spec.paths) || spec.paths.length === 0) {
        throw new Error(`Plugin "${manifest.id}" registerExtIndex: paths must be a non-empty array.`);
      }
      for (const p of spec.paths) {
        if (!/^[a-z0-9_]+$/.test(p.key)) {
          throw new Error(`Plugin "${manifest.id}" ext-index path key "${p.key}" must match /^[a-z0-9_]+$/.`);
        }
        if (!p.json.startsWith('$.') && !p.json.startsWith('$[')) {
          throw new Error(`Plugin "${manifest.id}" ext-index path json "${p.json}" must start with '$.' or '$['.`);
        }
      }
      collected.extIndex = spec;
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
        } catch { /* expected: not a plugin directory (no manifest.json) */ }
      }
    }
  } catch (err) {
    log.debug('Built-in integrations dir not found', {
      dir: BUILTIN_DIR,
      error: err instanceof Error ? err.message : String(err),
    });
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
        } catch { /* expected: not a plugin directory (no manifest.json) */ }
      }
    }
  } catch (err) {
    log.debug('external plugins dir not accessible', {
      dir: EXTERNAL_DIR,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Scan plugin-source clones (the "plugin store" feature). These are real
  // directories (never symlinks) so the esbuild import-rebase path works
  // unchanged. Loaded after EXTERNAL_DIR, so a manually installed plugin
  // shadows a store copy with the same id.
  try {
    const { getStorePluginDirs } = await import('./plugin-sources.js');
    for (const dir of await getStorePluginDirs()) {
      results.push({ dir, isBuiltin: false });
    }
  } catch (err) {
    log.debug('plugin-source scan failed', {
      error: err instanceof Error ? err.message : String(err),
    });
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

  // Manifest v2: capabilities. Parsed leniently — unknown keys warn (they may
  // be from a newer Walnut), invalid shapes are dropped.
  let capabilities: Record<string, Record<string, unknown>> | undefined;
  if (obj.capabilities && typeof obj.capabilities === 'object' && !Array.isArray(obj.capabilities)) {
    capabilities = {};
    for (const [key, val] of Object.entries(obj.capabilities as Record<string, unknown>)) {
      capabilities[key] = (val && typeof val === 'object' && !Array.isArray(val))
        ? val as Record<string, unknown> : {};
      if (!SUPPORTED_CAPABILITIES.has(key)) {
        log.warn('Manifest declares a capability this Walnut version does not support', {
          filePath, capability: key,
        });
      }
    }
  }

  // taskFields: per-task fields the console renders generically. Invalid
  // entries are dropped with a warn (a bad field must not unload the plugin).
  let taskFields: TaskFieldSpec[] | undefined;
  if (Array.isArray(obj.taskFields)) {
    taskFields = [];
    const seenKeys = new Set<string>();
    for (const raw of obj.taskFields) {
      const f = raw as Record<string, unknown>;
      const drop = (reason: string) =>
        log.warn('Manifest taskFields entry dropped', { filePath, reason, entry: JSON.stringify(raw).slice(0, 200) });
      if (!f || typeof f !== 'object') { drop('not an object'); continue; }
      if (typeof f.key !== 'string' || !/^[a-z0-9_]+$/.test(f.key)) { drop('key must match [a-z0-9_]+'); continue; }
      if (seenKeys.has(f.key)) { drop(`duplicate key "${f.key}"`); continue; }
      if (typeof f.label !== 'string' || !f.label) { drop('label required'); continue; }
      if (f.type !== 'enum') { drop(`type "${String(f.type)}" not supported (v1: enum only)`); continue; }
      if (typeof f.optionsRoute !== 'string' || !f.optionsRoute.startsWith('/')) { drop('optionsRoute must start with /'); continue; }
      if (f.coreField !== undefined && f.coreField !== 'sprint') { drop(`coreField "${String(f.coreField)}" not honored`); continue; }
      seenKeys.add(f.key);
      taskFields.push({
        key: f.key,
        label: f.label,
        type: 'enum',
        optionsRoute: f.optionsRoute,
        clearable: typeof f.clearable === 'boolean' ? f.clearable : undefined,
        coreField: f.coreField as 'sprint' | undefined,
      });
    }
    if (taskFields.length === 0) taskFields = undefined;
  }

  return {
    id: obj.id,
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    version: typeof obj.version === 'string' ? obj.version : undefined,
    engines: obj.engines && typeof obj.engines === 'object'
      ? obj.engines as { walnut?: string }
      : undefined,
    capabilities,
    configSchema: obj.configSchema && typeof obj.configSchema === 'object'
      ? obj.configSchema as Record<string, unknown>
      : undefined,
    uiHints: obj.uiHints && typeof obj.uiHints === 'object'
      ? obj.uiHints as Record<string, { label?: string; help?: string }>
      : undefined,
    taskFields,
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
    duplicatePluginIds.push(pluginId);
    return;
  }

  // Check enabled flag from config (local plugin cannot be disabled)
  const configEntry = pluginConfigs[pluginId] ?? {};
  if (!isLocal && configEntry.enabled === false) {
    log.debug('Plugin disabled in config', { id: pluginId });
    return;
  }

  // Manifest v2: absence of `capabilities` means a sync plugin (back-compat).
  // A manifest declaring only capabilities we don't implement is skipped
  // WITHOUT importing its code — it targets a newer Walnut.
  const expectsSync = !manifest.capabilities || 'sync' in manifest.capabilities;
  if (!expectsSync) {
    const declared = Object.keys(manifest.capabilities ?? {});
    log.warn('Plugin not loaded — requires capabilities this Walnut version does not support', {
      id: pluginId, capabilities: declared,
    });
    unsupportedPlugins.push({ id: pluginId, name: manifest.name, capabilities: declared });
    return;
  }

  // Validate config against configSchema
  const { enabled: _enabled, ...pluginConfig } = configEntry;

  // Skip plugin if required config fields are missing.
  // Record it as unconfigured so the Settings UI can show what to fill in,
  // and log per-field guidance from the manifest's uiHints.
  const requiredFields = (manifest.configSchema as any)?.required as string[] | undefined;
  if (requiredFields?.length) {
    const missing = requiredFields.filter(f => !(f in pluginConfig));
    if (missing.length > 0) {
      const fieldHints = missing.map(f => {
        const hint = manifest.uiHints?.[f];
        return hint?.help ? `${f} (${hint.help})` : f;
      });
      log.warn('Plugin not loaded — missing required config', {
        id: pluginId,
        missing,
        hint: `Set plugins.${pluginId}.{${missing.join(', ')}} in config.yaml or Settings → Integrations. ${fieldHints.join('; ')}`,
      });
      unconfiguredPlugins.push({
        id: pluginId,
        name: manifest.name,
        description: manifest.description,
        missing,
        configSchema: manifest.configSchema,
        uiHints: manifest.uiHints,
      });
      return;
    }
  }

  if (manifest.configSchema && Object.keys(pluginConfig).length > 0) {
    const errors = validateConfigValue(pluginConfig, manifest.configSchema, `plugins.${pluginId}`);
    if (errors.length > 0) {
      log.warn('Plugin config validation errors', { id: pluginId, errors });
      // Continue anyway — log warning but don't block plugin load
    }
  }

  // Dynamic import — find entry point and load it.
  // For external .ts plugins, use esbuild to bundle on-the-fly (resolves parent imports).
  // For built-in plugins, the compiled .js is already in dist/integrations/.
  let registerFn: ((api: PluginApi) => void | Promise<void>) | null = null;
  const candidates = ['index.ts', 'plugin.ts', 'index.js', 'plugin.js', 'index.mjs'];
  let bundledFile: string | null = null;

  for (const filename of candidates) {
    const entryPath = path.join(pluginDir, filename);
    try {
      await fsp.access(entryPath, fs.constants.R_OK);

      // External .ts plugins need esbuild bundling (parent imports break otherwise)
      if (!isBuiltin && filename.endsWith('.ts')) {
        bundledFile = await bundleExternalPlugin(pluginDir, entryPath);
        if (bundledFile) {
          const mod = await import(pathToFileURL(bundledFile).href);
          // Clean up temp bundle — module is cached by Node after import()
          fsp.unlink(bundledFile).catch(() => {});
          bundledFile = null;
          if (typeof mod.default === 'function') {
            registerFn = mod.default;
            break;
          }
        }
        // Bundling failed or no default export — try next candidate
        continue;
      }

      // Built-in plugins or .js/.mjs: direct import
      const moduleUrl = pathToFileURL(entryPath).href;
      const mod = await import(moduleUrl);
      if (typeof mod.default === 'function') {
        registerFn = mod.default;
        break;
      }
      // File loaded but no default export — try next candidate
    } catch (err) {
      log.debug('plugin entry candidate failed', {
        id: pluginId, filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!registerFn || typeof registerFn !== 'function') {
    log.warn('No valid entry point found', { id: pluginId, dir: pluginDir, tried: candidates });
    if (bundledFile) try { await fsp.unlink(bundledFile); } catch { /* non-critical cleanup */ }
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
    extIndex: builder.collected.extIndex ?? undefined,
    configSchema: manifest.configSchema,
    uiHints: manifest.uiHints,
    taskFields: manifest.taskFields,
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
    extIndexPaths: registered.extIndex?.paths.length ?? 0,
  });
}


// ── Main entry: load all plugins ──

export async function loadPlugins(registry: IntegrationRegistry): Promise<void> {
  log.info('Loading plugins', { builtinDir: BUILTIN_DIR, externalDir: EXTERNAL_DIR });
  unconfiguredPlugins.length = 0;
  unsupportedPlugins.length = 0;
  duplicatePluginIds.length = 0;

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

  // Load external plugins (esbuild bundles .ts plugins on-the-fly)
  for (const { dir } of externals) {
    await loadPlugin(dir, false, pluginConfigs, registry);
  }

  const loaded = registry.getAll();

  // Collect ext-index specs from registered plugins, publish them to the
  // shared registry, and open the corresponding SQLite indexes. Idempotent
  // (CREATE INDEX IF NOT EXISTS).
  const specs: ExtIndexSpec[] = [];
  for (const p of loaded) {
    if (p.extIndex) specs.push(p.extIndex);
  }
  setExtIndexes(specs);
  if (specs.length > 0) {
    try {
      ensureExtIndexes(specs);
    } catch (err) {
      log.error('failed to open plugin ext-indexes', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info('Plugin loading complete', {
    total: loaded.length,
    ids: loaded.map(p => p.id),
    extIndexes: specs.length,
  });
}

// ── Config migration: move top-level legacy integration keys to plugins.* ──

/**
 * Legacy top-level integration keys to move even when no plugin by that name is
 * installed — i.e. config left behind by an integration that has since been
 * uninstalled. Supplements the primary test (an actual plugin directory exists;
 * see `migrateConfigToPlugins`), it does not replace it: a privately-installed
 * plugin can't be named in this public repo, so the on-disk evidence has to be
 * what drives the decision.
 *
 * ⚠️ NEVER go back to matching "everything not in a known-config-keys list".
 * That inverted the open and closed sets: config sections grow with the product,
 * legacy integration keys never do. Every new top-level section (`ui`, `audio`,
 * `developer`, …) was then one forgotten allowlist edit away from being silently
 * swept into plugins.* on the next boot — where its real reader
 * (`config.ui.session_panels`) no longer finds it, so the feature quietly
 * reverted to defaults with nothing in the logs. It bit twice: `providers` (left
 * the butler unable to authenticate) and `ui` (session_panels kept resetting).
 */
const LEGACY_INTEGRATION_KEYS = new Set([
  'ms_todo',
  'apple_reminders',
  'google_calendar',
]);

/** Plugin ids with a real plugin dir on disk (manifest.json), as `key` would spell them. */
async function getInstalledPluginIds(): Promise<Set<string>> {
  try {
    const dirs = await discoverPluginDirs();
    return new Set(dirs.map(d => path.basename(d.dir)));
  } catch (err) {
    // Can't enumerate — fall back to the legacy list alone. Migrating nothing is
    // safe (the key stays readable at the top level); a wrong move is not.
    log.debug('config migration: plugin discovery failed, using legacy key list only', {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set();
  }
}

/**
 * First-class config sections the OLD inverted allowlist swept into plugins.*
 * on some machine, somewhere. Listed here so an affected config repairs itself
 * on the next boot instead of needing a hand-edit. Append a name here if another
 * section turns up under `plugins.` — that is now a strictly historical event,
 * since the sweep above can no longer reach a non-legacy key.
 */
const MIS_MIGRATED_CONFIG_KEYS = ['providers', 'ui', 'audio', 'developer'] as const;

/**
 * One-time migration: move legacy top-level integration config keys
 * into the new plugins.{id} section.
 *
 * A key is migrated only on POSITIVE evidence that it configures a plugin:
 * either a plugin directory of that name exists on disk (manifest.json), or it
 * is a known-legacy name whose plugin is no longer installed. An unrecognised
 * section is left alone — see LEGACY_INTEGRATION_KEYS for why the old
 * "everything unknown is a plugin" rule was the bug, not the feature.
 *
 * Converts underscores to hyphens for the plugin ID. Reads raw config.yaml,
 * moves what qualifies, writes back. Safe to call repeatedly — no-ops once done.
 */
export async function migrateConfigToPlugins(): Promise<boolean> {
  let raw: Record<string, unknown>;
  try {
    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    raw = (yaml.load(content) as Record<string, unknown>) ?? {};
  } catch (err) {
    log.debug('config file not readable for migration', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false; // No config file — nothing to migrate
  }

  let changed = false;
  const plugins = (raw.plugins ?? {}) as Record<string, Record<string, unknown>>;

  // Self-heal the damage the old inverted allowlist did (see
  // LEGACY_INTEGRATION_KEYS): first-class config sections that were swept into
  // plugins.* get moved back to the top level, dropping the `enabled` flag the
  // migration injected. Reversing the sweep is not optional — the readers look
  // at the top level only, so until the key moves back the feature stays
  // silently broken (`providers` → butler could not authenticate; `ui` →
  // session_panels reset to its default on every boot).
  //
  // Only reverses keys that no longer exist at the top level, so a real plugin
  // that happens to share a name with a config section is never clobbered.
  for (const key of MIS_MIGRATED_CONFIG_KEYS) {
    if (!plugins[key] || raw[key] != null) continue;
    const { enabled: _enabled, ...entries } = plugins[key];
    raw[key] = entries;
    delete plugins[key];
    log.info(`config migration: restored plugins.${key} → top-level ${key}`);
    changed = true;
  }

  const installedPluginIds = await getInstalledPluginIds();

  for (const [key, val] of Object.entries(raw)) {
    // `plugins` is the destination, not a candidate: a plugin dir literally named
    // "plugins" would otherwise fold the whole section into itself.
    if (key === 'plugins') continue;
    const pluginId = key.replace(/_/g, '-'); // ms_todo → ms-todo
    // Positive evidence only: a plugin dir of that name exists, or the plugin is
    // gone but the key is known-legacy. Everything else is a config section.
    if (!installedPluginIds.has(pluginId) && !LEGACY_INTEGRATION_KEYS.has(key)) continue;
    if (typeof val === 'object' && val !== null) {
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

  let finalTasks: readonly unknown[] = [];
  const changed = await bulkMigrateTasks(async (tasks) => {
    let next = tasks;
    for (const { pluginId, fn } of migrationsToRun) {
      try {
        next = await fn(next);
      } catch (err) {
        log.error('Plugin migration failed', {
          pluginId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with other migrations — don't block on one failure
      }
    }
    finalTasks = next;
    return next;
  });

  if (changed) {
    const extCounts: Record<string, number> = {};
    for (const t of finalTasks as { ext?: Record<string, unknown> }[]) {
      if (t.ext) {
        for (const key of Object.keys(t.ext)) {
          extCounts[key] = (extCounts[key] ?? 0) + 1;
        }
      }
    }
    log.info('Plugin migrations applied and saved', {
      plugins: migrationsToRun.map(m => m.pluginId),
      totalTasks: finalTasks.length,
      extCounts,
    });
  } else {
    log.debug('Plugin migrations ran but no changes detected');
  }
}
