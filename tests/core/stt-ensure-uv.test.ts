/**
 * The pinned uv a Mac without one fetches (src/core/stt/auto-setup.ts ensureUv):
 * the speech recognizer's setup and the local voice's both ask for it at boot,
 * so concurrent callers must share ONE download into one archive and staging
 * dir. The download and the unpack are fakes; nothing leaves this machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import { mkdir, mkdtemp, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { removeTempTree } from '../helpers/temp-home.js'

const downloads: string[] = []
let releaseDownload!: () => void

vi.mock('../../src/core/stt/setup-mlx.js', () => ({ findUv: async () => null }))
vi.mock('../../src/core/stt/llama-runtime.js', () => ({
  installLlama: vi.fn(), isLlamaInstalled: vi.fn(), llamaDownloadBytes: vi.fn(),
  downloadPinned: vi.fn(async (_file: unknown, dest: string) => {
    downloads.push(dest)
    await new Promise<void>((r) => { releaseDownload = r })
    await writeFile(dest, 'archive')
  }),
}))
vi.mock('../../src/core/stt/untar.js', () => ({
  extractTarGz: vi.fn(async (_archive: string, dir: string) => {
    await mkdir(join(dir, 'uv-aarch64-apple-darwin'), { recursive: true })
    await writeFile(join(dir, 'uv-aarch64-apple-darwin', 'uv'), '#!/bin/sh\n')
  }),
}))

import { ensureUv } from '../../src/core/stt/auto-setup.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(os.tmpdir(), 'walnut-ensure-uv-'))
  await mkdir(join(home, '.local', 'share', 'open-walnut', 'bin'), { recursive: true })
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  downloads.length = 0
})

afterEach(async () => {
  vi.restoreAllMocks()
  await removeTempTree(home)
})

describe('ensureUv', () => {
  it('two callers at once share one download, and both get the same uv', async () => {
    const a = ensureUv()
    const b = ensureUv()
    await vi.waitFor(() => expect(downloads).toHaveLength(1))
    releaseDownload()
    const [pa, pb] = await Promise.all([a, b])
    expect(pa).toBe(join(home, '.local', 'share', 'open-walnut', 'bin', 'uv'))
    expect(pb).toBe(pa)
    expect(downloads).toHaveLength(1)
    expect((await stat(pa)).isFile()).toBe(true)
    // Once it is there, a later call fetches nothing.
    expect(await ensureUv()).toBe(pa)
    expect(downloads).toHaveLength(1)
  })
})
