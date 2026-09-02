/**
 * RATCHET: every sync plugin's primary remote-id path must be UNIQUE.
 *
 * The task-forking bug returned three times (Apr 2026, Aug 2026, Sep 2026)
 * because "one remote item maps to at most one local task" was enforced by
 * procedure. It is now a partial UNIQUE index, and `ExtIndexPath.unique` defaults
 * to true for `paths[0]` precisely so a plugin author cannot forget it — including
 * the authors of EXTERNAL plugins, who ship outside this repo.
 *
 * This test fails if that default is ever weakened, or if an in-repo sync plugin
 * explicitly opts its identity path out. It reads the plugins' real registration
 * calls rather than restating a list of provider names.
 */
import { describe, it, expect } from 'vitest';
import { createTestPluginApi } from './plugin-test-utils.js';
import type { ExtIndexSpec } from '../../src/core/integration-types.js';

/**
 * In-repo sync plugins that own a remote identity.
 *
 * `load` is a STATIC import thunk, not `import(\`…/${id}/index.js\`)`: a
 * template-literal specifier is not statically analyzable, and the bundler
 * rejects it outright ("Unknown variable dynamic import").
 */
const SYNC_PLUGINS: Array<{
  id: string;
  name: string;
  config: Record<string, unknown>;
  load: () => Promise<{ default: (api: unknown) => void }>;
}> = [
  {
    id: 'ms-todo', name: 'Microsoft To-Do',
    config: { client_id: 'test-client-id' },
    load: () => import('../../src/integrations/ms-todo/index.js') as any,
  },
  {
    id: 'jira', name: 'Jira',
    config: { base_url: 'https://example.invalid', project_key: 'AA' },
    load: () => import('../../src/integrations/jira/index.js') as any,
  },
];

async function specFor(plugin: typeof SYNC_PLUGINS[number]): Promise<ExtIndexSpec | undefined> {
  const mod = await plugin.load();
  const { api, collected } = createTestPluginApi(
    { id: plugin.id, name: plugin.name },
    plugin.config,
  );
  mod.default(api);
  return collected.extIndex;
}

describe('remote-id uniqueness ratchet', () => {
  it('every in-repo sync plugin registers an ext-index whose primary path is unique', async () => {
    for (const plugin of SYNC_PLUGINS) {
      const spec = await specFor(plugin);
      expect(spec, `${plugin.id} must call registerExtIndex`).toBeTruthy();
      expect(spec!.paths.length, `${plugin.id} must declare a primary path`).toBeGreaterThan(0);
      const primary = spec!.paths[0];
      // `undefined` is fine — the default for paths[0] IS unique. An explicit
      // false is the regression this test exists to catch.
      expect(
        primary.unique ?? true,
        `${plugin.id}: primary ext-id path "${primary.json}" must be UNIQUE`,
      ).toBe(true);
    }
  });

  it('the default itself is "paths[0] is unique" — not opt-in', async () => {
    // Guards the rule in src/core/task-db.ts ensureExtIndexes. If someone flips
    // the default to opt-in, external plugins silently lose the constraint, which
    // is exactly how a provider outside this repo accumulated 32 duplicate groups.
    const { ensureExtIndexes } = await import('../../src/core/task-db.js');
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../src/core/task-db.ts', import.meta.url), 'utf8'));
    expect(typeof ensureExtIndexes).toBe('function');
    expect(
      /p\.unique\s*\?\?\s*i\s*===\s*0/.test(src),
      'ensureExtIndexes must default paths[0] to unique',
    ).toBe(true);
  });
});
