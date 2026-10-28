/**
 * The self-contained archive, rehearsed the way a user meets it: built as
 * release-archives.yml builds it (scripts/runtime-bundle/build.mjs, on Node, from
 * `open-walnut@<version>` as the registry serves it: the launcher and this
 * machine's @open-walnut/<target> file), served with its SHA256SUMS like a GitHub
 * Release, installed by scripts/install.sh into a fresh HOME, and started on a
 * PATH with NO Node on it. The launcher packages come from field-packs.mjs build
 * (field.json: the release and the one after it), served by a local registry;
 * nothing is published.
 *
 *   archive         `build.mjs --check` calls the release supported, then the
 *                   archive is built for this machine (or a built one is taken); a
 *                   release server holding it and an older release; install.sh
 *                   finds the newest, installs it, and `walnut --version` names it.
 *   archive-serve   `walnut web` answers health with `claude` found and the SPA,
 *                   and a session answers its first message, with no node or npm
 *                   on PATH; the updater says `walnut update`.
 *   archive-update  (field.json names the one after) the archive, started, updates
 *                   itself to that launcher through its own Node's npm, from a
 *                   local registry whose `latest` is it.
 *   archive-brew    (WALNUT_REHEARSAL_BREW names a brew; CI's own machines only,
 *                   never a person's Homebrew) the formula scripts/homebrew/formula.mjs
 *                   writes for it installs from a scratch tap, `brew test` passes,
 *                   and Homebrew's `walnut` names the version.
 *   archive-app     (WALNUT_REHEARSAL_APP names a built Walnut.app; macOS) the app's
 *                   first launch installs the archive with the install.sh inside it,
 *                   serves the console with no Node on PATH, takes its server down
 *                   with it, and starts again without downloading.
 */
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installedRuntime, machineArch, smokeDesktopApp } from '../desktop-smoke.mjs'
import { formula } from '../homebrew/formula.mjs'
import { startRegistry } from './registry.mjs'
import { IsolatedWalnut, runLogged } from './walnut.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const INSTALL_SH = path.join(repo, 'scripts/install.sh')
const BUILD = path.join(repo, 'scripts/runtime-bundle/build.mjs')
/** The system's own tool directories: nothing in them may be a node or an npm. */
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const npmLauncher = createRequire(import.meta.url)('../npm-launcher/launch.js')
const NODE_TOOLS = new Set(['node', 'nodejs', 'npm', 'npx', 'corepack', 'pnpm', 'yarn', 'bun'])

/** `open-walnut-<version>-<platform>-<arch>.tar.gz` → its version. */
export function archiveVersion(file) {
  const m = /^open-walnut-(.+)-(darwin|linux)-(arm64|x64)\.tar\.gz$/.exec(path.basename(file))
  if (!m) throw new Error(`${path.basename(file)} is not named like a self-contained archive`)
  return m[1]
}

/**
 * A directory of links to every system tool except Node's, so "no Node on PATH"
 * holds on a runner whose /usr/bin has one. The first directory wins a name.
 */
export function systemPathWithoutNode(dir, sources = SYSTEM_DIRS) {
  fs.mkdirSync(dir, { recursive: true })
  for (const src of sources) {
    let names = []
    try { names = fs.readdirSync(src) } catch { continue }
    for (const name of names) {
      if (NODE_TOOLS.has(name)) continue
      const link = path.join(dir, name)
      if (!fs.existsSync(link)) fs.symlinkSync(path.join(src, name), link)
    }
  }
  return dir
}

/** Serve `<root>/v<version>/<file>` the way GitHub Releases does, plus `latest/download/`. */
export function serveReleases(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '')
      if (rel.startsWith('latest/download/')) {
        const newest = fs.existsSync(path.join(root, 'latest')) ? fs.readFileSync(path.join(root, 'latest'), 'utf8').trim() : ''
        rel = `v${newest}/${rel.slice('latest/download/'.length)}`
      }
      const file = path.join(root, rel)
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-length': fs.statSync(file).size })
      fs.createReadStream(file).pipe(res)
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

