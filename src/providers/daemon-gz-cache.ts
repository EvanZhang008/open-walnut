/**
 * Where the gzipped daemon binary a remote deploy streams (daemon-connection.ts)
 * is cached. Next to the binary when the running package is writable, as it
 * always was. Otherwise (a package the server cannot write: the cloud
 * companion's code tree is root's) under the data dir, keyed by the binary's
 * path, size and mtime, so a rebuilt binary never reuses an archive of the old one.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
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
