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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { GPU_PROVIDER_LIBS, LAUNCHER, NPMRC, RUNTIME_MARKER, newestOfMajor, pruneForeignBinaries, shaFromSums, targetOf, updaterKnowsArchive } from '../../scripts/runtime-bundle/build.mjs'
import { archivesIn, formula } from '../../scripts/homebrew/formula.mjs'
import { archiveVersion, serveReleases, systemPathWithoutNode } from '../../scripts/release-rehearsal/runtime.mjs'
import { RUNTIME_MARKER as UPDATER_MARKER } from '../../src/core/self-update/install-kind.js'

const ROOT = path.resolve(__dirname, '../..')
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-archives-test-')))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const touch = (p: string, body = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
const SHA = (c: string) => c.repeat(64)

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
  type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> }
  type Job = { needs?: string | string[]; if?: string; 'runs-on': string; permissions?: Record<string, string>; strategy?: { matrix?: { include?: Array<{ target: string; os: string }> } }; steps: Step[] }
  const load = (f: string) => parseYaml(fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8')) as { on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job> }
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
})