/** Put an archive where serveReleases finds it, with its SHA256SUMS line; `latest` marks the newest release. */
export function publishLocally(root, version, archive, { latest = true } = {}) {
  const dir = path.join(root, `v${version}`)
  fs.mkdirSync(dir, { recursive: true })
  const name = path.basename(archive)
  fs.copyFileSync(archive, path.join(dir, name))
  const sha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  fs.appendFileSync(path.join(dir, 'SHA256SUMS'), `${sha}  ${name}\n`)
  if (latest) fs.writeFileSync(path.join(root, 'latest'), `${version}\n`)
}

/**
 * The release file a Mac app carries (scripts/desktop-carry-release.mjs takes
 * walnut-<version>-darwin-<arch> and the SHA256SUMS that lists it), for a
 * rehearsal whose release holds only the archive: the compiled file that the
 * archive installed in `runtimeDir` starts, found the way its npm launcher finds
 * it. Written under `out`, not into the served releases, so install.sh there
 * keeps installing the archive.
 */
export function carriedFileOf({ runtimeDir, version, out, arch = machineArch() }) {
  const rt = installedRuntime(runtimeDir)
  if (rt?.kind !== 'archive') throw new Error(`no installed archive in ${runtimeDir}`)
  const found = npmLauncher.findFile(npmLauncher.candidateTargets('darwin', arch), path.dirname(rt.packageJson))
  if (!found?.file) throw new Error(`the archive in ${runtimeDir} holds no compiled file for darwin-${arch}`)
  const dir = path.join(out, `v${version}`)
  fs.mkdirSync(dir, { recursive: true })
  const name = `walnut-${version}-darwin-${arch}`
  const file = path.join(dir, name)
  fs.copyFileSync(found.file, file)
  const sums = path.join(dir, 'SHA256SUMS')
  fs.writeFileSync(sums, `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${name}\n`)
  return { file, sums }
}

/** One Walnut installed by install.sh: the launcher in ~/.local/bin, no Node on PATH. */
export class ArchiveWalnut extends IsolatedWalnut {
  constructor(opts) {
    super(opts)
    // The mock `claude` first; then the system's own tools, without any Node.
    this.env.PATH = [this.binDir, systemPathWithoutNode(path.join(this.dir, 'sysbin'))].join(path.delimiter)
    delete this.env.npm_config_prefix
  }

  get bin() { return path.join(this.home, '.local', 'bin', 'walnut') }

  /** Run install.sh against a release server, as `curl ... | sh` would. */
  async installFrom(script, releaseUrl, extraEnv = {}) {
    const code = await runLogged('/bin/sh', [script], {
      env: { ...this.env, OPEN_WALNUT_RELEASE_BASE_URL: releaseUrl, OPEN_WALNUT_RELEASES_API: `${releaseUrl}/no-api`, ...extraEnv },
      cwd: this.dir, logFile: this.logFile, timeoutMs: 15 * 60_000,
    })
    if (code !== 0) throw new Error(`install.sh exited ${code} (log: ${this.logFile})`)
    if (!fs.existsSync(this.bin)) throw new Error(`install.sh left no ${this.bin}`)
  }
}

/** Does PATH hold an executable `node`? */
export function nodeOnPath(pathVar = process.env.PATH ?? '') {
  return pathVar.split(path.delimiter).some((dir) => {
    try { fs.accessSync(path.join(dir, 'node'), fs.constants.X_OK); return Boolean(dir) } catch { return false }
  })
}

/**
 * build.mjs, on Node as release-archives.yml runs it (the Node archive's builder;
 * it goes with the archives), else on this process's runtime when PATH has none.
 * Resolves to its stdout. A child this process does not wait on synchronously:
 * the registry the spec comes from is served by this process, and a sync call
 * stops it from answering, so npm inside the build would wait for it until the
 * timeout.
 */
function runBuilder(args, { env, timeoutMs, stderr }) {
  return new Promise((resolve, reject) => {
    const opts = { env, stdio: ['ignore', 'pipe', stderr] }
    const child = nodeOnPath(env.PATH) ? spawn('node', [BUILD, ...args], opts) : spawn(process.execPath, [BUILD, ...args], opts)
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`build.mjs ${args.join(' ')} ended with ${code ?? signal}${out ? `: ${out.trim().split('\n').slice(-3).join(' | ')}` : ''}`))
    })
  })
}

/** Build this machine's archive of a package spec (`open-walnut@x`, or a tarball); resolves to build.mjs's result. */
export async function buildArchive(spec, outDir, logFile, env = process.env) {
  const out = await runBuilder(['--spec', spec, '--out', outDir], { env, timeoutMs: 30 * 60_000, stderr: 'inherit' })
  fs.appendFileSync(logFile, out)
  return JSON.parse(out.trim().split('\n').pop())
}

