/**
 * Git history for ONE file, run locally (in-process `git`) for a `__local__`
 * path. The remote twin of this lives in the daemon (`git.fileLog` /
 * `git.fileShow`) because git and the files must be on the same host — see
 * CLAUDE.md "host-local work belongs to the DAEMON".
 *
 * Deliberately narrow: two questions ("which commits touched this file" and
 * "what did it look like at that commit"), each one `git` invocation, each
 * bounded by a timeout and a maxBuffer. There is no repo-wide walk here; the
 * Files panel only ever asks about the file the user has open.
 *
 * `execFile` only, never `execSync`: one sync git call blocks every route on the
 * server's single event loop.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/** A file version is text the editor could hold; past this we refuse instead of truncating. */
export const GIT_MAX_SHOW_BYTES = 8 * 1024 * 1024
const GIT_TIMEOUT_MS = 8_000
const GIT_LOG_MAX_BUFFER = 4 * 1024 * 1024
/** Default number of commits — a file's recent past, not its whole life. */
export const GIT_LOG_DEFAULT_LIMIT = 30

/**
 * A commit sha as it may arrive from a client. Validated BEFORE spawning
 * anything: this string is user input and lands in a `git show <sha>:<path>`
 * argument, so "looks like a sha" is the gate, not "git will probably reject it".
 * Shared with the daemon twins (which carry an identical copy — they cannot
 * import).
 */
export const GIT_SHA_RE = /^[0-9a-f]{7,40}$/

export interface FileGitCommit {
  sha: string
  /** Epoch ms (git reports seconds). */
  at: number
  author: string
  subject: string
}

export interface FileGitLog {
  repoRoot: string
  commits: FileGitCommit[]
}

/** Field separator: `%x1f` is a unit separator, which cannot appear in a subject line. */
const SEP = '\x1f'
const LOG_FORMAT = '%H%x1f%ct%x1f%an%x1f%s'

interface ExecResult { stdout: string; stderr: string; code: number; failure: string }

async function run(argv: string[], cwd: string, maxBuffer: number): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1), {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: 'utf-8',
    })
    return { stdout, stderr, code: 0, failure: '' }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; message?: string }
    // `failure` keeps node's OWN message (maxBuffer overflow, ENOENT for a
    // missing git, SIGTERM from the timeout) separate from git's stderr — a
    // caller has to be able to tell "too big" from "no such object".
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
      code: typeof e.code === 'number' ? e.code : 1,
      failure: e.message ?? '',
    }
  }
}

/** Repo root containing `cwd`, or null when it isn't a git working tree. */
async function repoRootOf(cwd: string): Promise<string | null> {
  const res = await run(['git', 'rev-parse', '--show-toplevel'], cwd, 1024 * 64)
  if (res.code !== 0 || !res.stdout.trim()) return null
  return res.stdout.trim()
}

export function parseGitFileLog(stdout: string): FileGitCommit[] {
  const commits: FileGitCommit[] = []
  for (const line of stdout.split('\n')) {
    if (!line) continue
    const parts = line.split(SEP)
    if (parts.length < 4) continue
    const at = Number(parts[1]) * 1000
    commits.push({
      sha: parts[0]!,
      at: Number.isFinite(at) ? at : 0,
      author: parts[2]!,
      // A subject can contain the separator only if git wrote it, which it can't
      // — but rejoining the tail keeps a surprising subject intact rather than truncated.
      subject: parts.slice(3).join(SEP),
    })
  }
  return commits
}

/**
 * Commits that touched `absPath`, newest first. `--follow` so a renamed file
 * keeps its past. Returns null when the file isn't inside a git repo — the
 * caller reports that as "git unavailable", not as a failure.
 */
export async function gitFileLog(
  cwdOfFile: string,
  absPath: string,
  limit = GIT_LOG_DEFAULT_LIMIT,
): Promise<FileGitLog | null> {
  const repoRoot = await repoRootOf(cwdOfFile)
  if (!repoRoot) return null
  const rel = path.relative(repoRoot, absPath).split(path.sep).join('/')
  if (!rel || rel === '..' || rel.startsWith('../')) return { repoRoot, commits: [] }
  const capped = Math.max(1, Math.min(Math.floor(limit), 200))
  const res = await run(
    ['git', 'log', '--follow', '--no-color', '--format=' + LOG_FORMAT, '-n', String(capped), '--', rel],
    repoRoot,
    GIT_LOG_MAX_BUFFER,
  )
  // Exit 128 for a path git has never tracked is an ordinary answer here, not an
  // error: the file exists on disk and simply has no history.
  if (res.code !== 0) return { repoRoot, commits: [] }
  return { repoRoot, commits: parseGitFileLog(res.stdout) }
}

/**
 * The file's content at one commit. Throws when the sha is malformed (before
 * spawning), when the path isn't in a repo, when git has no such object, or
 * when the version is too big for the editor to hold.
 */
export async function gitFileShow(
  cwdOfFile: string,
  absPath: string,
  sha: string,
): Promise<{ content: string }> {
  if (!GIT_SHA_RE.test(sha)) throw new Error('invalid commit sha')
  const repoRoot = await repoRootOf(cwdOfFile)
  if (!repoRoot) throw new Error('not a git repository')
  const rel = path.relative(repoRoot, absPath).split(path.sep).join('/')
  if (!rel || rel === '..' || rel.startsWith('../')) throw new Error('file is outside the repository')
  const res = await run(['git', 'show', sha + ':' + rel], repoRoot, GIT_MAX_SHOW_BYTES)
  if (res.code !== 0) {
    if (/maxBuffer/i.test(res.failure)) {
      throw new Error(`that version is larger than ${GIT_MAX_SHOW_BYTES} bytes — too big to show`)
    }
    throw new Error(res.stderr.trim().split('\n')[0] || res.failure || 'git show failed')
  }
  return { content: res.stdout }
}
