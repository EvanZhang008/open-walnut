/**
 * The package this Mac sends its cloud companion through `/bridge/build`
 * (wire.ts): this Mac's own build as the compiled walnut file for the box's
 * system, the same file every host server of this Mac runs (host-file.ts), plus
 * the small entry every box starts a build through (shim.ts):
 *
 *   <id>-companion-<platform>-<arch>.tgz
 *     package/walnut         the compiled walnut file for the box's target
 *     package/dist/cli.js    starts ../walnut (any box runs `<runtime> dist/cli.js`)
 *
 * No dependencies: the box installs nothing besides the file. A box set up
 * before the compiled file existed takes the package as the dist it always took
 * (its npm step has nothing to install, its `--version` check, smoke boot and
 * launcher reach the file through dist/cli.js), so it moves to the file with no
 * step on the box. Built once per build id and kept in the data dir's cache.
 */

import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { WALNUT_HOME } from '../../constants.js'
import type { HostFileSource } from '../host-server/host-file.js'
import type { HostFileTarget } from '../host-server/host-target.js'
import { COMPANION_FILE_NAME, COMPANION_SHIM_JS } from './shim.js'

export interface CompanionPackage {
  /** Names this build: version and commit (the box names the build it runs the same way). */
  id: string
  version: string
  commit: string | null
  /** Always empty: the file needs nothing installed beside it. */
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
  /** The install request's dependency set name: the one empty set every package shares. */
  companionDepsHash: string
  /** The `package.json` the build's directory gets on the box. */
  appPackageJson: string
  tgz: Buffer
  /** sha256 of the unpacked walnut file. */
  fileSha256: string
}

/** Keep the newest few packages. */
const KEEP_PACKAGES = 3
const PACKAGE_FILE = /-companion-[a-z0-9]+-[a-z0-9]+\.tgz$/

/** The one dependency set of every file package: nothing. */
export const EMPTY_DEPS_HASH = crypto.createHash('sha256').update(JSON.stringify([[], []])).digest('hex').slice(0, 16)

const gunzip = promisify(zlib.gunzip)
const cacheDir = (): string => path.join(WALNUT_HOME, 'cache', 'host-server')

async function defaultSource(): Promise<HostFileSource> {
  // Lazily: the host-server manager module pulls in the expose runtime.
  return (await import('../host-server/index.js')).sharedHostFileSource()
}

/**
 * The walnut file target a companion box runs. A box answers its Node-style
 * platform and arch; companions run a glibc Linux (Amazon Linux, Debian, Ubuntu:
 * scripts/cloud/setup.sh), and a test companion may be this Mac.
 */
export function companionTarget(platform: string, arch: string): HostFileTarget {
  if (platform !== 'linux' && platform !== 'darwin') throw new Error(`The cloud companion runs on ${platform}; the walnut file is built for linux and darwin only.`)
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`The cloud companion runs on ${arch}; the walnut file is built for x64 and arm64 only.`)
  return `${platform}-${arch}`
}

/**
 * The oldest Node a box may start the package's dist/cli.js with: the shim is an
 * ES module with `node:` imports. Every box scripts/cloud/setup.sh made has
 * Node 22 or bun (which reports a current Node version).
 */
export const SHIM_MIN_NODE_MAJOR = 16

/**
 * Why a box cannot run this Mac's companion package, or null when it can: its
 * system has a walnut file (companionTarget), and the runtime it reports in
 * `node` (wire.ts BoxBuildStatus) starts the shim. The Mac sends nothing to a
 * box this says no to.
 */
export function boxRunsPackage(box: { platform: string; arch: string; node?: string | null }): string | null {
  try { companionTarget(box.platform, box.arch) } catch (err) { return err instanceof Error ? err.message : String(err) }
  const major = /^v(\d+)\./.exec(box.node ?? '')?.[1]
  if (!major) return `The cloud companion did not say which Node it runs (${JSON.stringify(box.node ?? null)}), so this Mac does not send it a build.`
  if (Number(major) < SHIM_MIN_NODE_MAJOR) {
    return `The cloud companion runs Node ${box.node}, and the build this Mac sends starts with Node ${SHIM_MIN_NODE_MAJOR} or newer, or bun. Run scripts/cloud/setup.sh on the box again: it moves the box to bun.`
  }
  return null
}

