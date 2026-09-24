import { createHash, randomBytes } from 'node:crypto'
import { constants as FS, type Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'

export const DAEMON_ARTIFACT_NAME = 'daemon'
export const DAEMON_ARTIFACT_VERSIONS_DIR = 'versions'
export const DAEMON_SERVICE_ARGS: readonly string[] = ['--service']

const DIR_MODE = 0o700
const FILE_MODE = 0o700
const READ_CHUNK = 1 << 20
const NOFOLLOW = typeof FS.O_NOFOLLOW === 'number' ? FS.O_NOFOLLOW : 0
const ONLY_DIR = typeof FS.O_DIRECTORY === 'number' ? FS.O_DIRECTORY : 0
const READ_FLAGS = FS.O_RDONLY | NOFOLLOW
const FILE_SYNC_FLAGS = FS.O_RDWR | NOFOLLOW
const DIR_SYNC_FLAGS = FS.O_RDONLY | NOFOLLOW | ONLY_DIR

export type DaemonArtifactErrorCode =
  | 'invalidInput' | 'unusableSource' | 'unusableInstallRoot' | 'stageFailed' | 'versionConflict'

export class DaemonArtifactError extends Error {
  readonly code: DaemonArtifactErrorCode

  constructor(code: DaemonArtifactErrorCode, message: string, cause?: unknown) {
    super(`daemon service artifact: ${message}`, cause === undefined ? undefined : { cause })
    this.name = 'DaemonArtifactError'
    this.code = code
  }
}

export interface StageDaemonServiceArtifactInput { sourceExecutable: string; installRoot: string }

export interface StagedDaemonServiceArtifact { executable: string; args: string[]; version: string }

interface FileFacts { sha: string; size: number; mode: number; uid: number; head: Buffer }

function fail(code: DaemonArtifactErrorCode, message: string, cause?: unknown): never {
  throw new DaemonArtifactError(code, message, cause)
}

function modeText(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function checkAbsolute(label: string, value: unknown, code: DaemonArtifactErrorCode): string {
  if (typeof value !== 'string' || value.length === 0) fail(code, `${label} must be a non-empty string`)
  if (hasControlChar(value)) fail(code, `${label} must not contain control characters`)
  if (value !== value.trim()) fail(code, `${label} must not have leading or trailing whitespace`)
  if (!value.startsWith('/')) fail(code, `${label} must be an absolute path, got ${JSON.stringify(value)}`)
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') fail(code, `${label} must not contain "." or ".." segments`)
  }
  return value
}

// Refuse any foreign directory or file; never chmod or chown something that belongs to someone else.
function checkOwned(target: string, facts: { uid: number; mode: number }, code: DaemonArtifactErrorCode): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && facts.uid !== uid) {
    fail(code, `${target} is owned by uid ${facts.uid}, not this user (uid ${uid}); move it aside yourself`)
  }
  if ((facts.mode & 0o077) !== 0) {
    fail(code, `${target} is mode ${modeText(facts.mode)}; group and other must have no access`)
  }
}

export function daemonArtifactVersionsDir(installRoot: string): string {
  return path.join(checkAbsolute('installRoot', installRoot, 'invalidInput'), DAEMON_ARTIFACT_VERSIONS_DIR)
}

export function daemonArtifactExecutable(installRoot: string, version: string): string {
  if (!/^[0-9a-f]{64}$/.test(version)) {
    fail('invalidInput', `version must be a sha256 digest, got ${JSON.stringify(version)}`)
  }
  return path.join(daemonArtifactVersionsDir(installRoot), version, DAEMON_ARTIFACT_NAME)
}

async function lstatOrNull(target: string, code: DaemonArtifactErrorCode): Promise<Stats | null> {
  try {
    return await fsp.lstat(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail(code, `cannot inspect ${target}`, err)
  }
}

// O_NOFOLLOW + fstat: never follow a symlink when reading the target, and never read the whole binary into memory.
async function readFacts(target: string, code: DaemonArtifactErrorCode): Promise<FileFacts> {
  const handle = await fsp.open(target, READ_FLAGS).catch((err) => fail(code, `cannot open ${target}`, err))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) fail(code, `${target} is not a regular file`)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(READ_CHUNK)
    let size = 0
    let head = Buffer.alloc(0)
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      if (size === 0) head = Buffer.from(chunk.subarray(0, Math.min(4, bytesRead)))
      hash.update(chunk)
      size += bytesRead
    }
    return { sha: hash.digest('hex'), size, mode: stat.mode & 0o777, uid: stat.uid, head }
  } finally {
    await handle.close().catch(() => {})
  }
}

// Flush to disk both before and after publishing: a failed flush must become a failure, never be treated as published.
async function syncPath(target: string, flags: number): Promise<void> {
  const unflushed = (err: unknown): never => fail('stageFailed', `cannot flush ${target} to disk`, err)
  const handle = await fsp.open(target, flags).catch(unflushed)
  try {
    await handle.sync()
  } catch (err) {
    unflushed(err)
  } finally {
    await handle.close().catch(() => {})
  }
}

async function readSource(requested: string): Promise<{ source: string; facts: FileFacts }> {
  const source = await fsp
    .realpath(requested)
    .catch((err) => fail('unusableSource', `no daemon binary at ${requested}`, err))
  const facts = await readFacts(source, 'unusableSource')
  if (facts.size === 0) fail('unusableSource', `${requested} is empty`)
  if (facts.head.subarray(0, 2).toString('latin1') === '#!') {
    fail('unusableSource', `${requested} is an interpreter script; the service needs a prebuilt standalone binary`)
  }
  return { source, facts }
}

