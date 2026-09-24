import fsp from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { withFileLock } from '../utils/file-lock.js'

export const DAEMON_OWNERSHIP_NAME = 'service-configs.json'

export interface DaemonServiceFiles {
  inspectConfig(target: string): Promise<{ present: boolean; owned: boolean }>
  readConfig(target: string): Promise<string | null>
  writeConfig(target: string, text: string): Promise<void>
  removeConfig(target: string): Promise<void>
}

// Tests only need rename / fsync to fail to simulate a crash partway through; everything else uses the real fs.
export interface DaemonServiceFileIo {
  rename(from: string, to: string): Promise<void>
  syncFile(handle: FileHandle): Promise<void>
  syncDir(dir: string): Promise<void>
}

export interface DaemonServiceFilesOptions {
  root: string
  uid: number
  configOwnerUid?: number
  configIo?: {
    write(target: string, text: string, previous: string | null): Promise<void>
    remove(target: string, previous: string): Promise<void>
  }
  io?: Partial<DaemonServiceFileIo>
}

const SHA256 = /^[0-9a-f]{64}$/

const realIo: DaemonServiceFileIo = {
  rename: (from, to) => fsp.rename(from, to),
  syncFile: (handle) => handle.sync(),
  syncDir: async (dir) => {
    const handle = await fsp.open(dir, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export function daemonOwnershipPath(root: string): string {
  return path.join(root, DAEMON_OWNERSHIP_NAME)
}

// One bad record rejects the whole file: better that install fails loudly than that we forget our own grants
// and later judge a config we wrote ourselves as foreign.
export function parseDaemonServiceOwners(raw: string): Record<string, string[]> {
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid service ownership file: expected an object of config paths')
  }
  const owners: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!path.isAbsolute(key)) {
      throw new Error(`Invalid service ownership file: ${JSON.stringify(key)} is not an absolute path`)
    }
    const hashes = typeof value === 'string' ? [value] : value
    if (!Array.isArray(hashes) || hashes.length === 0) {
      throw new Error(`Invalid service ownership file: ${JSON.stringify(key)} must map to one or more sha256 digests`)
    }
    for (const entry of hashes) {
      if (typeof entry !== 'string' || !SHA256.test(entry)) {
        throw new Error(`Invalid service ownership file: ${JSON.stringify(key)} has a value that is not a sha256 digest`)
      }
    }
    owners[key] = [...new Set(hashes as string[])]
  }
  return owners
}

// A single hash is still written as a string so old versions can read it; only the transition window of a version change uses an array.
function serializeOwners(owners: Record<string, string[]>): string {
  const plain: Record<string, string | string[]> = {}
  for (const [key, hashes] of Object.entries(owners)) {
    if (hashes.length === 1) plain[key] = hashes[0]
    else if (hashes.length > 1) plain[key] = hashes
  }
  return `${JSON.stringify(plain)}\n`
}

// O_NOFOLLOW: a symlink fails with ELOOP right away, leaving no window between "check" and "read".
async function openNoFollow(target: string): Promise<FileHandle | 'absent' | 'foreign'> {
  try {
    return await fsp.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent'
    if (code === 'ELOOP' || code === 'EMLINK') return 'foreign'
    throw error
  }
}

async function loadOwners(ownershipPath: string, uid: number): Promise<Record<string, string[]>> {
  const handle = await openNoFollow(ownershipPath)
  if (handle === 'absent') return {}
  if (handle === 'foreign') throw new Error('Service ownership file is not private')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077)) {
      throw new Error('Service ownership file is not private')
    }
    return parseDaemonServiceOwners(await handle.readFile('utf8'))
  } finally {
    await handle.close()
  }
}

async function atomicWrite(io: DaemonServiceFileIo, target: string, text: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  let landed = false
  try {
    const handle = await fsp.open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text)
      await io.syncFile(handle)
    } finally {
      await handle.close()
    }
    await io.rename(temporary, target)
    landed = true
    await io.syncDir(path.dirname(target))
  } finally {
    // Only clean up this call's own temp file; never scan for ones others left behind.
    if (!landed) await fsp.unlink(temporary).catch(() => {})
  }
}

