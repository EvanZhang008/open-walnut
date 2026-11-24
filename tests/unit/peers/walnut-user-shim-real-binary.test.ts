/**
 * The daemon's user-PATH `walnut` shim installer must never overwrite a real
 * walnut. The compiled Walnut file carries the shim marker string in its own
 * code (it contains the daemon), so a marker check alone would read a ~100 MB
 * `~/.local/bin/walnut` as "our shim" and replace the person's install with a
 * three-line script. The daemon skips a file bigger than a shim can be.
 *
 * The daemon's installer is cut from daemon-standalone.ts and run against a
 * temp HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '../../..')

const STANDALONE = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')

/** The daemon's shim constants, userWalnutShimText and installUserWalnutShim, as JS. */
function daemonInstaller(): string {
  const from = STANDALONE.indexOf('const LEGACY_WN_SHIM_MARKERS =')
  const fn = STANDALONE.indexOf('function installUserWalnutShim()')
  expect(from).toBeGreaterThan(-1)
  expect(fn).toBeGreaterThan(from)
  const code = STANDALONE.slice(from, STANDALONE.indexOf('\n}\n', fn) + 3)
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-user-shim-big-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

function installShim(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(
    'fs', 'path', 'HOME_DIR', 'IS_PROD_DAEMON_DIR', 'PROD_DAEMON_DIR', 'logMsg',
    daemonInstaller() + '\ninstallUserWalnutShim();',
  )
  run(fs, path, home, true, '/tmp/open-walnut', () => undefined)
}

describe('user-PATH walnut shim installer and a real walnut file', () => {
  it('no source the compiled file is built from holds the marker: an older daemon (0.6.x) would read the file as its shim and overwrite it', () => {
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && fs.readFileSync(p, 'utf-8').includes('walnut-user-shim')) hits.push(path.relative(ROOT, p))
      }
    }
    walk(path.join(ROOT, 'src'))
    expect(hits).toEqual([])
  })

  it('leaves a big walnut that happens to contain the marker untouched', () => {
    const bin = path.join(home, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const real = Buffer.concat([Buffer.alloc(64 * 1024, 0x7f), Buffer.from('walnut-user-shim v1'), Buffer.alloc(1024, 0x00)])
    fs.writeFileSync(path.join(bin, 'walnut'), real, { mode: 0o755 })
    installShim()
    expect(fs.readFileSync(path.join(bin, 'walnut')).equals(real)).toBe(true)
  })

  it('still refreshes its own small shim and installs one where none exists', () => {
    const bin = path.join(home, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'walnut'), '#!/bin/sh\n# walnut-user-shim v1 old\n', { mode: 0o755 })
    installShim()
    const text = fs.readFileSync(path.join(bin, 'walnut'), 'utf-8')
    expect(text).toContain('walnut-user-shim v1')
    expect(text).not.toContain(' old\n')
    fs.rmSync(path.join(bin, 'walnut'))
    installShim()
    expect(fs.readFileSync(path.join(bin, 'walnut'), 'utf-8')).toBe(text)
  })

  it('the daemon skips a big file before reading it', () => {
    const standalone = STANDALONE
    const guard = standalone.indexOf('if (fs.statSync(target).size > USER_WALNUT_SHIM_MAX_BYTES) continue')
    const read = standalone.indexOf("const existing = fs.readFileSync(target, 'utf-8')")
    expect(guard).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(guard)
    expect(standalone).toContain('const USER_WALNUT_SHIM_MAX_BYTES = 16 * 1024')
  })
})
