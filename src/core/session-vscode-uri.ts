import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { getConfig } from './config-manager.js'
import { findGitRoot } from './session-changes.js'
import { getDaemonConnection } from '../providers/daemon-connection.js'
import type { SessionRecord } from './types.js'
import type { SshTarget } from '../providers/session-io.js'

const execFileAsync = promisify(execFile)
const LOCAL_GIT_TIMEOUT_MS = 5_000
const REMOTE_TIMEOUT_MS = 5_000

export class SessionVscodeUriError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message)
    this.name = 'SessionVscodeUriError'
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function expandLocalHome(cwd: string): string {
  if (cwd === '~' || cwd.startsWith('~/')) return os.homedir() + cwd.slice(1)
  return path.resolve(cwd)
}

async function findLocalGitRoot(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { timeout: LOCAL_GIT_TIMEOUT_MS, encoding: 'utf-8' },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

interface DaemonResult {
  ok?: boolean
  error?: unknown
  resolvedPath?: unknown
  repoRoot?: unknown
  entries?: unknown
}

interface DaemonConnectionLike {
  send(command: string, params: Record<string, unknown>, timeoutMs?: number): Promise<DaemonResult>
}

export interface SessionVscodeUriDependencies {
  connectRemote?: (host: string, target: SshTarget) => Promise<DaemonConnectionLike>
}

function remainingTimeout(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}

async function resolveRemoteCwd(
  conn: DaemonConnectionLike,
  cwd: string,
  deadline: number,
): Promise<string> {
  const timeoutMs = remainingTimeout(deadline)
  const result = await withTimeout(
    conn.send('fs.ls', { path: cwd }, timeoutMs),
    timeoutMs,
    'Remote path resolution timed out',
  )
  if (
    result.ok
    && typeof result.resolvedPath === 'string'
    && path.posix.isAbsolute(result.resolvedPath)
  ) {
    return result.resolvedPath
  }
  if (cwd === '~' || cwd.startsWith('~/')) {
    throw new Error('Remote home directory could not be resolved')
  }
  return cwd
}

async function findRemoteGitRoot(
  conn: DaemonConnectionLike,
  cwd: string,
  deadline: number,
): Promise<string | null> {
  return findGitRoot(
    cwd,
    {
      readFile: async () => null,
      listDir: async (dir) => {
        const timeoutMs = remainingTimeout(deadline)
        const result = await withTimeout(
          conn.send('fs.ls', { path: dir }, timeoutMs),
          timeoutMs,
          'Remote git root lookup timed out',
        )
        if (!result.ok || !Array.isArray((result as { entries?: unknown }).entries)) return []
        return ((result as { entries: Array<{ name?: unknown }> }).entries)
          .map((entry) => entry.name)
          .filter((name): name is string => typeof name === 'string')
      },
    },
    true,
  )
}

function toVscodePath(absolutePath: string): string {
  return absolutePath
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export async function buildSessionVscodeUri(
  session: SessionRecord | null | undefined,
  dependencies: SessionVscodeUriDependencies = {},
): Promise<string> {
  if (!session) throw new SessionVscodeUriError('session not found', 404)
  if (!session.cwd) throw new SessionVscodeUriError('session has no working directory', 400)

  const isRemote = Boolean(session.host && session.host !== '__local__')
  if (!isRemote) {
    const cwd = expandLocalHome(session.cwd)
    const root = await findLocalGitRoot(cwd) ?? cwd
    return `vscode://file/${toVscodePath(root).replace(/^\/+/, '')}`
  }

  const host = session.host!
  const config = await getConfig()
  const hostDef = config.hosts?.[host]
  if (!hostDef?.hostname) {
    throw new SessionVscodeUriError(`Unknown session host alias: ${host}`, 400)
  }

  const target: SshTarget = {
    hostname: hostDef.hostname,
    user: hostDef.user,
    port: hostDef.port,
  }
  // Widen to the Like interface — getDaemonConnection returns the concrete
  // class, whose Promise type would otherwise poison the union for withTimeout.
  const connectRemote: (host: string, target: SshTarget) => Promise<DaemonConnectionLike> =
    dependencies.connectRemote ?? getDaemonConnection
  const deadline = Date.now() + REMOTE_TIMEOUT_MS
  let root: string
  try {
    const conn = await withTimeout(
      connectRemote(host, target),
      remainingTimeout(deadline),
      `Remote connection for ${host} timed out`,
    )
    const cwd = await resolveRemoteCwd(conn, session.cwd, deadline)
    root = await findRemoteGitRoot(conn, cwd, deadline).catch(() => null) ?? cwd
  } catch {
    if (session.cwd === '~' || session.cwd.startsWith('~/')) {
      throw new SessionVscodeUriError(
        `Could not resolve remote working directory for host alias: ${host}`,
        400,
      )
    }
    root = session.cwd
  }

  const authority = hostDef.user ? `${hostDef.user}@${hostDef.hostname}` : hostDef.hostname
  return `vscode://vscode-remote/ssh-remote+${authority}/${toVscodePath(root).replace(/^\/+/, '')}`
}
