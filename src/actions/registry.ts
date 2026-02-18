/**
 * File-based action discovery and execution.
 *
 * Scans two locations for action modules:
 *   1. Built-in: dist/actions/*.js  (compiled from src/actions/*.ts)
 *   2. User:     ~/.walnut/actions/*.mjs
 *
 * Each module must export { describe, run } conforming to action types.
 * User actions override built-in actions with the same ID.
 */

import { readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../logging/index.js';
import { WALNUT_HOME } from '../constants.js';
import type { ActionDefinition, ActionDescriptor, ActionContext, ActionResult } from './types.js';

const USER_ACTIONS_DIR = join(WALNUT_HOME, 'actions');

/** Cache of discovered actions — invalidated by calling discoverActions(). */
let cache: ActionDefinition[] | null = null;

/**
 * Resolve the built-in actions directory.
 * tsup compiles src/actions/*.ts → dist/actions/*.js as separate entry points.
 * This file (registry.ts) is bundled into dist/web/server.js, so we walk up
 * from import.meta.url to find dist/actions/.
 */
function resolveBuiltinDir(): string {
  const thisDir = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
  let dir = thisDir;
  // When running from dist/web/server.js or dist/cli.js, walk up to find dist/actions/
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'actions');
    try {
      if (statSync(candidate).isDirectory() && candidate !== thisDir) {
        return candidate;
      }
    } catch { /* continue searching */ }
    dir = join(dir, '..');
  }
  // Fallback: current directory (dev mode via tsx — scanDir filters out non-action files)
  return thisDir;
}

/**
 * Scan a directory for action modules and import their descriptors.
 */
async function scanDir(
  dir: string,
  ext: string,
  source: 'builtin' | 'user',
): Promise<ActionDefinition[]> {
  const results: ActionDefinition[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
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
      const mod = await import(filePath);
      if (typeof mod.describe !== 'function') continue;

      const descriptor: ActionDescriptor = mod.describe();
      if (!descriptor?.id || !descriptor?.name) continue;

      // Platform filter
      if (descriptor.platform && descriptor.platform !== process.platform) continue;

      results.push({
        ...descriptor,
        source,
        filePath,
      });
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
  const builtinDir = resolveBuiltinDir();
  const [builtins, userActions] = await Promise.all([
    scanDir(builtinDir, '.js', 'builtin'),
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
    const importPath = action.source === 'user'
      ? `${action.filePath}?t=${Date.now()}`
      : action.filePath;
    const mod = await import(importPath);

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