/** The id this Mac's build installs under on the companion; throws, saying why, when it has none to send. */
export async function companionBuildId(source?: HostFileSource): Promise<string> {
  return (await (source ?? await defaultSource()).buildId()).id
}

function tar(args: string[], cwd: string): Promise<void> {
  // COPYFILE_DISABLE: bsdtar on macOS would add an AppleDouble `._` member for every
  // file with extended attributes, and a box unpacks them beside the build.
  const env = { ...process.env, COPYFILE_DISABLE: '1' }
  return new Promise((resolve, reject) => {
    execFile('tar', args, { cwd, env, timeout: 300_000, maxBuffer: 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`tar failed: ${String(stderr || err.message).trim().slice(-300)}`))
      else resolve()
    })
  })
}

async function pruneCache(dir: string): Promise<void> {
  const names = (await fs.promises.readdir(dir)).filter((n) => PACKAGE_FILE.test(n))
  const aged = await Promise.all(names.map(async (n) => {
    try { return { n, t: (await fs.promises.stat(path.join(dir, n))).mtimeMs } } catch { return null }
  }))
  const present = aged.filter((a): a is { n: string; t: number } => a !== null).sort((a, b) => b.t - a.t)
  for (const { n } of present.slice(KEEP_PACKAGES)) {
    await fs.promises.rm(path.join(dir, n), { force: true })
    await fs.promises.rm(path.join(dir, `${n}.json`), { force: true })
  }
}

/**
 * This Mac's build as the companion package for a box of `platform`-`arch`.
 * `say` hears how getting the file goes (a build in a clone takes about a minute).
 */
export async function buildCompanionPackage(
  box: { platform: string; arch: string },
  opts: { source?: HostFileSource; say?: (message: string) => void } = {},
): Promise<CompanionPackage> {
  const { platform, arch } = box
  const target = companionTarget(platform, arch)
  const source = opts.source ?? await defaultSource()
  const file = await source.file(target, opts.say)
  const dir = cacheDir()
  const name = `${file.id}-companion-${platform}-${arch}.tgz`
  const cached = path.join(dir, name)
  const metaFile = `${cached}.json`
  const facts = {
    id: file.id,
    version: file.version,
    commit: file.commit,
    dependencies: {},
    optionalDependencies: {},
    companionDepsHash: EMPTY_DEPS_HASH,
    appPackageJson: JSON.stringify({ name: 'open-walnut', version: file.version, private: true, type: 'module' }, null, 2),
    fileSha256: file.sha256,
  }
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaFile, 'utf8')) as { fileSha256?: string }
    if (meta.fileSha256 === file.sha256) return { ...facts, tgz: await fs.promises.readFile(cached) }
  } catch { /* pack it */ }

  await fs.promises.mkdir(dir, { recursive: true })
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'walnut-companion-pack-'))
  try {
    const pkg = path.join(work, 'package')
    await fs.promises.mkdir(path.join(pkg, 'dist'), { recursive: true })
    const walnut = path.join(pkg, COMPANION_FILE_NAME)
    // Off the event loop (zlib's thread pool): the file is over 100 MB unpacked.
    await fs.promises.writeFile(walnut, await gunzip(file.gz), { mode: 0o755 })
    await fs.promises.chmod(walnut, 0o755)
    await fs.promises.writeFile(path.join(pkg, 'dist', 'cli.js'), COMPANION_SHIM_JS, { mode: 0o755 })
    const out = path.join(work, 'app.tgz')
    await tar(['-czf', out, 'package'], work)
    const tgz = await fs.promises.readFile(out)
    await fs.promises.writeFile(`${cached}.tmp`, tgz)
    await fs.promises.rename(`${cached}.tmp`, cached)
    await fs.promises.writeFile(`${metaFile}.tmp`, JSON.stringify({ fileSha256: file.sha256 }))
    await fs.promises.rename(`${metaFile}.tmp`, metaFile)
    await pruneCache(dir)
    return { ...facts, tgz }
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true })
  }
}