async function checkedDir(target: string, code: DaemonArtifactErrorCode): Promise<Stats | null> {
  const stat = await lstatOrNull(target, code)
  if (!stat) return null
  if (stat.isSymbolicLink()) fail(code, `${target} is a symlink; point it at a real directory`)
  if (!stat.isDirectory()) fail(code, `${target} is not a directory`)
  checkOwned(target, stat, code)
  return stat
}

async function ensureVersionsDir(installRoot: string): Promise<string> {
  await checkedDir(installRoot, 'unusableInstallRoot')
  const versions = path.join(installRoot, DAEMON_ARTIFACT_VERSIONS_DIR)
  await checkedDir(versions, 'unusableInstallRoot')
  try {
    await fsp.mkdir(versions, { recursive: true, mode: DIR_MODE })
  } catch (err) {
    fail('unusableInstallRoot', `cannot create ${versions}`, err)
  }
  // Re-check after mkdir, because it is a silent no-op on an existing directory; confirm the shape ourselves.
  for (const dir of [installRoot, versions]) {
    const shape = await checkedDir(dir, 'unusableInstallRoot')
    if (!shape) fail('unusableInstallRoot', `${dir} vanished while being created`)
  }
  return versions
}

async function assertPublished(versionDir: string, executable: string, sha: string): Promise<void> {
  const dir = await lstatOrNull(versionDir, 'versionConflict')
  if (!dir || dir.isSymbolicLink() || !dir.isDirectory()) {
    fail('versionConflict', `${versionDir} is not a real directory`)
  }
  if ((dir.mode & 0o777) !== DIR_MODE) {
    fail('versionConflict', `${versionDir} is mode ${modeText(dir.mode)}, expected ${modeText(DIR_MODE)}`)
  }
  checkOwned(versionDir, dir, 'versionConflict')
  const file = await lstatOrNull(executable, 'versionConflict')
  if (!file) fail('versionConflict', `${versionDir} exists without ${DAEMON_ARTIFACT_NAME}`)
  if (file.isSymbolicLink()) fail('versionConflict', `${executable} is a symlink`)
  const facts = await readFacts(executable, 'versionConflict')
  if (facts.sha !== sha) fail('versionConflict', `${executable} hashes ${facts.sha}, expected ${sha}`)
  if (facts.mode !== FILE_MODE) {
    fail('versionConflict', `${executable} is mode ${modeText(facts.mode)}, expected ${modeText(FILE_MODE)}`)
  }
  checkOwned(executable, facts, 'versionConflict')
}

export async function stageDaemonServiceArtifact(
  input: StageDaemonServiceArtifactInput,
): Promise<StagedDaemonServiceArtifact> {
  const requested = checkAbsolute('sourceExecutable', input?.sourceExecutable, 'invalidInput')
  const installRoot = checkAbsolute('installRoot', input?.installRoot, 'invalidInput')

  const { source, facts } = await readSource(requested)
  const versions = await ensureVersionsDir(installRoot)
  const versionDir = path.join(versions, facts.sha)
  const executable = path.join(versionDir, DAEMON_ARTIFACT_NAME)
  const staged = (): StagedDaemonServiceArtifact => ({ executable, args: [...DAEMON_SERVICE_ARGS], version: facts.sha })

  if (await lstatOrNull(versionDir, 'versionConflict')) {
    await assertPublished(versionDir, executable, facts.sha)
    await syncPath(executable, FILE_SYNC_FLAGS)
    await syncPath(versionDir, DIR_SYNC_FLAGS)
    await syncPath(versions, DIR_SYNC_FLAGS)
    return staged()
  }

  const staging = path.join(versions, `.staging-${facts.sha.slice(0, 12)}-${randomBytes(6).toString('hex')}`)
  try {
    await fsp.mkdir(staging, { mode: DIR_MODE })
  } catch (err) {
    fail('stageFailed', `cannot create the staging directory ${staging}`, err)
  }

  try {
    const stagedFile = path.join(staging, DAEMON_ARTIFACT_NAME)
    try {
      await fsp.chmod(staging, DIR_MODE)
      await fsp.copyFile(source, stagedFile, FS.COPYFILE_EXCL)
      await fsp.chmod(stagedFile, FILE_MODE)
    } catch (err) {
      fail('stageFailed', `cannot copy ${source} into ${staging}`, err)
    }
    const copied = await readFacts(stagedFile, 'stageFailed')
    if (copied.sha !== facts.sha || copied.size !== facts.size) {
      fail('stageFailed', `the copy hashes ${copied.sha} (${copied.size}B), expected ${facts.sha} (${facts.size}B)`)
    }
    if (copied.mode !== FILE_MODE) {
      fail('stageFailed', `the copy is mode ${modeText(copied.mode)}, expected ${modeText(FILE_MODE)}`)
    }
    checkOwned(stagedFile, copied, 'stageFailed')
    await syncPath(stagedFile, FILE_SYNC_FLAGS)
    await syncPath(staging, DIR_SYNC_FLAGS)

    try {
      await fsp.rename(staging, versionDir)
    } catch (err) {
      if (!(await lstatOrNull(versionDir, 'versionConflict'))) {
        fail('stageFailed', `cannot publish ${staging} as ${versionDir}`, err)
      }
      await assertPublished(versionDir, executable, facts.sha)
      await syncPath(executable, FILE_SYNC_FLAGS)
      await syncPath(versionDir, DIR_SYNC_FLAGS)
    }
    await syncPath(versions, DIR_SYNC_FLAGS)
    return staged()
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}
