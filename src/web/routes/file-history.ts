/**
 * History for the ONE file the user has open in the Files panel.
 *
 *   GET /api/file-history?path=&host=
 *     → { entries: Entry[], git: { available, repoRoot?, commits?, reason? } }
 *   GET /api/file-history/version?path=&host=&id=<snapshotId>
 *     → { content, hash, at, writer }
 *   GET /api/file-history/version?path=&host=&sha=<gitsha>
 *     → { content, sha }
 *
 * Two sources, one timeline. Walnut's own snapshots (src/core/file-history.ts)
 * always answer — they are local files and exist whether or not the file is in a
 * repo, which is the "must work without git" half. Git is the better history
 * when it's there, so it rides along, but it is strictly OPTIONAL: the git half
 * runs under a deadline and every way it can fail degrades to
 * `available:false` + a short reason while the snapshot entries still return.
 *
 * The deadline is not optional politeness (CLAUDE.md): a remote host reaches its
 * daemon over an SSH tunnel, and ONE pinned response starves the browser's
 * 6-connection pool into app-wide fake timeouts. This route answers degraded,
 * never late.
 *
 * Read-only, so it still serves in CLOUD_MODE — `assertPathAllowed` already
 * confines what a cloud box may read locally, and remote paths execute on the
 * target host's daemon.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { assertPathAllowed, isSecretPath, FileContentError } from './file-content.js'
import { isSecretForMutation } from './file-ops.js'
import { CLOUD_MODE } from '../../constants.js'
import { createFileReader } from '../../core/session-file-reader.js'
import type { DaemonFileReader } from '../../core/daemon-file-reader.js'
import { DaemonNeedsUpgradeError } from '../../core/daemon-file-reader.js'
import { listSnapshots, readSnapshot } from '../../core/file-history.js'
import {
  gitFileLog, gitFileShow, GIT_SHA_RE, GIT_LOG_DEFAULT_LIMIT, type FileGitCommit,
} from '../../core/file-history-git.js'
import { log } from '../../logging/index.js'

/** Why the git half of the timeline is missing. Short, machine-readable. */
export type FileHistoryGitReason = 'timeout' | 'daemon_needs_upgrade' | 'not_a_repo' | 'error'

export interface FileHistoryGitInfo {
  available: boolean
  repoRoot?: string
  commits?: FileGitCommit[]
  reason?: FileHistoryGitReason
}

/** The slice of DaemonFileReader this route needs — also the test seam. */
export interface FileHistoryReader {
  gitFileLog(cwd: string, remotePath: string, limit?: number): Promise<{ repoRoot: string | null; commits: FileGitCommit[] }>
  gitFileShow(cwd: string, remotePath: string, sha: string): Promise<string>
}

export interface FileHistoryDeps {
  /** Override the reader factory (tests inject a fake; production uses the daemon). */
  createReader?: (host: string) => FileHistoryReader | Promise<FileHistoryReader>
  /** Budget for the whole git half. Lowered by tests so a hang case stays fast. */
  gitDeadlineMs?: number
}

const DEFAULT_GIT_DEADLINE_MS = 5_000

/** A cancellable timeout — Promise.race never cancels its loser on its own. */
function deadline(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
  return { promise, cancel: () => { if (timer) clearTimeout(timer) } }
}

/**
 * A history listing is metadata ABOUT a file's bytes, so credential paths are
 * refused on every box — not only in cloud mode as on the read path — and git
 * history for a credential file is not something this panel should hand out.
 * The rule is the MUTATION denylist, not the read path's `isSecretPath`: that one
 * treats every `config.yaml` anywhere as Walnut's own, which would give a
 * project's config file (which the viewer shows and edits) a History button that
 * answers 403. In cloud mode the read path's wider rule applies on top, exactly
 * as it does for the bytes themselves.
 */
function assertHistoryAllowed(rawPath: unknown, host: string | undefined) {
  const resolved = assertPathAllowed(rawPath, host, 'read')
  const cloudDenied = !resolved.isRemote && CLOUD_MODE && isSecretPath(resolved.filePath)
  if (cloudDenied || isSecretForMutation(resolved.filePath)) {
    throw new FileContentError('Path not permitted', 403)
  }
  return resolved
}

