/**
 * scripts/release-unpack.sh: the plain compiled files out of a release's assets,
 * each checked by both of its SHA256SUMS lines. The binary matrix's rows unpack
 * their own target with it and the publishing jobs every target, so what npm gets
 * is the bytes the matrix ran (release.yml, binary-matrix.yml). Stand-in files
 * take the place of the compiled ones, laid out by release-files.mjs itself.
 * Every case runs under /bin/sh and, where the system has it, dash.
 */
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TARGETS, assetName, builtName, fileName, writeAssets } from '../../scripts/release-files.mjs'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
const SCRIPT = path.join(ROOT, 'scripts/release-unpack.sh')
const VERSION = '0.7.1-nightly.20261023.4'
const SHELLS = ['/bin/sh', ...(fs.existsSync('/bin/dash') ? ['/bin/dash'] : [])]
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

let tmp = ''
let files = ''
let assets = ''
beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-unpack-')))
  files = path.join(tmp, 'dist-bin')
  fs.mkdirSync(files)
  for (const { target } of TARGETS) fs.writeFileSync(path.join(files, builtName(target)), `#!/bin/sh\necho '${VERSION} (${target})'\n`, { mode: 0o755 })
  assets = path.join(tmp, 'assets')
  await writeAssets({ files, version: VERSION, out: assets })
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** A copy of the assets to spoil. */
function copyOfAssets(): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'spoiled-'))
  for (const f of fs.readdirSync(assets)) fs.copyFileSync(path.join(assets, f), path.join(dir, f))
  return dir
}

function unpack(shell: string, args: string[]) {
  const r = spawnSync(shell, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: guardedPath([], '/usr/bin:/bin:/usr/sbin:/sbin') } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe.each(SHELLS)('release-unpack.sh (%s)', (shell) => {
  it('unpacks every target into <out>/walnut-<target>, the very bytes that were gzipped, executable', () => {
    const out = fs.mkdtempSync(path.join(tmp, 'out-'))
    const r = unpack(shell, [assets, VERSION, out])
    expect(r.code, r.out).toBe(0)
    expect(fs.readdirSync(out).sort()).toEqual(TARGETS.map((t) => builtName(t.target)).sort())
    for (const { target } of TARGETS) {
      const got = path.join(out, builtName(target))
      expect(fs.readFileSync(got).equals(fs.readFileSync(path.join(files, builtName(target)))), target).toBe(true)
      expect(fs.statSync(got).mode & 0o111, target).not.toBe(0)
      expect(r.out).toContain(`${fileName(VERSION, target)}, both of its SHA256SUMS lines match`)
    }
  })

  it('unpacks only the targets it is given (a matrix row its own)', () => {
    const out = fs.mkdtempSync(path.join(tmp, 'out-'))
    const r = unpack(shell, [assets, VERSION, out, 'linux-x64-musl'])
    expect(r.code, r.out).toBe(0)
    expect(fs.readdirSync(out)).toEqual(['walnut-linux-x64-musl'])
  })

  it('refuses a .gz its own line disowns, and leaves nothing behind', () => {
    const dir = copyOfAssets()
    fs.writeFileSync(path.join(dir, assetName(VERSION, 'darwin-x64')), zlib.gzipSync(Buffer.from('rebuilt, not the published bytes')))
    const out = path.join(tmp, `out-${crypto.randomUUID()}`)
    const r = unpack(shell, [dir, VERSION, out, 'darwin-x64'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`${assetName(VERSION, 'darwin-x64')} has sha256`)
    expect(fs.existsSync(path.join(out, 'walnut-darwin-x64'))).toBe(false)
  })

  it('refuses a plain file its line disowns even when the .gz line was made to match, and leaves no part file', () => {
    const dir = copyOfAssets()
    const gz = zlib.gzipSync(Buffer.from('something else inside'))
    fs.writeFileSync(path.join(dir, assetName(VERSION, 'linux-arm64')), gz)
    const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').split('\n')
      .map((l) => l.endsWith(`  ${assetName(VERSION, 'linux-arm64')}`) ? `${sha256(gz)}  ${assetName(VERSION, 'linux-arm64')}` : l)
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.join('\n'))
    const out = fs.mkdtempSync(path.join(tmp, 'out-'))
    const r = unpack(shell, [dir, VERSION, out, 'linux-arm64'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`${fileName(VERSION, 'linux-arm64')} has sha256`)
    expect(fs.readdirSync(out)).toEqual([])
  })

  it('refuses a file SHA256SUMS does not list, or lists twice, and a dir with no SHA256SUMS', () => {
    const dir = copyOfAssets()
    const lines = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n')
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${lines.filter((l) => !l.endsWith(`  ${fileName(VERSION, 'linux-x64')}`)).join('\n')}\n`)
    let r = unpack(shell, [dir, VERSION, path.join(tmp, 'out-a'), 'linux-x64'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain(`SHA256SUMS does not list ${fileName(VERSION, 'linux-x64')}`)
    const gzLine = lines.find((l) => l.endsWith(`  ${assetName(VERSION, 'linux-x64')}`))!
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${[...lines, gzLine].join('\n')}\n`)
    r = unpack(shell, [dir, VERSION, path.join(tmp, 'out-b'), 'linux-x64'])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('more than once')
    fs.rmSync(path.join(dir, 'SHA256SUMS'))
    r = unpack(shell, [dir, VERSION, path.join(tmp, 'out-c')])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no SHA256SUMS')
  })

  it('reads sha256sum\'s binary-mode lines too', () => {
    const dir = copyOfAssets()
    const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').replace(/ {2}walnut-/g, ' *walnut-')
    fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums)
    const r = unpack(shell, [dir, VERSION, fs.mkdtempSync(path.join(tmp, 'out-')), 'darwin-arm64'])
    expect(r.code, r.out).toBe(0)
  })

  it('refuses another version, a target the release does not ship, and a path for a target', () => {
    let r = unpack(shell, [assets, '0.7.0', path.join(tmp, 'out-v')])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('no walnut-0.7.0-*.gz')
    for (const target of ['windows-x64', '../../etc/passwd']) {
      r = unpack(shell, [assets, VERSION, path.join(tmp, 'out-t'), target])
      expect(r.code, target).not.toBe(0)
      expect(r.out).toContain('is not a release target')
    }
    r = unpack(shell, [assets, VERSION])
    expect(r.code).toBe(2)
  })
})
