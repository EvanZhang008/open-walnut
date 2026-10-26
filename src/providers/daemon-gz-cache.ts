/**
 * Where the gzipped daemon binary a remote deploy streams (daemon-connection.ts)
 * is cached. Next to the binary when the running package is writable, as it
 * always was. Otherwise (a package the server cannot write: the cloud
 * companion's code tree is root's) under the data dir, keyed by the binary's
 * path, size and mtime, so a rebuilt binary never reuses an archive of the old one.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'

export async function daemonGzCachePath(binaryPath: string): Promise<string> {
  try {
    await fsp.access(path.dirname(binaryPath), fsp.constants.W_OK)
    return `${binaryPath}.gz`
  } catch { /* read-only package: fall through to the data dir */ }
  const st = await fsp.stat(binaryPath)
  const key = crypto.createHash('sha256')
    .update(`${path.resolve(binaryPath)}:${st.size}:${st.mtimeMs}`)
    .digest('hex')
    .slice(0, 12)
  const dir = path.join(WALNUT_HOME, 'cache', 'daemon-binaries')
  const name = `${path.basename(binaryPath)}-${key}.gz`
  await fsp.mkdir(dir, { recursive: true })
  // Archives of earlier builds of this binary are dead weight.
  for (const entry of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (entry !== name && entry.startsWith(`${path.basename(binaryPath)}-`) && entry.endsWith('.gz')) {
      await fsp.rm(path.join(dir, entry), { force: true }).catch(() => {})
    }
  }
  log.session.debug('daemon binary archive cached under the data dir (read-only package)', {
    binary: binaryPath, archive: path.join(dir, name),
  })
  return path.join(dir, name)
}

/** Archives being built in this process, by archive path. */
const building = new Map<string, Promise<string>>()

/**
 * The gzipped archive of `binaryPath`, built when missing or of another build.
 * A stamp beside it (`<archive>.key`) records the binary's size and mtime: the
 * archive next to a writable binary used to be reused whatever the binary
 * became, so a rebuilt binary shipped the old daemon, which reported the old
 * version, and every connect uploaded it again. Equality, not order: a binary
 * copied in with its build time kept (tar, `cp -p`) is older than the archive.
 * Built aside under a unique name and renamed after gzip exits 0, so neither a
 * killed gzip nor two deploys at once can leave a short archive in place.
 */
export function ensureDaemonGz(binaryPath: string): Promise<string> {
  return (async () => {
    const gzPath = await daemonGzCachePath(binaryPath)
    const pending = building.get(gzPath)
    if (pending) return pending
    const job = buildIfStale(binaryPath, gzPath).finally(() => building.delete(gzPath))
    building.set(gzPath, job)
    return job
  })()
}

async function buildIfStale(binaryPath: string, gzPath: string): Promise<string> {
  const st = await fsp.stat(binaryPath)
  const key = `${st.size}:${st.mtimeMs}`
  const stampPath = `${gzPath}.key`
  const [stamp, archive] = await Promise.all([
    fsp.readFile(stampPath, 'utf-8').catch(() => null),
    fsp.stat(gzPath).catch(() => null),
  ])
  if (archive && stamp === key) return gzPath
  const tmp = `${gzPath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  try {
    await gzipTo(binaryPath, tmp)
    await fsp.rename(tmp, gzPath)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  await fsp.writeFile(stampPath, key)
  return gzPath
}

function gzipTo(src: string, dest: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest)
    const gzip = spawn('gzip', ['-c', src], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    gzip.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    gzip.stdout!.pipe(out)
    let exit: number | null | undefined
    let flushed = false
    const settle = () => {
      if (exit === undefined || !flushed) return
      if (exit === 0) resolve()
      else reject(new Error(`gzip of ${src} exited ${exit}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    }
    gzip.on('close', (code) => { exit = code; settle() })
    out.on('finish', () => { flushed = true; settle() })
    gzip.on('error', reject)
    out.on('error', reject)
  })
}
