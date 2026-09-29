import { describe, it, expect } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BUILTIN_HOST_MODULES } from '../../src/integrations/host-modules.js'
import { preparePluginModule } from '../../src/core/plugins/plugin-module.js'
import type { PluginManifest } from '../../src/core/integration-types.js'

const INTEGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'src', 'integrations')

// Every built-in plugin directory the build turns into its own bundle must be
// importable through the host instead. A directory missing here would load
// `dist/integrations/<id>/index.js` at runtime and run a private copy of every
// core module it imports (its own task store cache and SQLite connection: the
// ms-todo rescan storm of 2026-09-29).
describe('built-in plugins load as host modules', () => {
  it('lists every src/integrations/<id>/index.ts directory, and nothing else', async () => {
    const dirs: string[] = []
    for (const entry of await fsp.readdir(INTEGRATIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const hasEntry = await fsp.stat(path.join(INTEGRATIONS_DIR, entry.name, 'index.ts')).then(() => true, () => false)
      if (hasEntry) dirs.push(entry.name)
    }
    expect(Object.keys(BUILTIN_HOST_MODULES).sort()).toEqual(dirs.sort())
  })

  it('every manifest id equals its directory name (the table is keyed by directory)', async () => {
    for (const id of Object.keys(BUILTIN_HOST_MODULES)) {
      const manifest = JSON.parse(await fsp.readFile(path.join(INTEGRATIONS_DIR, id, 'manifest.json'), 'utf8')) as { id: string }
      expect(manifest.id).toBe(id)
    }
  })

  it('preparePluginModule takes the host module for a builtin and never evaluates the plugin file', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-module-'))
    try {
      const dir = path.join(tmp, 'sample')
      await fsp.mkdir(dir)
      // The file exists (the entry check still runs) but would throw if imported.
      await fsp.writeFile(path.join(dir, 'index.js'), 'throw new Error("plugin file was evaluated")\n')
      const activate = () => 'host'
      const functions = await preparePluginModule({
        dir,
        builtin: true,
        manifest: { id: 'sample', name: 'Sample', apiVersion: 1, server: 'index.js' } as PluginManifest,
        bundle: async () => ({ error: 'not used' }),
        deadline: async <T>(pending: Promise<T>) => pending,
        hostModule: async () => ({ activate }),
      })
      expect(functions.activate).toBe(activate)
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })

  it('a builtin without a host module still evaluates its own file', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-module-'))
    try {
      const dir = path.join(tmp, 'sample')
      await fsp.mkdir(dir)
      await fsp.writeFile(path.join(dir, 'index.js'), 'export function activate() { return "file" }\n')
      const functions = await preparePluginModule({
        dir,
        builtin: true,
        manifest: { id: 'sample', name: 'Sample', apiVersion: 1, server: 'index.js' } as PluginManifest,
        bundle: async () => ({ error: 'not used' }),
        deadline: async <T>(pending: Promise<T>) => pending,
      })
      expect(functions.activate?.({})).toBe('file')
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true })
    }
  })
})