/** `build.mjs --check` for a spec: what release-archives.yml asks before it builds one. */
export async function archiveSupported(spec, env = process.env) {
  return (await runBuilder(['--check', '--spec', spec], { env, timeoutMs: 10 * 60_000, stderr: 'ignore' })).trim()
}

/** Install the archive's formula from a scratch tap with `brew`, test it, and take it away again. */
export async function rehearseBrew(brew, { releases, version, releaseUrl, logFile }) {
  const env = {
    ...process.env,
    HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1',
  }
  const run = async (args, timeoutMs = 10 * 60_000) => {
    const code = await runLogged(brew, args, { env, cwd: releases, logFile, timeoutMs })
    if (code !== 0) throw new Error(`brew ${args.join(' ')} exited ${code} (log: ${logFile})`)
  }
  const out = (args) => execFileSync(brew, args, { env, encoding: 'utf8', timeout: 120_000 }).trim()
  const tap = 'walnut-rehearsal/test'
  const name = `${tap}/open-walnut`
  const sums = fs.readFileSync(path.join(releases, `v${version}`, 'SHA256SUMS'), 'utf8')
  await run(['tap-new', '--no-git', tap])
  try {
    const dir = path.join(out(['--repository', tap]), 'Formula')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'open-walnut.rb'), formula({ version, sums, baseUrl: releaseUrl }))
    await run(['install', name])
    const printed = execFileSync(path.join(out(['--prefix']), 'bin', 'walnut'), ['--version'], { encoding: 'utf8', timeout: 60_000 }).trim()
    if (!reports(printed, version)) throw new Error(`Homebrew's walnut says "${printed}", expected ${version}`)
    await run(['test', name])
    return `brew install ${name}: ${printed}`
  } finally {
    await runLogged(brew, ['uninstall', '--force', name], { env, cwd: releases, logFile, timeoutMs: 120_000 })
    await runLogged(brew, ['untap', '--force', tap], { env, cwd: releases, logFile, timeoutMs: 120_000 })
  }
}

const ask = (mark) => ({ text: `snapshot-clean-turn:archive answered ${mark}`, answer: `archive answered ${mark}` })
const reports = (printed, version) => printed.split(/\s/)[0] === version

/**
 * The archive scenarios. `archive` is a built archive; without one it is built
 * from `launcher` (field-packs.mjs's field.json, read by readFieldJson): its
 * release, as the local registry serves it. Its `next` runs archive-update.
 * Returns the number of scenarios it ran.
 */
