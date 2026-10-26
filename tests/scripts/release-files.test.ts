/**
 * What a release publishes of the compiled file, short of publishing it: the
 * GitHub Release assets (scripts/release-files.mjs), the npm launcher and
 * platform packages (scripts/npm-packages.mjs, scripts/npm-launcher/launch.js),
 * the Homebrew formula over the assets (scripts/homebrew/formula.mjs), and the
 * upload order (scripts/release-attach.sh). Stand-in files (small scripts) take
 * the place of the compiled ones; tests/scripts/file-distribution.e2e.test.ts
 * installs real compiled files through all of these.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TARGETS, assetName, builtName, fileName, filesIn, writeAssets } from '../../scripts/release-files.mjs'
import { INSTALL_ACCEPT, LAUNCHER, LAUNCHER_LIB, buildPackages, installerSees, launcherManifest, platformManifest, probeRegistry, publishOrder, publishPackages, waitUntilVisible } from '../../scripts/npm-packages.mjs'
import { createRequire } from 'node:module'
import { formula } from '../../scripts/homebrew/formula.mjs'
import { hostTarget } from '../../scripts/release-build.mjs'
import { managerArgv } from '../../src/core/self-update/install-kind.js'
import { guardedPath } from '../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../..')
// The launcher is CommonJS (it runs on old Node): loaded the way Node loads it.
const { candidateTargets, hasMuslCxxRuntime, lddLibc } = createRequire(import.meta.url)('../../scripts/npm-launcher/launch.js')
const VERSION = '0.7.0'
const HEAD = 'a'.repeat(40)
let tmp = ''
let files = ''
let assets = ''
const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-files-')))
  files = path.join(tmp, 'dist-bin')
  fs.mkdirSync(files)
  for (const { target } of TARGETS) fs.writeFileSync(path.join(files, builtName(target)), `#!/bin/sh\necho '${VERSION} (${target})'\n`, { mode: 0o755 })
  assets = path.join(tmp, 'assets')
  await writeAssets({ files, version: VERSION, out: assets })
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('release-files.mjs', () => {
  it('ships six targets: macOS and glibc and musl Linux, on arm64 and x64', () => {
    expect(TARGETS.map((t) => t.target).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-arm64-musl', 'linux-x64', 'linux-x64-musl'])
    for (const t of TARGETS) expect(Boolean(t.libc), t.target).toBe(t.os === 'linux')
  })

  it('writes each file gzipped as walnut-<version>-<target>.gz, and SHA256SUMS for the .gz and the plain file', () => {
    expect(fs.readdirSync(assets).sort()).toEqual(['SHA256SUMS', ...TARGETS.map((t) => assetName(VERSION, t.target))].sort())
    const sums = fs.readFileSync(path.join(assets, 'SHA256SUMS'), 'utf8')
    for (const { target } of TARGETS) {
      const gz = path.join(assets, assetName(VERSION, target))
      const plain = zlib.gunzipSync(fs.readFileSync(gz))
      expect(plain.equals(fs.readFileSync(path.join(files, builtName(target)))), target).toBe(true)
      expect(sums).toContain(`${sha256(gz)}  walnut-${VERSION}-${target}.gz\n`)
      expect(sums).toContain(`${crypto.createHash('sha256').update(plain).digest('hex')}  ${fileName(VERSION, target)}\n`)
    }
    // sha256sum's format: two spaces, and every line one file.
    expect(sums.trim().split('\n')).toHaveLength(TARGETS.length * 2)
  })

  it('reads one version\'s files back out of SHA256SUMS, whatever else it lists', () => {
    const sums = `${fs.readFileSync(path.join(assets, 'SHA256SUMS'), 'utf8')}${'e'.repeat(64)}  open-walnut-${VERSION}-linux-x64.tar.gz\n${'d'.repeat(64)}  walnut-0.6.9-linux-x64.gz\n`
    const parsed = filesIn(sums, VERSION)
    expect(Object.keys(parsed).sort()).toEqual(TARGETS.map((t) => t.target).sort())
    expect(parsed['linux-x64'].gz).toBe(sha256(path.join(assets, assetName(VERSION, 'linux-x64'))))
    expect(filesIn(sums, '0.6.9')).toEqual({ 'linux-x64': { gz: 'd'.repeat(64) } })
  })

  it('refuses a dist-bin with a target missing, and what is not a version', async () => {
    const partial = path.join(tmp, 'partial')
    fs.mkdirSync(partial)
    fs.copyFileSync(path.join(files, builtName('linux-x64')), path.join(partial, builtName('linux-x64')))
    await expect(writeAssets({ files: partial, version: VERSION, out: path.join(tmp, 'no') })).rejects.toThrow(/has no walnut-darwin-arm64/)
    await expect(writeAssets({ files, version: 'v0.7.0', out: path.join(tmp, 'no') })).rejects.toThrow(/not a version/)
    expect(fs.existsSync(path.join(tmp, 'no'))).toBe(false)
  })
})

describe('npm-packages.mjs', () => {
  let out = ''
  beforeAll(() => {
    out = path.join(tmp, 'npm')
    buildPackages({ files, version: VERSION, out, gitHead: HEAD })
  })
  const manifest = (dir: string) => JSON.parse(fs.readFileSync(path.join(out, dir, 'package.json'), 'utf8'))

  it('one package per target that npm installs only where its os, cpu and libc match', () => {
    const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    for (const t of TARGETS) {
      const m = manifest(`@open-walnut/${t.target}`)
      expect(m).toMatchObject({ name: `@open-walnut/${t.target}`, version: VERSION, os: [t.os], cpu: [t.cpu], files: ['walnut'], gitHead: HEAD, license: repo.license })
      expect(m.libc).toEqual(t.libc ? [t.libc] : undefined)
      // No scripts, no bin: the launcher runs it, npm never does.
      expect(m.scripts).toBeUndefined()
      expect(m.bin).toBeUndefined()
      const file = path.join(out, '@open-walnut', t.target, 'walnut')
      expect(fs.statSync(file).mode & 0o111, t.target).not.toBe(0)
      expect(fs.readFileSync(file).equals(fs.readFileSync(path.join(files, builtName(t.target))))).toBe(true)
      expect(platformManifest(t, VERSION, repo).repository).toEqual(repo.repository)
    }
  })

  it('the launcher names every platform package at its own version, and keeps the commands and the old entry', () => {
    const m = manifest(LAUNCHER)
    expect(m).toMatchObject({ name: 'open-walnut', version: VERSION, gitHead: HEAD, bin: { 'open-walnut': 'bin/open-walnut.js', walnut: 'bin/open-walnut.js' } })
    // CommonJS, for any Node npm installs it with (tests/scripts/npm-launcher-node-floor.test.ts).
    expect(m.type).toBe('commonjs')
    expect(m.engines).toEqual({ node: '>=8' })
    expect(m.optionalDependencies).toEqual(Object.fromEntries(TARGETS.map((t) => [`@open-walnut/${t.target}`, VERSION])))
    // One script at install: it checks this machine's file came too, else fetches
    // it or fails the install (npm then keeps the version before). Nothing else to fetch.
    expect(m.scripts).toEqual({ postinstall: 'node lib/postinstall.js' })
    expect(m.dependencies).toBeUndefined()
    expect(launcherManifest(VERSION, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))).main).toBe('./dist/cli.js')
    for (const f of ['bin/open-walnut.js', 'dist/cli.js', 'lib/launch.js', 'lib/fetch-platform.js', 'lib/postinstall.js', 'README.md', 'LICENSE']) expect(fs.existsSync(path.join(out, LAUNCHER, f)), f).toBe(true)
    for (const f of LAUNCHER_LIB) expect(fs.readFileSync(path.join(out, LAUNCHER, 'lib', f), 'utf8'), f).toBe(fs.readFileSync(path.join(ROOT, 'scripts/npm-launcher', f), 'utf8'))
  })

  it('carry nothing npm runs at install but the launcher\'s own postinstall, and the updater allows npm exactly that one', () => {
    // npm runs a package's install, preinstall, postinstall and prepare scripts,
    // and `node-gyp rebuild` for a binding.gyp at its root (or gypfile: true)
    // with no install script. The launcher has exactly one, the check that its
    // file came too (lib/postinstall.js); every other package has none.
    const dirs = [LAUNCHER, ...TARGETS.map((t) => `@open-walnut/${t.target}`)]
    for (const dir of dirs) {
      const m = manifest(dir)
      const allowed: Record<string, string> = dir === LAUNCHER ? { postinstall: 'node lib/postinstall.js' } : {}
      for (const key of ['preinstall', 'install', 'postinstall', 'prepare']) expect(m.scripts?.[key], `${dir} ${key}`).toBe(allowed[key])
      expect(m.gypfile, dir).toBeUndefined()
      expect(fs.existsSync(path.join(out, dir, 'binding.gyp')), `${dir} binding.gyp`).toBe(false)
      const deps = { ...m.dependencies, ...m.optionalDependencies }
      expect(Object.keys(deps).filter((name) => !name.startsWith('@open-walnut/')), dir).toEqual([])
    }
    // npm 12 runs no install script it was not allowed: the launcher's, and only it.
    expect(managerArgv('npm', 'open-walnut@latest').args).toEqual(['install', '-g', 'open-walnut@latest', '--allow-scripts=open-walnut'])
    for (const manager of ['pnpm', 'yarn', 'bun'] as const) {
      expect(managerArgv(manager, 'open-walnut@latest').args.join(' '), manager).not.toMatch(/allow-scripts|ignore-scripts=false|trust/)
    }
  })

  it('refuses a gitHead that is not a commit', () => {
    expect(() => buildPackages({ files, version: VERSION, out: path.join(tmp, 'bad'), gitHead: 'main' })).toThrow(/not a commit sha/)
  })

  it('publishes the platform packages first and the launcher last, each under the tag, with provenance', () => {
    const order = publishOrder(out)
    expect(order.at(-1)).toBe(path.join(out, LAUNCHER))
    expect(order.slice(0, -1).map((p) => path.basename(p)).sort()).toEqual(TARGETS.map((t) => t.target).sort())
    const calls: string[][] = []
    const lines: string[] = []
    publishPackages({ dir: out, tag: 'nightly', provenance: true, dryRun: true, log: (l) => lines.push(l), run: ((_cmd: string, args: string[]) => { calls.push(args); return { status: 0, stdout: '', stderr: '' } }) as never })
    expect(calls.map((a) => a[1])).toEqual(order)
    for (const a of calls) expect(a).toEqual(expect.arrayContaining(['publish', '--tag', 'nightly', '--access', 'public', '--provenance', '--dry-run']))
    expect(lines.at(-1)).toBe(`would publish open-walnut@${VERSION} (nightly)`)
  })

  it('a version npm says it already holds counts as published; any other refusal stops before the launcher', () => {
    const seen: string[] = []
    const taken = ((_cmd: string, args: string[]) => {
      seen.push(path.basename(args[1]))
      return { status: 1, stdout: '', stderr: `npm error 403 You cannot publish over the previously published versions: ${VERSION}.` }
    }) as never
    expect(() => publishPackages({ dir: out, tag: 'latest', dryRun: true, run: taken, log: () => {} })).not.toThrow()
    expect(seen).toHaveLength(TARGETS.length + 1)
    seen.length = 0
    const broken = ((_cmd: string, args: string[]) => { seen.push(path.basename(args[1])); return { status: 1, stdout: '', stderr: 'npm error 500 Internal Server Error' } }) as never
    expect(() => publishPackages({ dir: out, tag: 'latest', dryRun: true, run: broken, log: () => {} })).toThrow(/exited 1/)
    expect(seen).toHaveLength(1)
    expect(seen).not.toContain(LAUNCHER)
    expect(() => publishPackages({ dir: out, tag: '', dryRun: true, run: broken })).toThrow(/needs --tag/)
  })

  it('publishes the launcher only once installers see every platform package', () => {
    const order: string[] = []
    const ok = ((_cmd: string, args: string[]) => { order.push(path.basename(args[1])); return { status: 0, stdout: '', stderr: '' } }) as never
    let waitedFor: Array<[string, string]> = []
    publishPackages({ dir: out, tag: 'latest', run: ok, has: () => false, log: () => {}, waitVisible: ((pkgs: Array<[string, string]>) => { waitedFor = [...pkgs]; order.push('(wait)') }) as never })
    // npm finishes an install without an optional dependency it cannot find yet:
    // a launcher out first installs with no file (0.6.x updates restart into it unchecked).
    expect(order.indexOf('(wait)')).toBe(TARGETS.length)
    expect(order.at(-1)).toBe(LAUNCHER)
    expect(waitedFor).toEqual(TARGETS.map((t) => [`@open-walnut/${t.target}`, VERSION]))
    // Still not seen: the launcher stays out, and a re-run finishes.
    order.length = 0
    expect(() => publishPackages({ dir: out, tag: 'latest', run: ok, has: () => false, log: () => {}, waitVisible: (() => { throw new Error('not seen') }) as never })).toThrow('not seen')
    expect(order).not.toContain(LAUNCHER)
  })

  it('a rerun waits for the platform packages an earlier run published too: on the registry is not yet seen', () => {
    const order: string[] = []
    const ok = ((_cmd: string, args: string[]) => { order.push(path.basename(args[1])); return { status: 0, stdout: '', stderr: '' } }) as never
    let waitedFor: Array<[string, string]> = []
    publishPackages({ dir: out, tag: 'latest', run: ok, has: (name: string) => name !== LAUNCHER, log: () => {}, waitVisible: ((pkgs: Array<[string, string]>) => { waitedFor = [...pkgs] }) as never })
    expect(order).toEqual([LAUNCHER])
    expect(waitedFor).toEqual(TARGETS.map((t) => [`@open-walnut/${t.target}`, VERSION]))
  })

  it('an installer sees a version once the abbreviated document npm installs from and the version\'s own both name it', () => {
    const R = 'https://r.example'
    const asked: string[] = []
    const get = (docs: Record<string, unknown>) => (url: string, accept: string) => {
      asked.push(`${accept} ${url}`)
      return docs[url] ? { status: 200, body: JSON.stringify(docs[url]) } : { status: 404, body: '' }
    }
    const index = { [`${R}/@open-walnut%2fa`]: { versions: { '1.0.0': {} } } }
    // The CDN still holds the version's own document from before it existed.
    expect(installerSees('@open-walnut/a', '1.0.0', R, get(index))).toBe(false)
    expect(asked).toEqual([`${INSTALL_ACCEPT} ${R}/@open-walnut%2fa`, `application/json ${R}/@open-walnut%2fa/1.0.0`])
    expect(installerSees('@open-walnut/a', '1.0.0', R, get({ ...index, [`${R}/@open-walnut%2fa/1.0.0`]: { version: '1.0.0' } }))).toBe(true)
    asked.length = 0
    expect(installerSees('@open-walnut/a', '1.0.0', R, get({ [`${R}/@open-walnut%2fa`]: { versions: { '0.9.0': {} } }, [`${R}/@open-walnut%2fa/1.0.0`]: { version: '1.0.0' } }))).toBe(false)
    expect(asked).toHaveLength(1)
    expect(installerSees('open-walnut', '1.0.0', R, get({ [`${R}/open-walnut`]: { versions: { '1.0.0': {} } }, [`${R}/open-walnut/1.0.0`]: { version: '1.0.0' } }))).toBe(true)
    expect(probeRegistry(null, { npm_config_registry: 'http://m.example/npm/' })).toBe('http://m.example/npm')
    expect(probeRegistry('http://x.example/', { npm_config_registry: 'http://m.example' })).toBe('http://x.example')
    expect(probeRegistry(null, {})).toBe('https://registry.npmjs.org')
  })

  it('waitUntilVisible polls until every package is seen, and gives up at its deadline', () => {
    let t = 0
    const seenAfter = new Map([['@open-walnut/a', 2], ['@open-walnut/b', 0]])
    const calls: string[] = []
    const sees = (name: string) => { calls.push(name); return t >= (seenAfter.get(name) ?? Infinity) }
    waitUntilVisible([['@open-walnut/a', '1.0.0'], ['@open-walnut/b', '1.0.0']], { sees, sleep: () => { t += 1 }, now: () => t, wait: { everyMs: 1, forMs: 10 } })
    // b was seen at once and is not asked again.
    expect(calls.filter((c) => c === '@open-walnut/b')).toHaveLength(1)
    t = 0
    expect(() => waitUntilVisible([['@open-walnut/never', '1.0.0']], { sees, sleep: () => { t += 1 }, now: () => t, wait: { everyMs: 1, forMs: 3 } })).toThrow(/still do not see @open-walnut\/never@1.0.0/)
  })
})

describe('the launcher', () => {
  it('looks for this machine\'s package, the other libc as a fallback on Linux, and none elsewhere', () => {
    expect(candidateTargets('darwin', 'arm64', false)).toEqual(['darwin-arm64'])
    expect(candidateTargets('darwin', 'x64', false)).toEqual(['darwin-x64'])
    expect(candidateTargets('linux', 'x64', false)).toEqual(['linux-x64', 'linux-x64-musl'])
    expect(candidateTargets('linux', 'arm64', true)).toEqual(['linux-arm64-musl', 'linux-arm64'])
    expect(candidateTargets('win32', 'x64', false)).toEqual([])
    expect(candidateTargets('linux', 'ia32', false)).toEqual([])
  })

  it('builds every x64 file on bun\'s baseline (no AVX2: old Intel Macs, Rosetta before macOS 15)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-binary.mjs'), 'utf8')
    const block = /export const TARGETS = \{([^}]*)\}/.exec(src)?.[1] ?? ''
    const pairs = [...block.matchAll(/'([\w-]+)': '([\w-]+)'/g)].map((m) => [m[1]!, m[2]!])
    expect(pairs.length).toBe(6)
    for (const [target, bunTarget] of pairs) if (target.includes('x64')) expect(bunTarget, target).toMatch(/-baseline$/)
  })

  it('reads the C library from ldd before the loader (a glibc box may carry musl\'s loader)', () => {
    expect(lddLibc(() => ({ stdout: 'ldd (Ubuntu GLIBC 2.31-0ubuntu9) 2.31\n', stderr: '' }))).toBe('glibc')
    expect(lddLibc(() => ({ stdout: 'ldd (GNU libc) 2.17\n', stderr: '' }))).toBe('glibc')
    // musl's ldd prints its banner on stderr and exits 1.
    expect(lddLibc(() => ({ stdout: '', stderr: 'musl libc (x86_64)\nVersion 1.2.4\n', status: 1 }))).toBe('musl')
    expect(lddLibc(() => ({ stdout: '', stderr: '', error: new Error('spawnSync ldd ENOENT') }))).toBeNull()
    expect(lddLibc(() => { throw new Error('no ldd') })).toBeNull()
  })

  it('on musl, knows whether the C++ runtime the musl build links is there (to name it when the file cannot start)', () => {
    const alpine = new Set(['/usr/lib/libstdc++.so.6', '/usr/lib/libgcc_s.so.1'])
    expect(hasMuslCxxRuntime((p: string) => alpine.has(p))).toBe(true)
    expect(hasMuslCxxRuntime((p: string) => p === '/usr/lib/libgcc_s.so.1')).toBe(false)
    expect(hasMuslCxxRuntime(() => false)).toBe(false)
  })

  it('release-build.mjs checks the file of the runner it builds on', () => {
    expect(hostTarget('linux', 'x64')).toBe('linux-x64')
    expect(hostTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(hostTarget('win32', 'x64')).toBeNull()
  })
})

describe('the Homebrew formula over the files', () => {
  const urls = (rb: string) => [...rb.matchAll(/url "([^"]+)", using: :nounzip\n\s+sha256 "([0-9a-f]{64})"/g)].map((m) => ({ url: m[1]!, sha: m[2]! }))

  it('installs the release\'s .gz for each Mac and glibc Linux, each checked against the asset itself', () => {
    const rb = formula({ version: VERSION, sums: fs.readFileSync(path.join(assets, 'SHA256SUMS'), 'utf8') })
    const listed = urls(rb)
    expect(listed.map((u) => path.basename(u.url))).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map((t) => assetName(VERSION, t)))
    for (const { url, sha } of listed) {
      expect(url).toBe(`https://github.com/EvanZhang008/open-walnut/releases/download/v${VERSION}/${path.basename(url)}`)
      // The checksum is the uploaded asset's, not the plain file's inside it.
      expect(sha).toBe(sha256(path.join(assets, path.basename(url))))
    }
    expect(rb).not.toContain('musl')
    expect(rb).toMatch(/on_macos do\n {4}on_arm do\n {6}url "[^"]+darwin-arm64\.gz"/)
    expect(rb).toMatch(/on_linux do\n {4}on_arm do\n {6}url "[^"]+linux-arm64\.gz"[\s\S]*?on_intel do\n {6}url "[^"]+linux-x64\.gz"/)
    // Unpacked only after Homebrew's linkage pass, which must not touch the file.
    expect(rb).toContain('libexec.install Dir["walnut-*.gz"].first => "walnut.gz"')
    expect(rb).toContain('install_gzipped_executable "walnut.gz", "walnut", source_base: :libexec, target_base: :libexec')
    expect(rb).toContain('bin.write_exec_script libexec/"walnut"')
    // write_exec_script writes one script per target INTO the path it is called on, so on
    // bin/"open-walnut" it makes a directory, which brew does not link: the command was gone.
    expect(rb).toContain('(bin/"open-walnut").write_env_script libexec/"walnut", {}')
    expect(rb).not.toMatch(/\(bin\/"[^"]+"\)\.write_exec_script/)
    expect(rb).toContain('Update it with: brew upgrade open-walnut')
    expect(rb).toContain('assert_match version.to_s, shell_output("#{bin}/walnut --version")')
    expect(rb).not.toMatch(/depends_on|app\/bin/)
  })

  it('takes the files over the archives when a release has both, the archives when it has only those', () => {
    const both = `${fs.readFileSync(path.join(assets, 'SHA256SUMS'), 'utf8')}${'e'.repeat(64)}  open-walnut-${VERSION}-linux-x64.tar.gz\n`
    expect(formula({ version: VERSION, sums: both })).not.toContain('.tar.gz')
    const old = formula({ version: VERSION, sums: `${'e'.repeat(64)}  open-walnut-${VERSION}-linux-x64.tar.gz\n` })
    expect(old).toContain(`open-walnut-${VERSION}-linux-x64.tar.gz", using: :nounzip`)
    expect(old).toContain('libexec/"app/bin/walnut"')
    expect(() => formula({ version: '0.8.0', sums: both })).toThrow(/lists no file or archive of 0\.8\.0/)
  })

  it('is Ruby that parses', () => {
    const rb = path.join(tmp, 'open-walnut.rb')
    fs.writeFileSync(rb, formula({ version: VERSION, sums: fs.readFileSync(path.join(assets, 'SHA256SUMS'), 'utf8') }))
    expect(execFileSync('ruby', ['-c', rb], { encoding: 'utf8' })).toContain('Syntax OK')
  })
})

describe('release-attach.sh', () => {
  /**
   * A `gh` that answers `release view` with `assets` (or, with `viewFails`, fails
   * as an outage does, printing nothing) and logs every upload.
   */
  function fakeGh(assetsOnRelease: string[], { viewFails = false } = {}): { bin: string; log: string } {
    const dir = fs.mkdtempSync(path.join(tmp, 'gh-'))
    const log = path.join(dir, 'log')
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
if [ "$1 $2" = "release view" ]; then
  ${viewFails ? 'echo "HTTP 502: Bad Gateway" >&2; exit 1' : `printf '%s\\n' ${assetsOnRelease.map((a) => `'${a}'`).join(' ')}; exit 0`}
fi
if [ "$1 $2" = "release upload" ]; then shift 3; for f in "$@"; do [ "$f" = --clobber ] || basename "$f" >> "${log}"; done; exit 0; fi
exit 1
`, { mode: 0o755 })
    return { bin: dir, log }
  }
  const attach = (gh: { bin: string }) => execFileSync('/bin/sh', [path.join(ROOT, 'scripts/release-attach.sh'), `v${VERSION}`, assets], { encoding: 'utf8', env: { PATH: guardedPath([gh.bin], '/usr/bin:/bin') } })

  it('stops, uploading nothing, when GitHub cannot list the release\'s assets', () => {
    // Without pipefail, `gh release view | grep -qx SHA256SUMS` read an outage as
    // "no SHA256SUMS yet" and uploaded rebuilt bytes over a finished release.
    const gh = fakeGh([], { viewFails: true })
    const r = spawnSync('/bin/sh', [path.join(ROOT, 'scripts/release-attach.sh'), `v${VERSION}`, assets], { encoding: 'utf8', env: { PATH: guardedPath([gh.bin], '/usr/bin:/bin') } })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(`could not list v${VERSION}'s assets; nothing uploaded`)
    expect(fs.existsSync(gh.log)).toBe(false)
  })

  it('uploads every .gz and install.sh, then SHA256SUMS last', () => {
    const gh = fakeGh(['open-walnut.rb'])
    expect(attach(gh)).toContain(`attached ${TARGETS.length} files, install.sh and SHA256SUMS to v${VERSION}`)
    const uploaded = fs.readFileSync(gh.log, 'utf8').trim().split('\n')
    expect(uploaded.at(-1)).toBe('SHA256SUMS')
    expect(uploaded.slice(0, -1).sort()).toEqual([...TARGETS.map((t) => assetName(VERSION, t.target)), 'install.sh'].sort())
  })

  it('a release that has SHA256SUMS already has its files: nothing is uploaded again', () => {
    const gh = fakeGh(['SHA256SUMS', assetName(VERSION, 'linux-x64')])
    expect(attach(gh)).toContain(`v${VERSION} already has its files`)
    expect(fs.existsSync(gh.log)).toBe(false)
  })
})
