import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bunTranspilerCacheDirs, pruneHostCaches } from '../../src/providers/host-cache-prune.js'

let root = ''
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }) })

describe('host cache prune', () => {
  it("names bun's transpiler cache where bun keeps it", () => {
    expect(bunTranspilerCacheDirs({}, '/h', 'darwin')).toEqual(['/h/.cache/bun/@t@', '/h/Library/Caches/bun/@t@'])
    expect(bunTranspilerCacheDirs({ XDG_CACHE_HOME: '/x' }, '/h', 'linux')).toEqual(['/x/bun/@t@', '/h/.cache/bun/@t@'])
    // A folder named in the env could be anything: never pruned.
    expect(bunTranspilerCacheDirs({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/c' }, '/h', 'linux')).toEqual(['/h/.cache/bun/@t@'])
  })

  it('removes only regular files older than the cutoff, directly in the folder', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-prune-'))
    const dir = path.join(root, '@t@')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    const old = (Date.now() - 2 * 86_400_000) / 1000
    for (const n of ['a', 'b']) { fs.writeFileSync(path.join(dir, n), 'x'.repeat(100)); fs.utimesSync(path.join(dir, n), old, old) }
    fs.writeFileSync(path.join(dir, 'fresh'), 'y')
    fs.writeFileSync(path.join(dir, 'sub', 'deep'), 'z'); fs.utimesSync(path.join(dir, 'sub', 'deep'), old, old)
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(dir, 'link'))
    const r = await pruneHostCaches([dir, path.join(root, 'missing')], 86_400_000)
    expect(r).toEqual({ removedFiles: 2, removedBytes: 200, dirs: [dir] })
    expect(fs.readdirSync(dir).sort()).toEqual(['fresh', 'link', 'sub'])
    expect(fs.existsSync(path.join(dir, 'sub', 'deep'))).toBe(true)
  })
})
