/**
 * Every way a person gets or updates Walnut, end to end, with the real compiled
 * file (scripts/build-binary.mjs, this tree built at two versions by
 * tests/helpers/real-walnut.ts), packaged by the release's own scripts and served
 * by local stand-ins for GitHub Releases and npm. Each Walnut runs isolated
 * (scripts/release-rehearsal/walnut.mjs: its own HOME, data dir and daemon, a mock
 * `claude`, no Node or bun on its PATH). Nothing is published and nothing outside
 * the temp dirs is touched.
 *
 *   install.sh     release-files.mjs's assets on a local release server; install.sh
 *                  installs the file into a fresh HOME, and it serves.
 *   self-update    that install, started as `walnut web`, finds the newer version
 *                  on the local registry, installs it into its versions layout and
 *                  restarts as it; `walnut update` does the same from the CLI.
 *   rollback       a newer version that exits before it serves is gone back from:
 *                  the version before serves, and the next start skips the new one.
 *   npm            npm-packages.mjs's launcher and platform packages on the local
 *                  registry; `npm install -g open-walnut` installs only this
 *                  machine's platform package, `walnut --version` runs the file,
 *                  and its own update goes through npm and the launcher again.
 *
 * The other targets' files are small scripts (only this machine's ever runs).
 */
import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TARGETS, builtName, writeAssets } from '../../scripts/release-files.mjs'
import { buildPackages, packPackages } from '../../scripts/npm-packages.mjs'
import { startRegistry } from '../../scripts/release-rehearsal/registry.mjs'
import { serveReleases, systemPathWithoutNode } from '../../scripts/release-rehearsal/runtime.mjs'
import { IsolatedWalnut } from '../../scripts/release-rehearsal/walnut.mjs'
import { hostTarget, realWalnutFiles } from '../helpers/real-walnut.js'

const ROOT = path.resolve(__dirname, '../..')
const OLD = '0.9.1'
const NEW = '0.9.2'
/** A release whose file answers --version and then cannot start a server. */
const BROKEN = '0.9.3'
const HOST = hostTarget()
let work = ''
let bareDir = ''
let releases: { url: string; close: () => Promise<void> }
let registry: Awaited<ReturnType<typeof startRegistry>>
const walnuts: IsolatedWalnut[] = []

/** dist-bin as build-binary.mjs leaves it: this machine's real file, small scripts for the rest. */
function distBin(version: string, file: string): string {
  const dir = path.join(work, `dist-bin-${version}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(file, path.join(dir, builtName(HOST)))
  fs.chmodSync(path.join(dir, builtName(HOST)), 0o755)
  for (const { target } of TARGETS) {
    if (target !== HOST) fs.writeFileSync(path.join(dir, builtName(target)), `#!/bin/sh\necho '${version} (${target})'\n`, { mode: 0o755 })
  }
  return dir
}

/**
 * BROKEN on the registry: this machine's platform package, whose file prints the
 * version and exits 1 for anything else, and the open-walnut the dist-tag names.
 */
function brokenPackages(): string[] {
  const pack = (name: string, files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(work, 'broken-'))
    fs.mkdirSync(path.join(dir, 'package'))
    fs.writeFileSync(path.join(dir, 'package', 'package.json'), JSON.stringify({ name, version: BROKEN }))
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'package', file), text, { mode: 0o755 })
    const out = path.join(dir, 'package.tgz')
    execFileSync('tar', ['-czf', out, '-C', dir, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    return out
  }
  return [
    pack(`@open-walnut/${HOST}`, { walnut: `#!/bin/sh\n[ "$1" = --version ] && { echo '${BROKEN} (broken)'; exit 0; }\necho 'boom: this build cannot start' >&2\nexit 1\n` }),
    pack('open-walnut', {}),
  ]
}

/** A Walnut with nothing in its HOME, the system's own tools (no Node, no bun) plus `extra` on PATH. */
function isolated(name: string, extra: string[] = []): IsolatedWalnut {
  const w = new IsolatedWalnut({ work, name })
  w.env.PATH = [...extra, w.binDir, path.join(w.home, '.local/bin'), bareDir].join(path.delimiter)
  w.env.WALNUT_UPDATE_REGISTRY_URL = registry.distTagsUrl
  walnuts.push(w)
  return w
}

const run = (file: string, args: string[], env: Record<string, string>) => new Promise<{ code: number; out: string }>((resolve) => {
  execFile(file, args, { env, timeout: 300_000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }))
})
const installSh = (w: IsolatedWalnut) => run('/bin/sh', [path.join(ROOT, 'scripts/install.sh')], { ...w.env, OPEN_WALNUT_RELEASE_BASE_URL: releases.url, OPEN_WALNUT_RELEASES_API: `${releases.url}/none` })
const versionOf = (bin: string, env: Record<string, string>) => execFileSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 60_000 }).trim()
const serverLog = (w: IsolatedWalnut) => (fs.existsSync(w.logFile) ? fs.readFileSync(w.logFile, 'utf8') : '')