function createFiles(
  options: DaemonServiceFilesOptions,
  owners: Record<string, string[]>,
  locked: boolean,
): DaemonServiceFiles {
  const io: DaemonServiceFileIo = { ...realIo, ...options.io }
  const ownershipPath = daemonOwnershipPath(options.root)
  const saveOwners = (): Promise<void> => atomicWrite(io, ownershipPath, serializeOwners(owners))

  const look = async (target: string): Promise<{ present: boolean; owned: boolean; text: string | null }> => {
    const handle = await openNoFollow(target)
    if (handle === 'absent') return { present: false, owned: false, text: null }
    if (handle === 'foreign') return { present: true, owned: false, text: null }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.uid !== (options.configOwnerUid ?? options.uid) || (stat.mode & 0o022)) return { present: true, owned: false, text: null }
      const text = await handle.readFile('utf8')
      // Verify exactly the bytes read this time; never go back and read them a second time.
      return { present: true, owned: (owners[target] ?? []).includes(sha256(text)), text }
    } finally {
      await handle.close()
    }
  }

  const change = <T>(what: string, run: () => Promise<T>): Promise<T> =>
    locked ? run() : Promise.reject(new Error(`${what} needs the daemon service install lock`))

  return {
    async inspectConfig(target) {
      const found = await look(target)
      return { present: found.present, owned: found.owned }
    },
    async readConfig(target) {
      const found = await look(target)
      if (!found.present) return null
      if (!found.owned) throw new Error(`${target} is not the config this tool wrote`)
      return found.text
    },
    writeConfig: (target, text) => change('Writing a service config', async () => {
      const found = await look(target)
      if (found.present && !found.owned) throw new Error('Service configuration changed during installation')
      if (!options.configIo) await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      // First claim "both the old and the new content are mine", then swap the file, then narrow to the new one: a crash at
      // any step in between leaves the on-disk content in the grant set, so we never treat our own config as foreign.
      const next = sha256(text)
      owners[target] = [...new Set([...(owners[target] ?? []), next])]
      await saveOwners()
      if (options.configIo) await options.configIo.write(target, text, found.text)
      else await atomicWrite(io, target, text)
      owners[target] = [next]
      await saveOwners()
    }),
    removeConfig: (target) => change('Removing a service config', async () => {
      const found = await look(target)
      if (!found.owned) throw new Error('Service configuration changed before removal')
      // Make the file really disappear and reach disk first, then revoke the grant: the other order leaves an unclaimed config behind.
      if (options.configIo) await options.configIo.remove(target, found.text!)
      else {
        await fsp.unlink(target)
        await io.syncDir(path.dirname(target))
      }
      delete owners[target]
      await saveOwners()
    }),
  }
}

async function checkRoot(options: DaemonServiceFilesOptions): Promise<void> {
  if (!path.isAbsolute(options.root)) throw new Error('Daemon service directory must be absolute')
  try {
    const stat = await fsp.lstat(options.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== options.uid || (stat.mode & 0o077)) {
      throw new Error('Daemon service directory is not private')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function withDaemonServiceFiles<T>(
  options: DaemonServiceFilesOptions,
  fn: (files: DaemonServiceFiles) => Promise<T>,
): Promise<T> {
  await checkRoot(options)
  const ownershipPath = daemonOwnershipPath(options.root)
  await fsp.mkdir(options.root, { recursive: true, mode: 0o700 })
  return withFileLock(ownershipPath, async () => {
    await checkRoot(options)
    const owners = await loadOwners(ownershipPath, options.uid)
    return fn(createFiles(options, owners, true))
  })
}

// status is read-only: it creates no directories, takes no lock, and refuses every write and delete.
export async function openDaemonServiceFiles(
  options: DaemonServiceFilesOptions,
): Promise<DaemonServiceFiles> {
  await checkRoot(options)
  const owners = await loadOwners(daemonOwnershipPath(options.root), options.uid)
  return createFiles(options, owners, false)
}
