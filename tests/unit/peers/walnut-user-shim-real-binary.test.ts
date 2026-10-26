/**
 * The daemon's user-PATH `walnut` shim installer must never overwrite a real
 * walnut. The compiled Walnut file carries the shim marker string in its own
 * code (it contains the daemon), so a marker check alone would read a ~100 MB
 * `~/.local/bin/walnut` as "our shim" and replace the person's install with a
 * three-line script. Both twins skip a file bigger than a shim can be.
 *
 * The node twin's installer is extracted from the daemon-source.ts template and
 * run against a temp HOME; the bun twin is pinned by text.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')

function nodeTwinFunctions(): string {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')
  const start = src.indexOf('const DAEMON_SOURCE = `')
  const body = src.slice(src.indexOf('`', start) + 1, src.lastIndexOf('`'))
  // eslint-disable-next-line no-eval
  const twin = eval('`' + body + '`') as string
  const pick = (name: string): string => {
    const at = twin.indexOf(`function ${name}()`)
    expect(at, name).toBeGreaterThan(-1)
    return twin.slice(at, twin.indexOf('\n}', at) + 2)
  }
  return pick('userWalnutShimText') + '\n' + pick('installUserWalnutShim')
}

let home: string
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-user-shim-big-')) })
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

function installNodeTwin(): void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(
    'fs', 'path', 'HOME_DIR', 'IS_PROD_DAEMON_DIR', 'PROD_DAEMON_DIR', 'USER_WALNUT_SHIM_MARKER', 'USER_WALNUT_SHIM_TAG', 'USER_WALNUT_SHIM_MAX_BYTES', 'LEGACY_WN_SHIM_MARKERS', 'logMsg',
    nodeTwinFunctions() + '\ninstallUserWalnutShim();',
  )
  run(fs, path, home, true, '/tmp/open-walnut', 'walnut-user-shim v1', 'walnut-user-shim', 16 * 1024, ['walnut-wn-shim v1'], () => undefined)
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
    installNodeTwin()
    expect(fs.readFileSync(path.join(bin, 'walnut')).equals(real)).toBe(true)
  })

  it('still refreshes its own small shim and installs one where none exists', () => {
    const bin = path.join(home, '.local', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'walnut'), '#!/bin/sh\n# walnut-user-shim v1 old\n', { mode: 0o755 })
    installNodeTwin()
    const text = fs.readFileSync(path.join(bin, 'walnut'), 'utf-8')
    expect(text).toContain('walnut-user-shim v1')
    expect(text).not.toContain(' old\n')
    fs.rmSync(path.join(bin, 'walnut'))
    installNodeTwin()
    expect(fs.readFileSync(path.join(bin, 'walnut'), 'utf-8')).toBe(text)
  })

  it('the bun twin (daemon-standalone.ts) skips a big file before reading it', () => {
    const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
    const guard = standalone.indexOf('if (fs.statSync(target).size > USER_WALNUT_SHIM_MAX_BYTES) continue')
    const read = standalone.indexOf("const existing = fs.readFileSync(target, 'utf-8')")
    expect(guard).toBeGreaterThan(-1)
    expect(read).toBeGreaterThan(guard)
    expect(standalone).toContain('const USER_WALNUT_SHIM_MAX_BYTES = 16 * 1024')
  })
})