beforeAll(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-distribution-')))
  bareDir = systemPathWithoutNode(path.join(work, 'system-bin'))
  for (const name of ['bun', 'bunx']) fs.rmSync(path.join(bareDir, name), { force: true })
  const built = await realWalnutFiles([OLD, NEW])
  const oldBin = distBin(OLD, built[OLD]!)
  const newBin = distBin(NEW, built[NEW]!)
  // The release: assets as release.yml uploads them, and `latest` naming it.
  const rel = path.join(work, 'releases')
  await writeAssets({ files: oldBin, version: OLD, out: path.join(rel, `v${OLD}`) })
  fs.writeFileSync(path.join(rel, 'latest'), `${OLD}\n`)
  releases = await serveReleases(rel)
  // npm: both versions' launcher and platform packages, `latest` the older until a case moves it.
  const tarballs: string[] = []
  for (const [version, files] of [[OLD, oldBin], [NEW, newBin]] as const) {
    const dir = buildPackages({ files, version, out: path.join(work, `npm-${version}`) })
    tarballs.push(...packPackages(path.dirname(dir.launcher), path.join(work, `tgz-${version}`)))
  }
  tarballs.push(...brokenPackages())
  registry = await startRegistry({ tarballs: tarballs.map((file) => ({ file })), distTags: { latest: OLD }, upstream: 'http://127.0.0.1:9' })
}, 30 * 60_000)

afterAll(async () => {
  // Each server, then the daemon it started (the pid its own daemon dir records), and its CLIs.
  for (const w of walnuts) await w.shutdown()
  await registry?.close()
  await releases?.close()
  if (work) fs.rmSync(work, { recursive: true, force: true })
}, 120_000)

