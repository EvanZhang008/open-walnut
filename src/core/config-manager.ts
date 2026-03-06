import fs from 'node:fs/promises';
import yaml from 'js-yaml';
import { CONFIG_FILE } from '../constants.js';
import { VALID_PRIORITIES, type Config, type TaskPriority } from './types.js';

export const DEFAULT_AVAILABLE_MODELS = [
  'global.anthropic.claude-opus-4-6-v1',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
];

const DEFAULT_CONFIG: Config = {
  version: 1,
  user: {},
  defaults: { priority: 'none', category: 'personal' },
  provider: { type: 'claude-code' },
};

/**
 * Read config.yaml. Returns default config if file doesn't exist.
 */
export async function getConfig(): Promise<Config> {
  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.load(content) as Config;
    const config = { ...DEFAULT_CONFIG, ...parsed };
    // Sanitize legacy priority values to new 3-tier system
    if (config.defaults?.priority && !(VALID_PRIORITIES as readonly string[]).includes(config.defaults.priority)) {
      const p = config.defaults.priority as string;
      if (p === 'high') config.defaults.priority = 'immediate';
      else if (p === 'medium' || p === 'low') config.defaults.priority = 'backlog';
      else config.defaults.priority = 'none';
    }
    // Seed available_models default if agent section exists but field is missing
    if (!config.agent?.available_models) {
      config.agent = { ...config.agent, available_models: DEFAULT_AVAILABLE_MODELS };
    }
    // Seed main_model default: first entry in available_models (Opus 4.6)
    if (!config.agent?.main_model) {
      const models = config.agent?.available_models ?? DEFAULT_AVAILABLE_MODELS;
      config.agent = { ...config.agent, main_model: models[0] };
    }
    return config;
  } catch {
    return { ...DEFAULT_CONFIG, agent: { available_models: DEFAULT_AVAILABLE_MODELS, main_model: DEFAULT_AVAILABLE_MODELS[0] } };
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
      '$1# Predefined Bedrock model IDs for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await fs.writeFile(CONFIG_FILE, content, 'utf-8');
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
    // Read raw config from disk (not getConfig() which fills in defaults)
    let existing: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8');
      existing = (yaml.load(content) as Record<string, unknown>) ?? {};
    } catch {
      // No config file — start from empty
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
      '$1# Predefined Bedrock model IDs for the agent form dropdown.\n$1# Edit this list to add or remove models.\n$1available_models:',
    );
    await fs.writeFile(CONFIG_FILE, content, 'utf-8');
  });
}

/**
 * One-time migration: seed `agent.available_models` into config.yaml if missing.
 * Called at startup from init.ts.
 */
export async function seedConfigDefaults(): Promise<void> {
  const config = await getConfig();
  let needsWrite = false;

  // Read raw file to check if available_models is actually on disk (vs filled in by getConfig)
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    if (!raw.includes('available_models')) {
      needsWrite = true;
    }
  } catch {
    // No config file at all — write the full default
    needsWrite = true;
  }

  if (needsWrite) {
    await saveConfig(config);
  }
}
