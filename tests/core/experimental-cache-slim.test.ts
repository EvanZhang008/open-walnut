/**
 * experimental-cache.ts is read by modules the fast CLI bundles (src/cli-fast.ts, through the ops
 * catalog: org/one-card.ts). A literal import of config-manager there, even a dynamic one, took the
 * whole server into dist/cli-fast.js (2026-11-21: 2,455 modules, about 240 without it; the slow
 * check is tests/scripts/cli-fast-bytecode.test.ts). config-manager hands its reader over instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(__dirname, '../..')

describe('experimental-cache stays slim', () => {
  it('never imports config-manager; config-manager hands it its reader', () => {
    const cache = fs.readFileSync(path.join(ROOT, 'src/core/experimental-cache.ts'), 'utf8')
    expect(cache).not.toMatch(/import\(?\s*['"][^'"]*config-manager/)
    expect(cache).not.toMatch(/from\s+['"][^'"]*config-manager/)
    const manager = fs.readFileSync(path.join(ROOT, 'src/core/config-manager.ts'), 'utf8')
    expect(manager).toMatch(/setExperimentConfigReader\(getConfig\)/)
  })

  it('reads the switch through the reader it was handed', async () => {
    const { experimentCache, setExperimentConfigReader } = await import('../../src/core/experimental-cache.js')
    const flag = experimentCache('brief_off')
    setExperimentConfigReader(async () => ({ experimental: { brief_off: true } }))
    expect(await flag.on()).toBe(true)
    expect(flag.now()).toBe(true)
    setExperimentConfigReader(async () => { throw new Error('unreadable') })
    expect(await flag.on()).toBe(true)
  })
})
