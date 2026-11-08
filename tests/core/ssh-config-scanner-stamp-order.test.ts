/**
 * The ssh config cache stamps a file before it reads it (review round 2, nice-to-have).
 *
 * Stamped after the read, an edit landing between the read and the stat left the cache
 * holding the old content under the new mtime: every later scan answered from it and the
 * edit (a host just added) never showed. Stamped before, the stamp is older than the file,
 * so the next scan reads it again.
 *
 * Guard: in ssh-config-scanner.ts every function that both stamps and reads stamps first.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetScanCacheForTest, scanSshConfig } from '../../src/core/ssh-config-scanner.js'

let dir: string
beforeEach(() => {
  _resetScanCacheForTest()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-sshcfg-order-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('an edit while the config is being read', () => {
  it('is seen by the next scan', async () => {
    const file = path.join(dir, 'config')
    fs.writeFileSync(file, 'Host first-box\n  HostName 10.0.0.1\n')
    const realRead = fsp.readFile.bind(fsp)
    let edited = false
    vi.spyOn(fsp, 'readFile').mockImplementation((async (p: Parameters<typeof fsp.readFile>[0], o?: Parameters<typeof fsp.readFile>[1]) => {
      const content = await realRead(p, o)
      if (!edited && String(p) === file) {
        // The user saves a second host right after the scanner read the first version.
        edited = true
        fs.writeFileSync(file, 'Host first-box\n  HostName 10.0.0.1\nHost second-box\n  HostName 10.0.0.2\n')
        const later = new Date(Date.now() + 5_000)
        fs.utimesSync(file, later, later)
      }
      return content
    }) as typeof fsp.readFile)
    expect([...(await scanSshConfig(file)).keys()]).toEqual(['first-box'])
    expect([...(await scanSshConfig(file)).keys()].sort()).toEqual(['first-box', 'second-box'])
  })
})

describe('guard: stamp before read', () => {
  it('every function in the scanner that stamps and reads stamps first', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/ssh-config-scanner.ts'), 'utf8')
    const fns = src.split(/\n(?=(?:export )?(?:async )?function )/)
    const both = fns.filter((f) => /stamps\.push\(/.test(f) && /fs\.(?:readFile|readdir)\(/.test(f))
    expect(both.length).toBeGreaterThanOrEqual(2)
    for (const f of both) {
      const name = /function (\w+)/.exec(f)?.[1]
      expect(f.indexOf('stamps.push('), name).toBeLessThan(f.search(/fs\.(?:readFile|readdir)\(/))
    }
  })
})
