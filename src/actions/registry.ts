/**
 * Action discovery and execution.
 *
 * Two sources of action modules:
 *   1. Built-in: src/actions/*.ts, imported through the host bundle (builtin-modules.ts)
 *   2. User:     ~/.open-walnut/actions/*.mjs
 *
 * Each module must export { describe, run } conforming to action types.
 * User actions override built-in actions with the same ID.
 */

import { readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { log } from '../logging/index.js';
import { WALNUT_HOME } from '../constants.js';
import { BUILTIN_ACTION_MODULES } from './builtin-modules.js';
import type { ActionDefinition, ActionDescriptor, ActionContext, ActionResult } from './types.js';
import { sortedNames } from '../lib/dir-order.js';

const USER_ACTIONS_DIR = join(WALNUT_HOME, 'actions');

/** Cache of discovered actions — invalidated by calling discoverActions(). */
let cache: ActionDefinition[] | null = null;

/** The `filePath` a built-in action is listed under: it names the table row, not a file. */
const BUILTIN_PREFIX = 'builtin:';

/** A module's descriptor as an action definition, or null when it is not a usable action. */
function toDefinition(mod: Record<string, unknown>, source: 'builtin' | 'user', filePath: string): ActionDefinition | null {
  if (typeof mod.describe !== 'function') return null;
  const descriptor = (mod.describe as () => ActionDescriptor)();
  if (!descriptor?.id || !descriptor?.name) return null;
  if (descriptor.platform && descriptor.platform !== process.platform) return null;
  return { ...descriptor, source, filePath };
}

async function loadBuiltins(): Promise<ActionDefinition[]> {
  const results: ActionDefinition[] = [];
  for (const [name, load] of Object.entries(BUILTIN_ACTION_MODULES)) {
    try {
      const def = toDefinition(await load(), 'builtin', BUILTIN_PREFIX + name);
      if (def) results.push(def);
    } catch (err) {
      log.cron.warn(`failed to load action module: ${name}`, {
        source: 'builtin',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Scan a directory for action modules and import their descriptors.
 */
async function scanDir(
  dir: string,
  ext: string,
  source: 'user',
): Promise<ActionDefinition[]> {
  const results: ActionDefinition[] = [];
  let entries: string[];
  try {
    entries = sortedNames(await readdir(dir));
  } catch {
    return results; // directory doesn't exist
  }

  for (const file of entries) {
    if (!file.endsWith(ext)) continue;
    // Skip internal files (types, registry, index)
    const base = basename(file, ext);
    if (['types', 'registry', 'index'].includes(base)) continue;

    const filePath = join(dir, file);
    try {
      const def = toDefinition(await import(filePath), source, filePath);
      if (def) results.push(def);
    } catch (err) {
      log.cron.warn(`failed to load action module: ${file}`, {
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

/**
 * Discover all available actions from built-in and user directories.
 * User actions with the same ID override built-in ones.
 */
export async function discoverActions(): Promise<ActionDefinition[]> {
  const [builtins, userActions] = await Promise.all([
    loadBuiltins(),
    scanDir(USER_ACTIONS_DIR, '.mjs', 'user'),
  ]);

  // Merge: user overrides builtin by ID
  const byId = new Map<string, ActionDefinition>();
  for (const action of builtins) byId.set(action.id, action);
  for (const action of userActions) byId.set(action.id, action);

  cache = Array.from(byId.values());
  return cache;
}

/**
 * List all discovered actions. Uses cache if available, otherwise discovers.
 */
export async function listActions(): Promise<ActionDefinition[]> {
  if (!cache) await discoverActions();
  return cache!;
}

/**
 * Get a single action definition by ID.
 */
export async function getAction(id: string): Promise<ActionDefinition | undefined> {
  const actions = await listActions();
  return actions.find((a) => a.id === id);
}

/**
 * Run an action by ID with given context.
 * Dynamic-imports the module fresh each time to pick up user file changes.
 */
export async function runAction(
  id: string,
  params: Record<string, unknown>,
): Promise<ActionResult> {
  const action = await getAction(id);
  if (!action) {
    return { invoke: false, content: `Action "${id}" not found` };
  }

  try {
    // For user actions (.mjs), bust the module cache with a query param
    // so edits are picked up without restarting the server.
    const builtin = action.source === 'builtin' ? BUILTIN_ACTION_MODULES[action.filePath.slice(BUILTIN_PREFIX.length)] : undefined;
    const mod = builtin
      ? await builtin()
      : await import(action.source === 'user' ? `${action.filePath}?t=${Date.now()}` : action.filePath);

    if (typeof mod.run !== 'function') {
      return { invoke: false, content: `Action "${id}" has no run() export` };
    }

    const ctx: ActionContext = {
      WALNUT_HOME,
      params,
    };

    return await mod.run(ctx);
  } catch (err) {
    return {
      invoke: false,
      content: `Action "${id}" failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