export async function rehearseRuntime({ work, archive = null, launcher = null, scenario, walnuts }) {
  if (!archive && !launcher) throw new Error('rehearseRuntime needs a built archive or the launcher packages (field.json)')
  const releases = path.join(work, 'releases')
  let server = null
  let installed = null
  let ran = 0
  // The launcher and its platform packages, both versions, served under `latest` = the release.
  const registry = launcher
    ? await startRegistry({
        tarballs: [...launcher.release.tarballs, ...(launcher.next?.tarballs ?? [])].map((file) => ({ file })),
        distTags: { latest: launcher.release.version },
      })
    : null
  try {
    ran++
    const ok = await scenario('archive', async () => {
      let file = archive
      let detail = ''
      if (!file) {
        const want = launcher.release.version
        const spec = `open-walnut@${want}`
        const env = { ...process.env, npm_config_registry: `${registry.url}/` }
        const supported = await archiveSupported(spec, env)
        if (supported !== 'supported=true') throw new Error(`build.mjs --check --spec ${spec} answered "${supported}", expected supported=true`)
        const result = await buildArchive(spec, path.join(work, 'archives'), path.join(work, 'archive-build.log'), env)
        if (result.version !== want) throw new Error(`built ${result.version}, expected ${want}`)
        file = result.archive
        detail = `, ${spec} on Node ${result.node}`
      }
      const version = archiveVersion(file)
      // An older release beside it, whose archive install.sh must not pick.
      const older = path.join(work, 'older', path.basename(file).replace(version, '0.0.1'))
      fs.mkdirSync(path.dirname(older), { recursive: true })
      fs.writeFileSync(older, 'not this one')
      publishLocally(releases, '0.0.1', older, { latest: false })
      publishLocally(releases, version, file)
      server = await serveReleases(releases)
      const w = new ArchiveWalnut({ work, name: 'archive' })
      walnuts.push(w)
      await w.installFrom(INSTALL_SH, server.url)
      const v = w.version()
      if (!reports(v, version)) throw new Error(`the installed walnut says "${v}", expected ${version}`)
      installed = { w, version, archive: file }
      return `${path.basename(file)}: ${Math.round(fs.statSync(file).size / 1e6)} MB${detail}`
    })
    if (!ok) return ran
    ran++
    await scenario('archive-serve', async () => {
      const { w } = installed
      const health = await w.start()
      if (health.claudeCliAvailable !== true) throw new Error(`health reports claudeCliAvailable=${health.claudeCliAvailable}`)
      const spa = await fetch(`${w.base}/`)
      if (spa.status !== 200) throw new Error(`GET / answered ${spa.status}`)
      const update = await w.api('GET', '/api/system/update')
      const command = update.json?.install?.updateCommand
      if (command !== 'walnut update') throw new Error(`the updater would run "${command}", not "walnut update": it does not see the archive`)
      const one = ask(crypto.randomBytes(4).toString('hex'))
      const res = await w.api('POST', '/api/v1/sessions', { cwd: w.project, message: one.text })
      if (res.status !== 201 || !res.json?.sessionId) throw new Error(`POST /api/v1/sessions answered ${res.status} ${res.text.slice(0, 300)}`)
      await w.waitForAnswer(res.json.sessionId, one.answer)
      await w.shutdown()
      return 'served and answered a session with no node on PATH'
    })
    // The Mac app's first launch: it installs this archive with the install.sh
    // inside it and serves the console (scripts/desktop-smoke.mjs), once
    // downloading it from the release, once carrying it as a release's app does
    // (with no network).
    const app = process.env.WALNUT_REHEARSAL_APP
    if (app) {
      ran++
      await scenario('archive-app', async () => {
        const download = await smokeDesktopApp({ app, work: path.join(work, 'desktop-app'), version: installed.version, releaseUrl: server.url })
        // Since the Bun migration a release's app carries the compiled file, not the archive.
        const carry = carriedFileOf({
          runtimeDir: path.join(installed.w.home, '.local', 'share', 'open-walnut'),
          version: installed.version, out: path.join(work, 'carried-release'),
        })
        const carried = await smokeDesktopApp({ app, work: path.join(work, 'desktop-app-carried'), version: installed.version, carry })
        return [...download, ...carried].map((s) => `${s.name} (${Math.round(s.secs)}s)`).join('; ')
      })
    }
    const brew = process.env.WALNUT_REHEARSAL_BREW
    if (brew) {
      ran++
      await scenario('archive-brew', () => rehearseBrew(brew, { releases, version: installed.version, releaseUrl: server.url, logFile: path.join(work, 'brew.log') }))
    }
    if (!launcher?.next) return ran
    ran++
    await scenario('archive-update', async () => {
      const to = launcher.next.version
      registry.setDistTags({ latest: to })
      const w = new ArchiveWalnut({
        work, name: 'archive-update',
        extraEnv: { npm_config_registry: `${registry.url}/`, WALNUT_UPDATE_REGISTRY_URL: registry.distTagsUrl },
      })
      walnuts.push(w)
      await w.installFrom(INSTALL_SH, server.url)
      await w.start({ timeoutMs: 900_000 })
      const status = await w.api('GET', '/api/v1/status')
      if (status.json?.version !== to) throw new Error(`started ${installed.version}, serving ${status.json?.version ?? status.text.slice(0, 200)}, expected ${to}`)
      if (!reports(w.version(), to)) throw new Error(`after the update walnut says ${w.version()}`)
      // Updated in place: the archive's own prefix, still on its own Node.
      const pkg = path.join(w.home, '.local/share/open-walnut/app/runtime/lib/node_modules/open-walnut/package.json')
      if (JSON.parse(fs.readFileSync(pkg, 'utf8')).version !== to) throw new Error(`${pkg} is not ${to}`)
      await w.shutdown()
      return `${installed.version} -> ${to} through its own npm`
    })
    return ran
  } finally {
    if (server) await server.close()
    if (registry) await registry.close()
  }
}