/** The git half: commits that touched this file, or why we have none. */
async function loadGitInfo(
  filePath: string,
  host: string | undefined,
  isRemote: boolean,
  deps: FileHistoryDeps,
): Promise<FileHistoryGitInfo> {
  const bail = deadline(deps.gitDeadlineMs ?? DEFAULT_GIT_DEADLINE_MS)
  const cwd = path.dirname(filePath)
  const work = (async (): Promise<FileHistoryGitInfo> => {
    if (isRemote) {
      const reader = deps.createReader
        ? await deps.createReader(host as string)
        : ((await createFileReader(host as string)) as unknown as FileHistoryReader)
      const res = await reader.gitFileLog(cwd, filePath, GIT_LOG_DEFAULT_LIMIT)
      if (!res.repoRoot) return { available: false, reason: 'not_a_repo' }
      return { available: true, repoRoot: res.repoRoot, commits: res.commits }
    }
    const res = await gitFileLog(cwd, filePath, GIT_LOG_DEFAULT_LIMIT)
    if (!res) return { available: false, reason: 'not_a_repo' }
    return { available: true, repoRoot: res.repoRoot, commits: res.commits }
  })()
  try {
    const outcome = await Promise.race([work, bail.promise])
    if (outcome === 'timeout') {
      log.web.warn('file-history: git half timed out', { path: filePath, host })
      return { available: false, reason: 'timeout' }
    }
    return outcome
  } catch (err) {
    if (err instanceof DaemonNeedsUpgradeError) return { available: false, reason: 'daemon_needs_upgrade' }
    log.web.warn('file-history: git half failed', {
      path: filePath, host, error: err instanceof Error ? err.message : String(err),
    })
    return { available: false, reason: 'error' }
  } finally {
    bail.cancel()
  }
}

/** Build the router. The exported singleton below is what server.ts mounts. */
export function createFileHistoryRouter(deps: FileHistoryDeps = {}): Router {
  const router = Router()

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const host = typeof req.query.host === 'string' && req.query.host.length > 0 ? req.query.host : undefined
      const { filePath, isRemote } = assertHistoryAllowed(req.query.path, host)
      // Snapshots first and unconditionally: they are the answer that must never
      // depend on git, a repo, or a reachable host.
      const entries = await listSnapshots({ host: host ?? null, path: filePath })
      const git = await loadGitInfo(filePath, host, isRemote, deps)
      res.json({ entries, git })
    } catch (err) {
      if (err instanceof FileContentError) {
        res.status(err.statusCode).json({ error: err.message, code: err.statusCode === 403 ? 'forbidden' : 'invalid' })
        return
      }
      next(err)
    }
  })

  router.get('/version', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const host = typeof req.query.host === 'string' && req.query.host.length > 0 ? req.query.host : undefined
      const sha = typeof req.query.sha === 'string' ? req.query.sha : undefined
      const id = typeof req.query.id === 'string' ? req.query.id : undefined
      // Validate the sha BEFORE the path work: it is the one field that reaches a
      // spawned git argument, so it never gets to travel further than this check.
      if (sha !== undefined && !GIT_SHA_RE.test(sha)) {
        res.status(400).json({ error: 'Invalid commit sha', code: 'invalid_sha' })
        return
      }
      const { filePath, isRemote } = assertHistoryAllowed(req.query.path, host)

      if (sha) {
        const bail = deadline(deps.gitDeadlineMs ?? DEFAULT_GIT_DEADLINE_MS)
        const cwd = path.dirname(filePath)
        try {
          const work = (async (): Promise<string> => {
            if (isRemote) {
              const reader = deps.createReader
                ? await deps.createReader(host as string)
                : ((await createFileReader(host as string)) as unknown as FileHistoryReader)
              return await reader.gitFileShow(cwd, filePath, sha)
            }
            return (await gitFileShow(cwd, filePath, sha)).content
          })()
          const outcome = await Promise.race([work, bail.promise])
          if (outcome === 'timeout') {
            res.status(504).json({ error: 'Timed out reading that version', code: 'timeout' })
            return
          }
          res.json({ content: outcome, sha })
        } catch (err) {
          if (err instanceof DaemonNeedsUpgradeError) {
            res.status(501).json({ error: err.message, code: 'daemon_needs_upgrade' })
            return
          }
          // git's own refusals (no such object, not a repo) are a missing version,
          // not a server fault — the panel says so and keeps the rest of the list.
          res.status(404).json({
            error: err instanceof Error ? err.message : String(err),
            code: 'not_found',
          })
        } finally {
          bail.cancel()
        }
        return
      }

      if (!id) {
        res.status(400).json({ error: 'id or sha is required', code: 'invalid' })
        return
      }
      const snap = await readSnapshot({ host: host ?? null, path: filePath, id })
      if (!snap) {
        res.status(404).json({ error: 'No such version', code: 'not_found' })
        return
      }
      res.json({ content: snap.content, hash: snap.hash, at: snap.at, writer: snap.writer })
    } catch (err) {
      if (err instanceof FileContentError) {
        res.status(err.statusCode).json({ error: err.message, code: err.statusCode === 403 ? 'forbidden' : 'invalid' })
        return
      }
      next(err)
    }
  })

  return router
}

export const fileHistoryRouter = createFileHistoryRouter()

// Keeps the DaemonFileReader ↔ FileHistoryReader shapes honest: production hands
// the real reader to this route, so a signature drift must fail the build here.
const _readerShapeCheck: (r: DaemonFileReader) => FileHistoryReader = (r) => r
void _readerShapeCheck
