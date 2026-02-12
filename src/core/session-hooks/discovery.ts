/**
 * File-based hook discovery.
 *
 * Scans ~/.walnut/hooks/ for .mjs files that export describe() and handle().
 * Same pattern as the action system (src/actions/registry.ts).
 */

import fs from 'node:fs';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import type { SessionHookDefinition, SessionHookPoint } from './types.js';

const HOOKS_DIR = path.join(WALNUT_HOME, 'hooks');

interface HookDescriptor {
  id: string;
  name: string;
  description?: string;
  hooks: SessionHookPoint[];
  priority?: number;
  timeoutMs?: number;
  filter?: {
    modes?: string[];
    projects?: string[];
    categories?: string[];
  };
}

interface HookModule {
  describe: () => HookDescriptor;
  handle: (payload: unknown) => void | Promise<void>;
}

/**
 * Discover file-based hooks from ~/.walnut/hooks/*.mjs
 */
export async function discoverFileHooks(): Promise<SessionHookDefinition[]> {
  if (!fs.existsSync(HOOKS_DIR)) return [];

  const results: SessionHookDefinition[] = [];

  try {
    const entries = fs.readdirSync(HOOKS_DIR);
    const mjsFiles = entries.filter(f => f.endsWith('.mjs'));

    for (const file of mjsFiles) {
      try {
        const fullPath = path.join(HOOKS_DIR, file);
        const mod = await import(fullPath) as Partial<HookModule>;

        if (typeof mod.describe !== 'function' || typeof mod.handle !== 'function') {
          log.session.warn('session hook file missing describe() or handle()', { file });
          continue;
        }

        const desc = mod.describe();
        results.push({
          id: desc.id,
          name: desc.name,
          description: desc.description,
          hooks: desc.hooks,
          handler: mod.handle as SessionHookDefinition['handler'],
          priority: desc.priority,
          timeoutMs: desc.timeoutMs,
          filter: desc.filter as SessionHookDefinition['filter'],
          source: 'file',
          enabled: true,
        });

        log.session.info('discovered file-based session hook', { id: desc.id, file });
      } catch (err) {
        log.session.warn('failed to load session hook file', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    log.session.warn('failed to scan hooks directory', {
      dir: HOOKS_DIR,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return results;
}
