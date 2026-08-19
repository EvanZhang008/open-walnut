/**
 * Embedded VS Code for a session — resolve a browser-loadable URL.
 *
 * Local session:  ensure code-server in-process (this Mac owns the files) and
 *                 answer http://127.0.0.1:<port>/?folder=...
 * Remote session: daemon vscode.ensure (capability 'vscode-v1') starts
 *                 code-server on the host; we SSH-forward its loopback port
 *                 and answer the same URL shape against the local end.
 *
 * The whole request is deadline-bounded: this route touches daemon/SSH, so it
 * must answer degraded rather than hang (production server rule).
 */
import { getConfig } from './config-manager.js'
import { getDaemonConnection } from '../providers/daemon-connection.js'
import {
  ensureCodeServer,
  resolveOpenTarget,
  CODE_SERVER_VERSION,
} from '../providers/vscode-server-core.js'
import type { SessionRecord } from './types.js'
import type { SshTarget } from '../providers/session-io.js'
import { log } from '../logging/index.js'

/** Remote ensure can include a first-time ~100MB install; give it room. */
const REMOTE_ENSURE_TIMEOUT_MS = 120_000
const REMOTE_ENSURE_NOINSTALL_TIMEOUT_MS = 25_000

export class SessionVscodeEmbedError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 502 | 503, readonly hint?: string) {
    super(message)
    this.name = 'SessionVscodeEmbedError'
  }
}

export interface VscodeEmbedResult {
  /** Browser-loadable URL (always 127.0.0.1 — local instance or tunnel end). */
  url: string
  /** Instance identity token — changes when code-server restarts. */
  token: string
  /** What was opened (workspace file vs folder) and where, for the UI label. */
  open: { kind: 'workspace' | 'folder'; path: string }
  host: string
  codeServerVersion?: string
}

interface DaemonEnsurePayload {
  ok?: boolean
  running?: boolean
  installed?: boolean
  port?: number
  token?: string
  version?: string
  error?: string
  installHint?: string
  open?: { kind: 'workspace' | 'folder'; path: string }
}

function buildUrl(localPort: number, open: { kind: 'workspace' | 'folder'; path: string }): string {
  const param = open.kind === 'workspace' ? 'workspace' : 'folder'
  return `http://127.0.0.1:${localPort}/?${param}=${encodeURIComponent(open.path)}`
}

export async function buildSessionVscodeEmbed(
  session: SessionRecord | null | undefined,
  opts: { install?: boolean } = {},
): Promise<VscodeEmbedResult> {
  if (!session) throw new SessionVscodeEmbedError('session not found', 404)
  if (!session.cwd) throw new SessionVscodeEmbedError('session has no working directory', 400)

  const isRemote = Boolean(session.host && session.host !== '__local__')

  if (!isRemote) {
    // Local host: the walnut server process IS the host-local owner.
    const ensured = await ensureCodeServer({ noInstall: opts.install === false })
    if (!ensured.ok || !ensured.port || !ensured.token) {
      if (!ensured.installed) {
        throw new SessionVscodeEmbedError(
          `code-server is not installed on this Mac`, 503,
          ensured.installHint ?? `download code-server ${CODE_SERVER_VERSION} into ~/.local/lib/`,
        )
      }
      throw new SessionVscodeEmbedError(ensured.error ?? 'code-server failed to start', 502)
    }
    const open = await resolveOpenTarget(session.cwd)
    return {
      url: buildUrl(ensured.port, open),
      token: ensured.token,
      open,
      host: '__local__',
      codeServerVersion: ensured.version,
    }
  }

  const host = session.host!
  const config = await getConfig()
  const hostDef = config.hosts?.[host]
  if (!hostDef?.hostname) {
    throw new SessionVscodeEmbedError(`Unknown session host alias: ${host}`, 400)
  }
  const target: SshTarget = { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port }

  const conn = await getDaemonConnection(host, target)
  if (!conn.hasCapability('vscode-v1')) {
    throw new SessionVscodeEmbedError(
      `daemon on ${host} needs an upgrade for embedded VS Code`, 503,
      'redeploy the daemon (npm run build:daemon), then retry',
    )
  }

  const timeoutMs = opts.install === false ? REMOTE_ENSURE_NOINSTALL_TIMEOUT_MS : REMOTE_ENSURE_TIMEOUT_MS
  const result = await conn.send(
    'vscode.ensure',
    { cwd: session.cwd, noInstall: opts.install === false },
    timeoutMs,
  ) as DaemonEnsurePayload

  if (!result.ok || !result.port || !result.token) {
    if (result.installed === false) {
      throw new SessionVscodeEmbedError(
        `code-server is not installed on ${host}`, 503,
        result.installHint ?? result.error,
      )
    }
    throw new SessionVscodeEmbedError(
      result.error ?? `code-server failed to start on ${host}`, 502,
    )
  }

  const localPort = await conn.ensurePortForward(result.port)
  const open = result.open ?? { kind: 'folder' as const, path: session.cwd }
  log.session.info('vscode-embed: ready', {
    host, sessionId: session.claudeSessionId, remotePort: result.port, localPort, open: open.path,
  })
  return {
    url: buildUrl(localPort, open),
    token: result.token,
    open,
    host,
    codeServerVersion: result.version,
  }
}