describe('the compiled file, from every way it arrives', () => {
  const printsVersion = (v: string) => new RegExp(`^${v.replace(/\./g, '\\.')} \\(`)

  it('install.sh installs this machine\'s file from the release; it serves, knows it is a binary install, and marks its version while it runs', async () => {
    const w = isolated('install-sh')
    const r = await installSh(w)
    expect(r.code, r.out).toBe(0)
    const walnut = path.join(w.home, '.local/bin/walnut')
    const share = path.join(w.home, '.local/share/open-walnut')
    expect(versionOf(walnut, w.env)).toMatch(printsVersion(OLD))
    w.fixedBin = walnut
    w.env.WALNUT_NO_AUTO_UPDATE = '1'
    const health = await w.start()
    expect(health.claudeCliAvailable, serverLog(w)).toBe(true)
    const { json: status } = await w.api('GET', '/api/system/update')
    expect(status.current).toBe(OLD)
    expect(status.install).toMatchObject({ kind: 'binary', updateCommand: 'walnut update', binary: { root: share, target: HOST, version: OLD } })
    // The card says this install updates itself on start (off here: WALNUT_NO_AUTO_UPDATE).
    expect(status.autoUpdate).toBe(false)
    const running = path.join(share, 'running')
    expect(fs.readdirSync(running).map((pid) => fs.readFileSync(path.join(running, pid), 'utf8').trim())).toEqual([OLD])
    await w.stop()
    expect(fs.readdirSync(running)).toEqual([])
  }, 300_000)

  it('started as `walnut web`, it installs the newer version from the registry and restarts as it', async () => {
    const w = isolated('self-update')
    const r = await installSh(w)
    expect(r.code, r.out).toBe(0)
    registry.setDistTags({ latest: NEW })
    try {
      const walnut = path.join(w.home, '.local/bin/walnut')
      w.fixedBin = walnut
      await w.start()
      const log = serverLog(w)
      expect((await w.api('GET', '/api/v1/status')).json?.version, log).toBe(NEW)
      expect(log).toContain(`Open Walnut ${NEW} is published (this is ${OLD}); installing it before starting.`)
      expect(log).toContain(`Installed Open Walnut ${NEW}; starting it.`)
      const share = path.join(w.home, '.local/share/open-walnut')
      expect(fs.readdirSync(path.join(share, 'versions')).sort()).toEqual([OLD, NEW])
      expect(fs.readlinkSync(path.join(share, 'bin/walnut'))).toBe(`../versions/${NEW}/walnut`)
      expect(versionOf(walnut, w.env)).toMatch(printsVersion(NEW))
      // The restarted server is the new file, sees its install, and marks the version it runs from.
      const { json: status } = await w.api('GET', '/api/system/update')
      expect(status.install).toMatchObject({ kind: 'binary', binary: { version: NEW } })
      expect(status.autoUpdate).toBe(true)
      const running = path.join(share, 'running')
      expect(fs.readdirSync(running).map((pid) => fs.readFileSync(path.join(running, pid), 'utf8').trim())).toEqual([NEW])
      expect(registry.hits).toContain(`/@open-walnut/${HOST}/${NEW}`)
      // Once it listened, it told the parent that restarted it (startup-update.ts READY_FILE_ENV).
      const ready = fs.readdirSync(w.env.TMPDIR!).filter((n) => n.startsWith(`walnut-ready-${w.server!.pid}-`))
      expect(ready).toHaveLength(1)
      expect(fs.readFileSync(path.join(w.env.TMPDIR!, ready[0]!), 'utf8').trim()).toBe(fs.readdirSync(running)[0])
    } finally {
      registry.setDistTags({ latest: OLD })
    }
  }, 300_000)

  it('a newer version that exits before it serves is gone back from; the version before serves, and the next start skips it', async () => {
    const w = isolated('rollback')
    expect((await installSh(w)).code).toBe(0)
    registry.setDistTags({ latest: BROKEN })
    try {
      w.fixedBin = path.join(w.home, '.local/bin/walnut')
      await w.start()
      const log = serverLog(w)
      expect((await w.api('GET', '/api/v1/status')).json?.version, log).toBe(OLD)
      expect(log).toContain('boom: this build cannot start')
      expect(log).toContain(`Open Walnut ${BROKEN} exited with 1 before it served; going back to ${OLD}. ${BROKEN} is skipped until a newer release is published.`)
      const share = path.join(w.home, '.local/share/open-walnut')
      expect(fs.readlinkSync(path.join(share, 'bin/walnut'))).toBe(`../versions/${OLD}/walnut`)
      expect(fs.readFileSync(path.join(share, 'bad', BROKEN), 'utf8')).toContain('exited with 1 before it served')
      await w.stop()
      // The next start installs nothing: one line, no download, the version before.
      const downloads = () => registry.hits.filter((h) => h.endsWith(`-${BROKEN}.tgz`)).length
      const before = downloads()
      expect(before).toBe(1)
      await w.start()
      expect(serverLog(w)).toContain(`Open Walnut ${BROKEN} is published, but ${BROKEN} did not start here before`)
      expect((await w.api('GET', '/api/v1/status')).json?.version).toBe(OLD)
      expect(downloads()).toBe(before)
    } finally {
      registry.setDistTags({ latest: OLD })
    }
  }, 300_000)

  it('`walnut update` from the CLI does the same, and --check only reports', async () => {
    const w = isolated('cli-update')
    expect((await installSh(w)).code).toBe(0)
    registry.setDistTags({ latest: NEW })
    try {
      const walnut = path.join(w.home, '.local/bin/walnut')
      // No server of its own to ask about: never the machine's.
      const env = { ...w.env, OPEN_WALNUT_API_URL: 'http://127.0.0.1:9' }
      const check = await run(walnut, ['update', '--check'], env)
      expect(check.code, check.out).toBe(0)
      expect(check.out).toContain('Run: walnut update')
      expect(versionOf(walnut, env)).toMatch(printsVersion(OLD))
      const up = await run(walnut, ['update'], env)
      expect(up.code, up.out).toBe(0)
      expect(up.out).toContain(`Installed Open Walnut ${NEW}.`)
      expect(versionOf(walnut, env)).toMatch(printsVersion(NEW))
    } finally {
      registry.setDistTags({ latest: OLD })
    }
  }, 300_000)

  it('`npm install -g open-walnut` installs only this machine\'s platform package, runs it, and updates through npm', async () => {
    const npm = execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim()
    const node = process.execPath
    const w = isolated('npm', [path.dirname(npm), path.dirname(node)])
    w.env.PATH = [path.join(w.prefix, 'bin'), w.env.PATH].join(path.delimiter)
    Object.assign(w.env, { npm_config_registry: `${registry.url}/`, npm_config_cache: path.join(work, 'npm-cache') })
    const installed = await run(npm, ['install', '-g', `open-walnut@${OLD}`], w.env)
    expect(installed.code, installed.out).toBe(0)
    const pkgRoot = path.join(w.prefix, 'lib/node_modules/open-walnut')
    expect(fs.readdirSync(path.join(pkgRoot, 'node_modules/@open-walnut'))).toEqual([HOST])
    const walnut = path.join(w.prefix, 'bin/walnut')
    expect(versionOf(walnut, w.env)).toMatch(printsVersion(OLD))
    // What an older start command runs (an archive's restart, an older Mac app): the same file.
    expect(execFileSync(node, [path.join(pkgRoot, 'dist/cli.js'), '--version'], { env: w.env, encoding: 'utf8' }).trim()).toMatch(printsVersion(OLD))
    registry.setDistTags({ latest: NEW })
    try {
      w.fixedBin = walnut
      await w.start()
      expect((await w.api('GET', '/api/v1/status')).json?.version, serverLog(w)).toBe(NEW)
      const { json: status } = await w.api('GET', '/api/system/update')
      expect(status.install).toMatchObject({ kind: 'npm', manager: 'npm', packageRoot: fs.realpathSync(pkgRoot) })
      expect(status.install.relaunch).toEqual([node, path.join(fs.realpathSync(pkgRoot), 'bin/open-walnut.js')])
      expect(JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version).toBe(NEW)
      expect(fs.readdirSync(path.join(pkgRoot, 'node_modules/@open-walnut'))).toEqual([HOST])
    } finally {
      registry.setDistTags({ latest: OLD })
    }
  }, 400_000)
})
