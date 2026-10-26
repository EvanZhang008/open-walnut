/**
 * Where a remote deploy caches the gzipped daemon binary (daemon-gz-cache.ts).
 * A writable package keeps the archive next to the binary, as before; a
 * read-only one (the cloud companion's code tree is root's) keeps it under the
 * data dir, keyed so a rebuilt binary gets a new archive and the old one goes.
 * Skipped as root, which chmod does not restrict.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-daemon-gz-cache'))

import { WALNUT_HOME } from '../../src/constants.js'
import { daemonGzCachePath, ensureDaemonGz } from '../../src/providers/daemon-gz-cache.js'
import { gunzipSync } from 'node:zlib'

const binDir = () => path.join(WALNUT_HOME, 'pkg', 'dist', 'daemon-binaries')
const binary = () => path.join(binDir(), 'walnut-daemon-linux-x64')

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(binDir(), { recursive: true })
  await fs.writeFile(binary(), 'binary v1')
})

afterEach(async () => {
  await fs.chmod(binDir(), 0o755).catch(() => {})
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('daemonGzCachePath', () => {
  it('a writable package: next to the binary, as before', async () => {
    expect(await daemonGzCachePath(binary())).toBe(`${binary()}.gz`)
  })

  it.skipIf(process.getuid?.() === 0)('a read-only package: under the data dir, one archive per build', async () => {
    await fs.chmod(binDir(), 0o555)
    const first = await daemonGzCachePath(binary())
    expect(path.dirname(first)).toBe(path.join(WALNUT_HOME, 'cache', 'daemon-binaries'))
    expect(path.basename(first)).toMatch(/^walnut-daemon-linux-x64-[0-9a-f]{12}\.gz$/)
    expect(await daemonGzCachePath(binary())).toBe(first)
    await fs.writeFile(first, 'archive of v1')

    // A rebuild (new size and mtime) gets its own name; the stale archive goes.
    await fs.chmod(binDir(), 0o755)
    await fs.writeFile(binary(), 'binary v2, longer')
    await fs.chmod(binDir(), 0o555)
    const second = await daemonGzCachePath(binary())
    expect(second).not.toBe(first)
    await expect(fs.stat(first)).rejects.toThrow()
  })
})

describe('ensureDaemonGz', () => {
  it('builds the archive once per build of the binary', async () => {
    const gz = await ensureDaemonGz(binary())
    expect(gunzipSync(await fs.readFile(gz)).toString()).toBe('binary v1')
    const built = (await fs.stat(gz)).mtimeMs
    await new Promise((r) => setTimeout(r, 20))
    expect(await ensureDaemonGz(binary())).toBe(gz)
    expect((await fs.stat(gz)).mtimeMs).toBe(built)
  })

  it('a binary replaced with an OLDER mtime (kept by tar or cp -p) still gets a new archive', async () => {
    const gz = await ensureDaemonGz(binary())
    await fs.writeFile(binary(), 'binary v2, built earlier')
    const past = new Date(Date.now() - 86_400_000)
    await fs.utimes(binary(), past, past)
    await ensureDaemonGz(binary())
    expect(gunzipSync(await fs.readFile(gz)).toString()).toBe('binary v2, built earlier')
  })

  it('two deploys at once share one build and both read a whole archive', async () => {
    const [a, b] = await Promise.all([ensureDaemonGz(binary()), ensureDaemonGz(binary())])
    expect(a).toBe(b)
    expect(gunzipSync(await fs.readFile(a)).toString()).toBe('binary v1')
    expect((await fs.readdir(binDir())).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it.skipIf(process.getuid?.() === 0)('a failed gzip leaves no archive and no temp file behind', async () => {
    await fs.chmod(binary(), 0o000)
    try {
      await expect(ensureDaemonGz(binary())).rejects.toThrow(/gzip/)
      expect((await fs.readdir(binDir())).sort()).toEqual(['walnut-daemon-linux-x64'])
    } finally {
      await fs.chmod(binary(), 0o644)
    }
  })
})
