/**
 * The self-contained archives: what scripts/runtime-bundle/build.mjs builds,
 * the launcher every archive starts through, the Homebrew formula written for
 * them (scripts/homebrew/formula.mjs), the rehearsal's helpers
 * (scripts/release-rehearsal/runtime.mjs), and the workflows that build,
 * smoke-test and attach them to each stable release.
 *
 * The real build (a Node download and an npm install) runs in CI: ci.yml's
 * rehearsal builds one from the commit's package on Linux and macOS, installs it
 * with install.sh, serves it with no Node on PATH, installs its formula with
 * brew and updates it; release-archives.yml does the first three for each
 * platform before upload.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { GPU_PROVIDER_LIBS, LAUNCHER, NPMRC, RUNTIME_MARKER, newestOfMajor, pruneForeignBinaries, shaFromSums, shipsNativeBinary, targetOf, updaterKnowsArchive } from '../../scripts/runtime-bundle/build.mjs'
import { archivesIn, formula } from '../../scripts/homebrew/formula.mjs'
import { BUNDLE_ID, DMG_ARCHES, cask, dmgName } from '../../scripts/homebrew/cask.mjs'
import { carriedFor, readsAutosetupKnob } from '../../scripts/desktop-smoke.mjs'
import { archiveTarget, carryRelease, isMachOHeader } from '../../scripts/desktop-carry-release.mjs'
import { archiveVersion, serveReleases, systemPathWithoutNode } from '../../scripts/release-rehearsal/runtime.mjs'
import { RUNTIME_MARKER as UPDATER_MARKER } from '../../src/core/self-update/install-kind.js'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-archives-test-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const touch = (p: string, body = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
const SHA = (c: string) => c.repeat(64)

type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> }
type Job = { needs?: string | string[]; if?: string; 'runs-on': string; permissions?: Record<string, string>; strategy?: { matrix?: { include?: Array<{ target: string; os: string }> } }; steps: Step[] }
const load = (f: string) => parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8')) as { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }

describe('build.mjs', () => {
  it('builds for macOS and Linux on arm64 and x64, under the names Node releases use', () => {
    expect(targetOf('darwin', 'arm64').name).toBe('darwin-arm64')
    expect(targetOf('linux', 'x64').name).toBe('linux-x64')
    expect(() => targetOf('win32', 'x64')).toThrow(/macOS and Linux only/)
    expect(() => targetOf('linux', 'ia32')).toThrow(/arm64 and x64 only/)
  })

  it('takes the newest release of Node 22 from the index, and its checksum from SHASUMS256.txt', () => {
    expect(newestOfMajor([{ version: 'v24.1.0' }, { version: 'v22.20.0' }, { version: 'v22.19.0' }])).toBe('22.20.0')
    expect(() => newestOfMajor([{ version: 'v24.1.0' }])).toThrow(/no Node 22/)
    const sums = `${SHA('a')}  node-v22.20.0-darwin-arm64.tar.gz\n${SHA('b')}  node-v22.20.0-linux-x64.tar.gz\n`
    expect(shaFromSums(sums, 'node-v22.20.0-linux-x64.tar.gz')).toBe(SHA('b'))
    expect(() => shaFromSums(sums, 'node-v22.20.0-linux-arm64.tar.gz')).toThrow(/not listed/)
  })

  it('marks the archive with the file the updater looks for', () => {
    expect(RUNTIME_MARKER).toBe(UPDATER_MARKER)
  })

  it('its npm never fetches a GPU provider, in the build or in any update after it', () => {
    // onnxruntime-node reads npm_config_onnxruntime_node_install; Walnut's embedder is CPU only.
    expect(NPMRC).toMatch(/^onnxruntime-node-install=skip$/m)
    const embedder = fs.readFileSync(path.join(ROOT, 'src/lib/hybrid-search/embed-worker.ts'), 'utf8')
    expect(embedder.match(/device: '([a-z]+)'/g)?.every((d) => d === "device: 'cpu'")).toBe(true)
  })

  it('refuses a package whose updater does not know the archive', () => {
    const old = path.join(tmp, 'old-pkg')
    touch(path.join(old, 'dist/cli.js'), 'console.log("0.6.2")')
    // The SPA's files are not the updater.
    touch(path.join(old, 'dist/web/static/x.js'), `"${RUNTIME_MARKER}"`)
    expect(updaterKnowsArchive(old)).toBe(false)
    const knows = path.join(tmp, 'new-pkg')
    touch(path.join(knows, 'dist/cli.js'), '')
    touch(path.join(knows, 'dist/chunks/install-kind-x1.js'), `const RUNTIME_MARKER = "${RUNTIME_MARKER}"`)
    expect(updaterKnowsArchive(knows)).toBe(true)
  })

  it('--check says whether the package npm would serve can have an archive, without building one', () => {
    const check = (marker: boolean) => {
      const pkg = path.join(tmp, `check-${marker}`)
      touch(path.join(pkg, 'package.json'), JSON.stringify({ name: 'open-walnut', version: marker ? '0.7.0' : '0.6.2' }))
      touch(path.join(pkg, 'dist/cli.js'), marker ? `const m = "${RUNTIME_MARKER}"` : '')
      const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', tmp], { cwd: pkg, encoding: 'utf8' }).trim().split('\n').pop()!
      return execFileSync(process.execPath, [path.join(ROOT, 'scripts/runtime-bundle/build.mjs'), '--check', '--spec', path.join(tmp, tgz)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    }
    expect(check(true)).toBe('supported=true\n')
    expect(check(false)).toBe('supported=false\n')
  })

  it('drops the native binaries a dependency carries for other platforms, and keeps this one\'s', () => {
    const m = path.join(tmp, 'modules')
    for (const p of ['darwin/arm64', 'darwin/x64', 'linux/arm64', 'linux/x64', 'win32/x64']) touch(path.join(m, 'onnxruntime-node/bin/napi-v6', p, 'onnxruntime_binding.node'))
    // The CUDA and TensorRT providers onnxruntime-node fetches on Linux x64 by default.
    for (const lib of GPU_PROVIDER_LIBS) touch(path.join(m, 'onnxruntime-node/bin/napi-v6/linux/x64', lib))
    for (const p of ['arm64-darwin', 'x64-darwin', 'x64-linux', 'arm64-linux', 'x64-win32']) touch(path.join(m, '@anthropic-ai/claude-agent-sdk/vendor/ripgrep', p, 'rg'))
    for (const p of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-x64-musl', 'win32-x64']) touch(path.join(m, '@homebridge/node-pty-prebuilt-multiarch/prebuilds', p, 'pty.node'))
    touch(path.join(m, '@anthropic-ai/claude-agent-sdk/vendor/ripgrep/COPYING'))
    const removed = pruneForeignBinaries(m, { platform: 'linux', arch: 'x64' })
    expect(fs.readdirSync(path.join(m, 'onnxruntime-node/bin/napi-v6'))).toEqual(['linux'])
    expect(fs.readdirSync(path.join(m, 'onnxruntime-node/bin/napi-v6/linux'))).toEqual(['x64'])
    expect(fs.readdirSync(path.join(m, 'onnxruntime-node/bin/napi-v6/linux/x64'))).toEqual(['onnxruntime_binding.node'])
    expect(fs.readdirSync(path.join(m, '@anthropic-ai/claude-agent-sdk/vendor/ripgrep')).sort()).toEqual(['COPYING', 'x64-linux'])
    expect(fs.readdirSync(path.join(m, '@homebridge/node-pty-prebuilt-multiarch/prebuilds')).sort()).toEqual(['linux-x64', 'linux-x64-musl'])
    expect(removed).toContain(path.join('onnxruntime-node/bin/napi-v6', 'win32'))
    // A second pass finds nothing left to drop.
    expect(pruneForeignBinaries(m, { platform: 'linux', arch: 'x64' })).toEqual([])
  })

  it('requires a native module to load only where its package ships that target\'s binary, judged before pruning', () => {
    // onnxruntime-node 1.24 ships no darwin/x64 (2026-10-06: 0.6.4's Intel Mac archive failed on it).
    const m = path.join(tmp, 'modules-ships')
    for (const p of ['darwin/arm64', 'linux/arm64', 'linux/x64', 'win32/x64']) touch(path.join(m, 'onnxruntime-node/bin/napi-v6', p, 'onnxruntime_binding.node'))
    expect(shipsNativeBinary(m, 'onnxruntime-node', { platform: 'darwin', arch: 'x64' })).toBe(false)
    for (const t of [{ platform: 'darwin', arch: 'arm64' }, { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }]) {
      expect(shipsNativeBinary(m, 'onnxruntime-node', t), `${t.platform}-${t.arch}`).toBe(true)
    }
    // Pruning removes the other targets' copies; the answer was taken before it.
    pruneForeignBinaries(m, { platform: 'linux', arch: 'x64' })
    expect(shipsNativeBinary(m, 'onnxruntime-node', { platform: 'darwin', arch: 'arm64' })).toBe(false)
    expect(shipsNativeBinary(path.join(tmp, 'no-such-modules'), 'onnxruntime-node', { platform: 'linux', arch: 'x64' })).toBe(false)
    // better-sqlite3 builds or fetches its own: it must always load.
    expect(shipsNativeBinary(m, 'better-sqlite3', { platform: 'darwin', arch: 'x64' })).toBe(true)
    const build = fs.readFileSync(path.join(ROOT, 'scripts/runtime-bundle/build.mjs'), 'utf8')
    const main = build.slice(build.indexOf('async function main'))
    expect(main.indexOf('shipsNativeBinary(modules')).toBeLessThan(main.indexOf('pruneForeignBinaries(modules'))
  })

  it('the launcher runs the archive\'s own Node on its own package, through any chain of links', () => {
    const root = path.join(tmp, 'archive-root')
    touch(path.join(root, 'bin/walnut'), LAUNCHER)
    fs.chmodSync(path.join(root, 'bin/walnut'), 0o755)
    // A stand-in Node that reports what it was asked to run, and the PATH it got.
    touch(path.join(root, 'runtime/bin/node'), '#!/bin/sh\necho "$1 $2"\necho "$PATH"\n')
    fs.chmodSync(path.join(root, 'runtime/bin/node'), 0o755)
    // ~/.local/bin/walnut -> (relative) a Homebrew-style link -> the launcher.
    fs.mkdirSync(path.join(tmp, 'cellar/bin'), { recursive: true })
    fs.symlinkSync(path.relative(path.join(tmp, 'cellar/bin'), path.join(root, 'bin/walnut')), path.join(tmp, 'cellar/bin/walnut'))
    fs.mkdirSync(path.join(tmp, 'local-bin'), { recursive: true })
    fs.symlinkSync(path.join(tmp, 'cellar/bin/walnut'), path.join(tmp, 'local-bin/walnut'))
    const [args, pathSeen] = execFileSync(path.join(tmp, 'local-bin/walnut'), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim().split('\n')
    expect(args).toBe(`${path.join(root, 'runtime/lib/node_modules/open-walnut/bin/open-walnut.js')} --version`)
    // Its Node goes last on PATH: one the user installed still wins.
    expect(pathSeen).toBe(`/usr/bin:/bin:${path.join(root, 'runtime/bin')}`)
  })
})

describe('formula.mjs', () => {
  const sums = [
    `${SHA('1')}  open-walnut-0.7.0-darwin-arm64.tar.gz`,
    `${SHA('2')} *open-walnut-0.7.0-darwin-x64.tar.gz`,
    `${SHA('3')}  open-walnut-0.7.0-linux-x64.tar.gz`,
    `${SHA('9')}  open-walnut-0.6.9-linux-arm64.tar.gz`,
    'not a checksum line',
  ].join('\n')

  it('reads one version\'s archives from SHA256SUMS', () => {
    expect(archivesIn(sums, '0.7.0')).toEqual({ 'darwin-arm64': SHA('1'), 'darwin-x64': SHA('2'), 'linux-x64': SHA('3') })
  })

  it('names each platform\'s archive and checksum, and only the platforms that built', () => {
    const rb = formula({ version: '0.7.0', sums })
    expect(rb).toContain('class OpenWalnut < Formula')
    expect(rb).toContain('version "0.7.0"')
    expect(rb).toMatch(/on_macos do\n {4}on_arm do\n {6}url "https:\/\/github\.com\/EvanZhang008\/open-walnut\/releases\/download\/v0\.7\.0\/open-walnut-0\.7\.0-darwin-arm64\.tar\.gz", using: :nounzip\n {6}sha256 "1{64}"/)
    expect(rb).toMatch(/on_linux do\n {4}on_intel do\n {6}url "[^"]+linux-x64\.tar\.gz", using: :nounzip\n {6}sha256 "3{64}"\n {4}end\n {2}end/)
    expect(rb).not.toContain('linux-arm64')
    expect(rb).toContain('bin.write_exec_script libexec/"app/bin/walnut", libexec/"app/bin/open-walnut"')
    expect(rb).toContain('post_install_steps do')
    expect(rb).not.toMatch(/depends_on/)
  })

  it('refuses what is not a version, and a version with no archives', () => {
    expect(() => formula({ version: 'v0.7.0"; system "x', sums })).toThrow(/not a version/)
    expect(() => formula({ version: '0.8.0', sums })).toThrow(/lists no archive/)
    // CI's rehearsal writes one for its prerelease build.
    const pre = `${SHA('4')}  open-walnut-0.7.1-rehearsal.1-linux-x64.tar.gz`
    expect(formula({ version: '0.7.1-rehearsal.1', sums: pre })).toContain('version "0.7.1-rehearsal.1"')
  })

  it('is Ruby that parses', () => {
    const rb = path.join(tmp, 'open-walnut.rb')
    fs.writeFileSync(rb, formula({ version: '0.7.0', sums }))
    expect(execFileSync('ruby', ['-c', rb], { encoding: 'utf8' })).toContain('Syntax OK')
  })
})

describe('cask.mjs', () => {
  const both = { arm64: SHA('a'), x64: SHA('b') }

  it('installs the release\'s DMG for this Mac, each checked against its own sha256', () => {
    const rb = cask({ version: '0.7.0', sha256: both })
    expect(rb).toMatch(/^cask "walnut" do$/m)
    expect(rb).toContain('version "0.7.0"')
    // Homebrew's names for the two Macs, and the DMGs mac-app.yml attaches.
    expect(rb).toContain('arch arm: "arm64", intel: "x64"')
    expect(rb).toMatch(new RegExp(`sha256 arm:\\s+"${SHA('a')}",\\s+intel: "${SHA('b')}"`))
    expect(rb).toContain('url "https://github.com/EvanZhang008/open-walnut/releases/download/v#{version}/Walnut-#{arch}.dmg"')
    expect(DMG_ARCHES.map((a) => dmgName(a.arch))).toEqual(['Walnut-arm64.dmg', 'Walnut-x64.dmg'])
    expect(rb).toContain('app "Walnut.app"')
    // Homebrew 4.x reads a bare symbol as "this or newer"; the string form is deprecated.
    expect(rb).toContain('depends_on macos: :monterey')
  })

  it('zaps only what the app itself writes, never the user\'s data or the shared runtime', () => {
    const zap = /zap trash: \[([\s\S]*?)\]/.exec(cask({ version: '0.7.0', sha256: both }))![1]!
    const paths = [...zap.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(p).toMatch(/^~\/Library\//)
    expect(paths).toContain('~/Library/Application Support/Walnut')
  })

  it('names the bundle id the release build gives the app', () => {
    const build = fs.readFileSync(path.join(ROOT, 'desktop/build-release.sh'), 'utf8')
    expect(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(build)![1]).toBe(BUNDLE_ID)
  })

  it('refuses what is not a stable version, or a missing or malformed sha256 for either DMG', () => {
    expect(() => cask({ version: '0.7.0-rehearsal.1', sha256: both })).toThrow(/not a stable version/)
    expect(() => cask({ version: 'v0.7.0"; system "x', sha256: both })).toThrow(/not a stable version/)
    expect(() => cask({ version: '0.7.0', sha256: { arm64: SHA('a'), x64: 'abc' } })).toThrow(/not a sha256 \(for Walnut-x64\.dmg\)/)
    expect(() => cask({ version: '0.7.0', sha256: { arm64: SHA('a') } })).toThrow(/for Walnut-x64\.dmg/)
    expect(() => cask({ version: '0.7.0', sha256: SHA('a') as never })).toThrow(/not a sha256/)
  })

  it('is Ruby that parses', () => {
    const rb = path.join(tmp, 'walnut.rb')
    fs.writeFileSync(rb, cask({ version: '0.7.0', sha256: both }))
    expect(execFileSync('ruby', ['-c', rb], { encoding: 'utf8' })).toContain('Syntax OK')
  })
})

describe('runtime.mjs helpers', () => {
  it('reads the version off an archive\'s name', () => {
    expect(archiveVersion('/x/open-walnut-0.7.0-darwin-arm64.tar.gz')).toBe('0.7.0')
    expect(archiveVersion('open-walnut-0.7.1-rehearsal.1-linux-x64.tar.gz')).toBe('0.7.1-rehearsal.1')
    expect(() => archiveVersion('open-walnut-0.7.0.tgz')).toThrow()
  })

  it('a system PATH without Node holds every other tool, the first directory winning', () => {
    const a = path.join(tmp, 'sys-a')
    const b = path.join(tmp, 'sys-b')
    for (const n of ['node', 'npm', 'ls', 'tar']) touch(path.join(a, n))
    for (const n of ['npx', 'tar', 'sh']) touch(path.join(b, n))
    const dir = systemPathWithoutNode(path.join(tmp, 'sysbin'), [a, b, path.join(tmp, 'missing')])
    expect(fs.readdirSync(dir).sort()).toEqual(['ls', 'sh', 'tar'])
    expect(fs.readlinkSync(path.join(dir, 'tar'))).toBe(path.join(a, 'tar'))
  })

  it('serves a release layout: versions, latest/download, nothing outside it', async () => {
    const root = path.join(tmp, 'rel')
    touch(path.join(root, 'v0.7.0/SHA256SUMS'), 'sums')
    touch(path.join(root, 'latest'), '0.7.0\n')
    touch(path.join(tmp, 'secret'), 'no')
    const server = await serveReleases(root)
    try {
      expect(await (await fetch(`${server.url}/v0.7.0/SHA256SUMS`)).text()).toBe('sums')
      expect(await (await fetch(`${server.url}/latest/download/SHA256SUMS`)).text()).toBe('sums')
      expect((await fetch(`${server.url}/v0.8.0/SHA256SUMS`)).status).toBe(404)
      expect((await fetch(`${server.url}/%2E%2E/secret`)).status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('the archive workflows', () => {
  const archives = load('release-archives.yml')
  const release = load('release.yml')

  it('builds every target build.mjs knows, each on its own machine, and smoke-tests each before upload', () => {
    const include = archives.jobs.build.strategy!.matrix!.include!
    expect(include.map((x) => x.target).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'])
    for (const { target } of include) expect(() => targetOf(...(target.split('-') as [string, string]))).not.toThrow()
    const runs = archives.jobs.build.steps.map((s) => s.run ?? '').join('\n')
    expect(runs).toContain('scripts/runtime-bundle/build.mjs --spec "open-walnut@$VERSION"')
    expect(runs).toContain('scripts/release-rehearsal/run.mjs --archive')
    expect(archives.permissions).toEqual({ contents: 'read' })
  })

  it('attaches what built, the checksums only after the archives, and stays red when a platform is missing', () => {
    const publish = archives.jobs.publish
    expect(publish.needs).toEqual(['support', 'build'])
    expect(publish.if).toBe("${{ !cancelled() && needs.support.outputs.supported == 'true' }}")
    expect(publish.permissions).toEqual({ contents: 'write' })
    const upload = publish.steps.find((s) => s.run?.includes('gh release upload'))!.run!
    expect(upload.indexOf('*.tar.gz --clobber')).toBeLessThan(upload.indexOf('SHA256SUMS install.sh --clobber'))
    expect(publish.steps.some((s) => s.if === "needs.build.result != 'success'" && s.run?.includes('exit 1'))).toBe(true)
    const brew = archives.jobs.homebrew
    expect(brew.needs).toBe('publish')
    expect(brew.steps.map((s) => s.run ?? '').join('\n')).toMatch(/brew install walnut-release\/test\/open-walnut[\s\S]*brew test[\s\S]*gh release upload "v\$VERSION" "\$RUNNER_TEMP\/open-walnut.rb"/)
  })

  it('a version whose updater predates the archive gets none, and the run stays green', () => {
    const support = archives.jobs.support
    expect(support.steps.map((s) => s.run ?? '').join('\n')).toContain('scripts/runtime-bundle/build.mjs --check --spec "open-walnut@$VERSION"')
    expect(archives.jobs.build.needs).toBe('support')
    expect(archives.jobs.build.if).toBe("needs.support.outputs.supported == 'true'")
    // The wait for npm happens once, before anything builds.
    expect(archives.jobs.build.steps.some((s) => s.name === 'A stable version npm serves')).toBe(false)
  })

  it('both stable paths start it, with the one permission that needs', () => {
    for (const name of ['stable', 'promote']) {
      const job = release.jobs[name]
      expect(job.permissions, name).toEqual({ contents: 'write', 'id-token': 'write', actions: 'write' })
      const step = job.steps.find((s) => s.run?.includes('gh workflow run release-archives.yml'))
      expect(step, name).toBeDefined()
      expect(step!.run).toContain('--ref main')
    }
    // Last in promote: a failure there never holds up main's roll.
    const steps = release.jobs.promote.steps
    expect(steps[steps.length - 1].run).toContain('gh workflow run release-archives.yml')
    expect(release.permissions!.actions).toBe('read')
  })

  it('CI rehearses the archive and its formula on every push', () => {
    const ci = load('ci.yml')
    const step = ci.jobs.rehearsal.steps.find((s) => s.run?.includes('release-rehearsal/run.mjs'))!
    expect(step.run).toContain('--runtime')
    expect(step.env!.WALNUT_REHEARSAL_BREW).toContain('/home/linuxbrew/.linuxbrew/bin/brew')
  })

  it('every push builds and runs the archive of every target a release ships, on the machine it ships from', () => {
    // 2026-10-06: the rehearsal covered darwin-arm64 and linux-x64 only, so 0.6.4's
    // darwin-x64 archive failed for the first time at release.
    const ci = load('ci.yml')
    const shipped = archives.jobs.build.strategy!.matrix!.include!
    const osOf = Object.fromEntries(shipped.map((x) => [x.target, x.os]))
    const rehearsalOs = ((ci.jobs.rehearsal.strategy!.matrix as { os: string[] }).os)
    const targets = ci.jobs['archive-targets'].strategy!.matrix!.include!
    const covered = [...shipped.filter((x) => rehearsalOs.includes(x.os)).map((x) => x.target), ...targets.map((x) => x.target)]
    expect(covered.sort()).toEqual(shipped.map((x) => x.target).sort())
    for (const { target, os } of targets) expect(os, target).toBe(osOf[target])
    const runs = ci.jobs['archive-targets'].steps.map((s) => s.run ?? '').join('\n')
    expect(runs).toMatch(/release-rehearsal\/pack\.mjs[\s\S]*runtime-bundle\/build\.mjs --spec[\s\S]*release-rehearsal\/run\.mjs --archive/)
    // It gates: CI OK needs it and fails without it.
    const gate = ci.jobs['ci-ok']
    expect(gate.needs).toContain('archive-targets')
    expect(gate.steps.map((s) => s.run ?? '').join('\n')).toContain('needs.archive-targets.result')
  })
})

describe('the Mac app', () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')
  const archives = load('release-archives.yml')
  const swift = read('desktop/BundledRuntime.swift')
  const installSh = read('scripts/install.sh')

  it('looks for the runtime where install.sh puts it, in the layout build.mjs builds', () => {
    // install.sh's defaults, and the folder it swaps each new copy into.
    expect(installSh).toContain('install_dir="${OPEN_WALNUT_INSTALL_DIR:-$HOME/.local/share/open-walnut}"')
    expect(installSh).toContain('bin_dir="${OPEN_WALNUT_BIN_DIR:-$HOME/.local/bin}"')
    expect(installSh).toContain('mv "$staging/${stem}" "$install_dir/app"')
    expect(swift).toContain('home + "/.local/share/open-walnut"')
    expect(swift).toContain('home + "/.local/bin"')
    expect(swift).toContain('installDir + "/app"')
    // build.mjs: runtime/ is the npm prefix, the package inside it, the launcher beside it.
    expect(LAUNCHER).toContain('"$root/runtime/bin/node" "$root/runtime/lib/node_modules/open-walnut/bin/open-walnut.js"')
    expect(swift).toContain('appDir + "/runtime/bin"')
    expect(swift).toContain('appDir + "/runtime/lib/node_modules/open-walnut"')
  })

  it('both builds compile it and carry the same install.sh every release attaches', () => {
    for (const script of ['desktop/build.sh', 'desktop/build-release.sh']) {
      const body = read(script)
      for (const cmd of body.split('swiftc ').slice(1)) expect(cmd.slice(0, cmd.indexOf('-framework Carbon')), script).toContain('BundledRuntime.swift')
      expect(body, script).toContain('cp "$SCRIPT_DIR/../scripts/install.sh" "$RESOURCES/install.sh"')
    }
    expect(read('scripts/test-desktop.sh')).toContain('tests/desktop/bundled-runtime-tests.swift')
  })

  it('the release build signs for notarization, and claims what its usage strings promise', () => {
    const build = read('desktop/build-release.sh')
    expect(build).toContain('codesign --force --options runtime --timestamp --entitlements "$ENTITLEMENTS"')
    expect(build).toMatch(/xcrun notarytool submit "\$file"/)
    expect(build).toContain('xcrun stapler staple "$APP_BUNDLE"')
    expect(build).toContain('xcrun stapler staple "$DMG_OUT"')
    // Never an Apple Development certificate for other people's Macs.
    expect(build).not.toMatch(/grep -o '"\\\(Developer ID Application\\\|Apple Development/)
    const entitlements = read('desktop/Walnut.entitlements')
    // Under the hardened runtime a usage string alone gets no prompt: each needs its entitlement.
    const plist = build.slice(build.indexOf('<plist'), build.indexOf('</plist>'))
    if (plist.includes('NSMicrophoneUsageDescription')) expect(entitlements).toContain('com.apple.security.device.audio-input')
    if (plist.includes('NSCalendarsUsageDescription')) expect(entitlements).toContain('com.apple.security.personal-information.calendars')
    // Granted, not merely named: each key is followed by <true/> inside the plist's one dict.
    expect(entitlements).toMatch(/^<\?xml [^>]*\?>\s*<!DOCTYPE plist [^>]*>\s*(?:<!--[\s\S]*?-->\s*)*<plist version="1\.0">\s*<dict>[\s\S]*<\/dict>\s*<\/plist>\s*$/)
    for (const key of ['com.apple.security.device.audio-input', 'com.apple.security.personal-information.calendars']) {
      expect(entitlements).toMatch(new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true/>`))
    }
  })

  it('is built after the archives it carries, signed only inside the release environment, and attached only when notarized and launched', () => {
    const app = load('mac-app.yml')
    const job = app.jobs.app as Job & { environment?: string; strategy?: { matrix: { arch: string[] } } }
    expect(job.environment).toBe('release')
    // One app, and one DMG, per Mac architecture, each carrying that build.
    expect(job.strategy?.matrix.arch).toEqual(['arm64', 'x64'])
    const mac = archives.jobs['mac-app'] as unknown as { needs: string; uses: string; secrets: string }
    expect(mac.needs).toBe('publish')
    expect(mac.uses).toBe('./.github/workflows/mac-app.yml')
    expect(mac.secrets).toBe('inherit')
    const names = job.steps.map((s) => s.name ?? s.uses ?? '')
    const at = (pattern: RegExp) => names.findIndex((n) => pattern.test(n))
    // The release's own archive for that architecture goes into the build.
    const fetched = job.steps[at(/^The release's archive/)]
    expect(fetched.run).toContain('--pattern "open-walnut-$VERSION-darwin-$ARCH.tar.gz" --pattern SHA256SUMS')
    expect(fetched.run).toContain('WALNUT_APP_RUNTIME=')
    expect(at(/^The release's archive/)).toBeLessThan(at(/^Build Walnut\.app/))
    // Smoke-launched and assessed by Gatekeeper before the upload, the keychain gone after it.
    expect(at(/^Gatekeeper opens it/)).toBeLessThan(at(/^Attach Walnut-/))
    expect(at(/^First launch installs/)).toBeLessThan(at(/^Attach Walnut-/))
    expect(job.steps[job.steps.length - 1].if).toBe('always()')
    expect(job.steps[job.steps.length - 1].run).toContain('security delete-keychain')
    const attach = job.steps.find((s) => s.name?.startsWith('Attach Walnut-'))!
    expect(attach.if).toBe("steps.signing.outputs.signed == 'true' && env.ATTACH == 'true'")
    expect(attach.run).toBe('gh release upload "v$VERSION" "desktop/Walnut-$ARCH.dmg" --clobber')
    // The cask: once both DMGs are up, from the DMGs the release holds, installed
    // by brew and assessed by Gatekeeper before walnut.rb goes up beside them.
    const caskJob = app.jobs.cask as Job & { needs: string; if: string; environment?: string }
    expect(caskJob.needs).toBe('app')
    expect(caskJob.if).toBe("needs.app.outputs.app == 'true' && needs.app.outputs.signed == 'true' && inputs.attach && inputs.app_ref == ''")
    expect(caskJob.environment).toBeUndefined()
    const caskRun = caskJob.steps.map((s) => s.run ?? '').join('\n')
    expect(caskRun).toContain('--pattern Walnut-arm64.dmg --pattern Walnut-x64.dmg')
    expect(caskRun.indexOf('brew install --cask')).toBeLessThan(caskRun.indexOf('source=Notarized Developer ID'))
    expect(caskRun.indexOf('source=Notarized Developer ID')).toBeLessThan(caskRun.indexOf('gh release upload "v$VERSION" "$RUNNER_TEMP/walnut.rb"'))
    // The secrets reach one step, as environment variables.
    const withSecrets = [...job.steps, ...caskJob.steps].filter((s) => JSON.stringify(s).includes('secrets.'))
    expect(withSecrets.map((s) => s.name)).toEqual(['Signing identity and notary key, from the release environment'])
    expect(withSecrets[0].run).not.toContain('secrets.')
    // The release's own app: built from its tag. A trial of another commit's app
    // (app_ref) goes through every check and is never attached.
    expect(job.steps[0].with).toEqual({ ref: "${{ inputs.app_ref || format('v{0}', inputs.version) }}" })
    expect((job as Job & { env: Record<string, string> }).env.ATTACH).toBe("${{ inputs.attach && inputs.app_ref == '' }}")
  })

  it('the release build carries the archive it is given, checked, and names its DMG for that architecture', () => {
    const build = read('desktop/build-release.sh')
    expect(build).toContain('node "$SCRIPT_DIR/../scripts/desktop-carry-release.mjs" --app "$APP_BUNDLE"')
    expect(build).toContain('DMG_OUT="$SCRIPT_DIR/$APP_NAME-$CARRIED_ARCH.dmg"')
    // Carried once the identity is chosen, with its binaries signed by it, and the
    // app signed again over it before it is notarized: the archive is part of what
    // is sealed, and notarization looks inside it (2026-10-11: refused for 27
    // unsigned add-ons in it).
    const carry = build.indexOf('desktop-carry-release.mjs" --app')
    expect(carry).toBeGreaterThan(build.indexOf('done <<< "$CANDIDATES"'))
    expect(build).toContain('CARRY_SIGN=(--sign "$SIGNED_WITH"')
    expect(build.indexOf('sign_app "$SIGNED_WITH"', carry)).toBeGreaterThan(carry)
    expect(build.indexOf('sign_app "$SIGNED_WITH"', carry)).toBeLessThan(build.indexOf('notarize "$APP_ZIP"'))
    // Where the app looks for it is where the carrier puts it.
    expect(swift).toContain('resources + "/release"')
    expect(swift).toContain('"open-walnut-\\(version)-darwin-\\(arch).tar.gz"')
  })

  it('carries a release for one architecture, refusing an archive its checksums do not name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-'))
    try {
      const app = path.join(dir, 'Walnut.app')
      fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true })
      const archive = path.join(dir, 'open-walnut-0.9.1-darwin-arm64.tar.gz')
      fs.writeFileSync(archive, 'stand-in archive')
      const sha = createHash('sha256').update('stand-in archive').digest('hex')
      const sums = path.join(dir, 'SHA256SUMS')
      fs.writeFileSync(sums, `${'0'.repeat(64)}  open-walnut-0.9.1-linux-x64.tar.gz\n${sha}  open-walnut-0.9.1-darwin-arm64.tar.gz\n`)
      expect(carryRelease({ app, archive, sums })).toMatchObject({ version: '0.9.1', arch: 'arm64' })
      const carried = path.join(app, 'Contents', 'Resources', 'release', 'v0.9.1')
      expect(fs.readdirSync(carried).sort()).toEqual(['SHA256SUMS', 'open-walnut-0.9.1-darwin-arm64.tar.gz'])
      // What the smoke and BundledRuntime read back: arm64 here, nothing for an Intel Mac.
      expect(carriedFor(app, 'arm64')).toEqual({ version: '0.9.1' })
      expect(carriedFor(app, 'x64')).toBeNull()
      expect(carriedFor(dir, 'arm64')).toBeNull()
      // A tampered archive, a Linux one, an unnamed one: no app carries it.
      fs.writeFileSync(archive, 'something else')
      expect(() => carryRelease({ app, archive, sums })).toThrow('does not match its SHA256SUMS entry')
      const linux = path.join(dir, 'open-walnut-0.9.1-linux-x64.tar.gz')
      fs.writeFileSync(linux, 'x')
      expect(() => carryRelease({ app, archive: linux, sums })).toThrow('is not a Mac archive')
      const other = path.join(dir, 'open-walnut-0.9.2-darwin-x64.tar.gz')
      fs.writeFileSync(other, 'x')
      expect(() => carryRelease({ app, archive: other, sums })).toThrow('names no open-walnut-0.9.2-darwin-x64.tar.gz')
      expect(archiveTarget('open-walnut-0.9.1-darwin-x64.tar.gz')).toEqual({ version: '0.9.1', arch: 'x64' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a Developer ID app carries the archive with every binary in it signed, and checksums of its own', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-sign-'))
    try {
      const top = 'open-walnut-0.9.1-darwin-arm64'
      const tree = path.join(dir, 'src', top)
      const put = (rel: string, bytes: Buffer | string) => {
        fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true })
        fs.writeFileSync(path.join(tree, rel), bytes)
      }
      const macho = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0])
      const fat = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2, 0, 0, 0, 0])
      const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0, 0, 0, 0])
      put('runtime/bin/node', macho)
      put('runtime/lib/node_modules/open-walnut/node_modules/better-sqlite3/build/Release/better_sqlite3.node', macho)
      put('runtime/lib/node_modules/open-walnut/node_modules/@esbuild/darwin-arm64/bin/esbuild', fat)
      put('runtime/lib/node_modules/open-walnut/node_modules/x/Thing.class', javaClass)
      put('runtime/lib/node_modules/open-walnut/package.json', '{}')
      fs.symlinkSync('better_sqlite3.node', path.join(tree, 'runtime/lib/node_modules/open-walnut/node_modules/better-sqlite3/build/Release/link.node'))
      const archive = path.join(dir, `${top}.tar.gz`)
      execFileSync('tar', ['-czf', archive, '-C', path.join(dir, 'src'), top])
      const sums = path.join(dir, 'SHA256SUMS')
      fs.writeFileSync(sums, `${createHash('sha256').update(fs.readFileSync(archive)).digest('hex')}  ${top}.tar.gz\n`)
      const app = path.join(dir, 'Walnut.app')
      fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true })

      // Node comes signed for notarization by its project; the rest is unsigned.
      const calls: string[][] = []
      const codesign = (args: string[], opts?: { probe?: boolean }) => {
        calls.push(args)
        if (!opts?.probe) { fs.appendFileSync(args.at(-1)!, 'SIGNED'); return '' }
        return args.at(-1)!.endsWith('/bin/node')
          ? 'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+7 location=embedded\nAuthority=Developer ID Application: Node.js Foundation (TEAMID)\nTimestamp=Sep 23, 2026\n'
          : `${args.at(-1)}: code object is not signed at all\n`
      }
      const out = carryRelease({ app, archive, sums, identity: 'Developer ID Application: Example (TEAMID)', keychain: '/k.keychain-db', codesign })
      expect(out.signed.sort()).toEqual([
        `${top}/runtime/lib/node_modules/open-walnut/node_modules/@esbuild/darwin-arm64/bin/esbuild`,
        `${top}/runtime/lib/node_modules/open-walnut/node_modules/better-sqlite3/build/Release/better_sqlite3.node`,
      ])
      const signs = calls.filter((a) => a[0] === '--force')
      expect(signs).toHaveLength(2)
      expect(signs[0].slice(0, 6)).toEqual(['--force', '--options', 'runtime', '--timestamp', '--keychain', '/k.keychain-db'])
      expect(signs[0].slice(6, 8)).toEqual(['--sign', 'Developer ID Application: Example (TEAMID)'])

      // The carried archive holds the signed binaries; its checksums are its own.
      const carried = path.join(app, 'Contents', 'Resources', 'release', 'v0.9.1')
      const name = `${top}.tar.gz`
      const sumsLine = fs.readFileSync(path.join(carried, 'SHA256SUMS'), 'utf8')
      expect(sumsLine).toBe(`${createHash('sha256').update(fs.readFileSync(path.join(carried, name))).digest('hex')}  ${name}\n`)
      const back = path.join(dir, 'back')
      fs.mkdirSync(back)
      execFileSync('tar', ['-xzf', path.join(carried, name), '-C', back])
      const rel = (p: string) => fs.readFileSync(path.join(back, top, p))
      expect(rel('runtime/lib/node_modules/open-walnut/node_modules/better-sqlite3/build/Release/better_sqlite3.node').toString('latin1')).toMatch(/SIGNED$/)
      expect(rel('runtime/bin/node').equals(macho)).toBe(true)
      expect(rel('runtime/lib/node_modules/open-walnut/node_modules/x/Thing.class').equals(javaClass)).toBe(true)
      expect(fs.lstatSync(path.join(back, top, 'runtime/lib/node_modules/open-walnut/node_modules/better-sqlite3/build/Release/link.node')).isSymbolicLink()).toBe(true)
      // The release's own archive is untouched.
      expect(createHash('sha256').update(fs.readFileSync(archive)).digest('hex')).toBe(fs.readFileSync(sums, 'utf8').split(' ')[0])
      expect(isMachOHeader(javaClass)).toBe(false)
      expect(isMachOHeader(fat)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('judges a release with the checks of the workflow\'s own commit, never the tag\'s', () => {
    // 2026-10-07: two fixes to scripts/desktop-smoke.mjs landed on main, and the
    // 0.6.5 job kept failing the old way: it ran the smoke from the v0.6.5 checkout.
    const job = load('mac-app.yml').jobs.app as Job
    const harness = job.steps.find((s) => s.uses?.startsWith('actions/checkout') && (s.with as Record<string, string> | undefined)?.path === 'harness')
    expect(harness?.with).toEqual({ ref: '${{ github.sha }}', path: 'harness' })
    const smoke = job.steps.find((s) => /node \S*desktop-smoke\.mjs/.test(s.run ?? ''))!
    expect(smoke.run).toMatch(/node harness\/scripts\/desktop-smoke\.mjs /)
    // Any node script a step runs from the tag's tree is the release's own code, not a check.
    for (const s of job.steps) {
      for (const m of (s.run ?? '').matchAll(/\bnode (\S+\.mjs)/g)) expect(m[1], s.name).toMatch(/^harness\//)
    }
  })

  it('starts an app older than the harness unattended, and a newer one with no knob', () => {
    // 2026-10-11: the 0.6.8 app, built from a commit before the no-click first
    // launch, sat on its setup choice for 20 minutes under main's smoke, which no
    // longer passed WALNUT_DESKTOP_AUTOSETUP. A release's app may be days older than main.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-knob-'))
    try {
      const older = path.join(dir, 'older'), newer = path.join(dir, 'newer')
      fs.writeFileSync(older, Buffer.concat([Buffer.alloc(4096), Buffer.from('WALNUT_DESKTOP_AUTOSETUP\0'), Buffer.alloc(4096)]))
      fs.writeFileSync(newer, Buffer.concat([Buffer.alloc(4096), Buffer.from('WALNUT_DESKTOP_PORTS\0'), Buffer.alloc(4096)]))
      expect(readsAutosetupKnob(older)).toBe(true)
      expect(readsAutosetupKnob(newer)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    // The app main builds starts by itself, so the smoke runs it with no knob and proves it.
    for (const f of fs.readdirSync(path.join(ROOT, 'desktop')).filter((n) => n.endsWith('.swift'))) {
      expect(fs.readFileSync(path.join(ROOT, 'desktop', f), 'utf8'), f).not.toContain('WALNUT_DESKTOP_AUTOSETUP')
    }
  })

  it('CI launches the app on every push, on the archive the rehearsal builds', () => {
    const ci = load('ci.yml')
    const steps = ci.jobs.rehearsal.steps
    expect(steps.find((s) => s.name === 'Build the Mac app')!.run).toBe('bash scripts/test-desktop.sh && bash desktop/build.sh')
    expect(steps.find((s) => s.run?.includes('release-rehearsal/run.mjs'))!.env!.WALNUT_REHEARSAL_APP).toContain('desktop/Walnut.app')
  })
})
