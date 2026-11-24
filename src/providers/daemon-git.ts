/**
 * The session daemon's git read commands, run HERE on the host where git and the files are
 * (no per-file round trips over the tunnel): git.diff, git.status ('git-status-v1'), git.refs,
 * git.fileLog / git.fileShow ('git-file-history-v1') and git.ensureExcluded ('git-exclude-v1').
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), whose command table
 * takes the returned answers by name. Nothing here reads process state: the env, HOME and the
 * runtime's execFile (its children get the runtime's env and umask) come from deps.
 */
import fs from 'node:fs'
import path from 'node:path'
import { computeGitDiff, createGitStatus, listGitRefs, GitDiffError, type GitDiffBase } from './git-diff-core.js'
import type { ExecFileException } from 'node:child_process'
import type { ChildProcessFns } from './daemon-child-spawn.js'
import { expandHome, ok, fail, type Answer, type Answers, type DaemonEnv } from './daemon-module-deps.js'

export interface DaemonGitDeps {
  daemonEnv: DaemonEnv
  HOME_DIR: string
  /** The runtime's execFile (childUse.execFile). */
  execFileCb: ChildProcessFns['execFile']
}

export function createDaemonGit<W>(deps: DaemonGitDeps) {
  const { daemonEnv, HOME_DIR, execFileCb } = deps

  /** One git run. Never throws: exit codes are answers; `failure` is the error's own message. */
  function runGit(argv: string[], runCwd: string, opts: { env?: DaemonEnv; timeout: number; maxBuffer: number }) {
    return new Promise<{ stdout: string; stderr: string; code: number; failure: string }>((resolve) => {
      execFileCb(argv[0], argv.slice(1), { cwd: runCwd, ...(opts.env ? { env: opts.env } : {}), timeout: opts.timeout, maxBuffer: opts.maxBuffer, encoding: 'utf-8' },
        (err: ExecFileException | null, stdout: string, stderr: string) => {
          if (!err) return resolve({ stdout, stderr, code: 0, failure: '' })
          resolve({
            stdout: stdout || '',
            stderr: stderr || '',
            code: typeof err.code === 'number' ? err.code : 1,
            failure: err.message || '',
          })
        })
    })
  }

  // ── Git diff (whole-repo, host-local) ──
  // Runs the shared git-diff core HERE on the remote host, so git + the files are
  // local — no per-file network round trips. Returns the full {repoRoot,files}
  // in one response. This is why remote git-diff goes through the daemon, not SSH.
  async function cmdGitDiff(cmd: Record<string, unknown>): Promise<Answer> {
    let cwd = cmd.cwd as string
    const base = cmd.base as GitDiffBase
    if (!cwd) return fail('git.diff: missing cwd')
    if (base !== 'uncommitted' && base !== 'previous' && base !== 'remote' && base !== 'branch' && base !== 'commit') {
      return fail('git.diff: invalid base')
    }
    cwd = expandHome(cwd, HOME_DIR)

    const readText = async (absPath: string) => {
      try { return await fs.promises.readFile(absPath, 'utf-8') } catch { return '' }
    }

    // Optional narrowing: only materialize blobs for these repo-relative paths.
    const paths = Array.isArray(cmd.paths) && (cmd.paths as unknown[]).every((p) => typeof p === 'string')
      ? cmd.paths as string[]
      : undefined

    try {
      // ref / commit are validated by the core before they reach git.
      const result = await computeGitDiff(base, cwd, gitDiffExec, readText, {
        ...(paths ? { paths } : {}),
        ...(typeof cmd.ref === 'string' ? { ref: cmd.ref } : {}),
        ...(typeof cmd.commit === 'string' ? { commit: cmd.commit } : {}),
        ...(cmd.namesOnly === true ? { namesOnly: true } : {}),
      })
      if (!result) return ok({ repoRoot: null, files: [] }) // not a git repo
      return ok(result as unknown as Record<string, unknown>)
    } catch (err: unknown) {
      if (err instanceof GitDiffError) return fail(err.message)
      return fail('git.diff failed: ' + (err as Error).message)
    }
  }

  // ── Glanceable git state (host-local, capability 'git-status-v1') ──
  // The logic is createGitStatus in git-diff-core.ts.
  const gitStatus = createGitStatus({
    exec: async (argv, runCwd) => {
      const r = await runGit(argv, runCwd, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })
      return { stdout: r.stdout, stderr: r.stderr || r.failure, code: r.code }
    },
    readText: async (absPath, maxBytes) => {
      try {
        const st = await fs.promises.stat(absPath)
        if (!st.isFile()) return null
        if (st.size > maxBytes) return { tooBig: true as const }
        return { text: await fs.promises.readFile(absPath, 'utf-8') }
      } catch { return null }
    },
  })

  async function cmdGitStatus(cmd: Record<string, unknown>): Promise<Answer> {
    const dirs = Array.isArray(cmd.dirs)
      ? (cmd.dirs as unknown[]).filter((d): d is string => typeof d === 'string' && d.length > 0)
        .map((d) => expandHome(d, HOME_DIR))
      : []
    if (!dirs.length) return fail('git.status: missing dirs')
    try {
      return ok({ repos: await gitStatus.status(dirs) })
    } catch (err: unknown) {
      return fail('git.status failed: ' + (err as Error).message)
    }
  }

  /** Vars that make git ignore the cwd it is given (an inherited GIT_DIR outranks it). */
  const GIT_DIFF_REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX']

  /** One git run for git.diff / git.refs: the repo the cwd names, no optional
   *  index lock (these are reads), never a prompt. Never throws: exit codes are answers. */
  function gitDiffExec(argv: string[], runCwd: string) {
    const gitEnv: DaemonEnv = { ...daemonEnv, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    for (const k of GIT_DIFF_REDIRECT_VARS) delete gitEnv[k]
    return runGit(argv, runCwd, { env: gitEnv, timeout: 25_000, maxBuffer: 64 * 1024 * 1024 })
      .then((r) => ({ stdout: r.stdout, stderr: r.stderr || r.failure, code: r.code }))
  }


  async function cmdGitRefs(cmd: Record<string, unknown>): Promise<Answer> {
    let cwd = cmd.cwd as string
    if (!cwd || typeof cwd !== 'string') return fail('git.refs: missing cwd')
    cwd = expandHome(cwd, HOME_DIR)
    try {
      const result = await listGitRefs(cwd, gitDiffExec)
      if (!result) return ok({ repoRoot: null })
      return ok(result as unknown as Record<string, unknown>)
    } catch (err: unknown) {
      return fail('git.refs failed: ' + (err as Error).message)
    }
  }

  // ── Git history for ONE file (host-local — capability 'git-file-history-v1') ──
  // Same rule as git.diff: git and the file must be on the same host, so the
  // Files panel's history asks the daemon rather than shuttling bytes. Two
  // questions only — which commits touched this file, and what it looked like at
  // one of them — each ONE git invocation with a timeout and a maxBuffer.

  /** A sha as it arrives from a caller. Checked BEFORE spawning: it lands in a
   *  `git show <sha>:<path>` argument. Mirrors GIT_SHA_RE in file-history-git.ts. */
  const GIT_FILE_SHA_RE = /^[0-9a-f]{7,40}$/
  const GIT_FILE_LOG_FORMAT = '%H%x1f%ct%x1f%an%x1f%s'
  const GIT_FILE_SHOW_MAX_BYTES = 8 * 1024 * 1024

  /** One git run for the file-history family. Never throws — exit codes are answers. */
  function gitFileExec(argv: string[], runCwd: string, maxBuffer: number) {
    return runGit(argv, runCwd, { timeout: 8_000, maxBuffer })
  }


  async function cmdGitFileLog(cmd: Record<string, unknown>): Promise<Answer> {
    const rawCwd = cmd.cwd as string
    const rawPath = cmd.path as string
    if (!rawCwd || typeof rawCwd !== 'string') return fail('git.fileLog: missing cwd')
    if (!rawPath || typeof rawPath !== 'string') return fail('git.fileLog: missing path')
    const cwd = expandHome(rawCwd, HOME_DIR)
    const filePath = expandHome(rawPath, HOME_DIR)
    const requested = typeof cmd.limit === 'number' && isFinite(cmd.limit) ? Math.floor(cmd.limit) : 30
    const limit = Math.max(1, Math.min(requested, 200))
    try {
      const top = await gitFileExec(['git', 'rev-parse', '--show-toplevel'], cwd, 64 * 1024)
      if (top.code !== 0 || !top.stdout.trim()) return ok({ repoRoot: null, commits: [] })
      const repoRoot = top.stdout.trim()
      const rel = path.relative(repoRoot, filePath).split(path.sep).join('/')
      if (!rel || rel === '..' || rel.startsWith('../')) return ok({ repoRoot, commits: [] })
      const res = await gitFileExec(
        ['git', 'log', '--follow', '--no-color', '--format=' + GIT_FILE_LOG_FORMAT, '-n', String(limit), '--', rel],
        repoRoot, 4 * 1024 * 1024,
      )
      // A path git never tracked exits non-zero: an ordinary "no history", not a failure.
      if (res.code !== 0) return ok({ repoRoot, commits: [] })
      const commits: Array<{ sha: string; at: number; author: string; subject: string }> = []
      for (const line of res.stdout.split('\n')) {
        if (!line) continue
        const parts = line.split('\x1f')
        if (parts.length < 4) continue
        const at = Number(parts[1]) * 1000
        commits.push({
          sha: parts[0], at: Number.isFinite(at) ? at : 0, author: parts[2],
          subject: parts.slice(3).join('\x1f'),
        })
      }
      return ok({ repoRoot, commits })
    } catch (err: unknown) {
      return fail('git.fileLog failed: ' + (err as Error).message)
    }
  }

  async function cmdGitFileShow(cmd: Record<string, unknown>): Promise<Answer> {
    const rawCwd = cmd.cwd as string
    const rawPath = cmd.path as string
    const sha = cmd.sha as string
    if (!rawCwd || typeof rawCwd !== 'string') return fail('git.fileShow: missing cwd')
    if (!rawPath || typeof rawPath !== 'string') return fail('git.fileShow: missing path')
    if (!sha || typeof sha !== 'string' || !GIT_FILE_SHA_RE.test(sha)) {
      return fail('git.fileShow: invalid sha')
    }
    const cwd = expandHome(rawCwd, HOME_DIR)
    const filePath = expandHome(rawPath, HOME_DIR)
    try {
      const top = await gitFileExec(['git', 'rev-parse', '--show-toplevel'], cwd, 64 * 1024)
      if (top.code !== 0 || !top.stdout.trim()) return fail('git.fileShow failed: not a git repository')
      const repoRoot = top.stdout.trim()
      const rel = path.relative(repoRoot, filePath).split(path.sep).join('/')
      if (!rel || rel === '..' || rel.startsWith('../')) return fail('git.fileShow failed: file is outside the repository')
      const res = await gitFileExec(['git', 'show', sha + ':' + rel], repoRoot, GIT_FILE_SHOW_MAX_BYTES)
      if (res.code !== 0) {
        if (/maxBuffer/i.test(res.failure)) {
          return fail('git.fileShow failed: that version is larger than '
            + GIT_FILE_SHOW_MAX_BYTES + ' bytes — too big to show')
        }
        return fail('git.fileShow failed: '
          + (res.stderr.trim().split('\n')[0] || res.failure || 'git show failed'))
      }
      return ok({ content: res.stdout })
    } catch (err: unknown) {
      return fail('git.fileShow failed: ' + (err as Error).message)
    }
  }

  // ── Keep a generated file out of the repo (host-local — capability 'git-exclude-v1') ──
  // For a file Walnut just created inside a checkout (a project's
  // .claude/settings.local.json): if git does not already ignore it, append it to
  // .git/info/exclude, the per-repo ignore list that is never committed. Nothing
  // tracked is touched, and an already-tracked file is left alone (excluding it
  // would change nothing). The path resolves through `git rev-parse --git-path`,
  // so a worktree whose .git is a file still lands in the right place.
  async function cmdGitEnsureExcluded(cmd: Record<string, unknown>): Promise<Answer> {
    const rawCwd = cmd.cwd as string
    const rawPath = cmd.path as string
    if (!rawCwd || typeof rawCwd !== 'string') return fail('git.ensureExcluded: missing cwd')
    if (!rawPath || typeof rawPath !== 'string') return fail('git.ensureExcluded: missing path')
    const cwd = expandHome(rawCwd, HOME_DIR)
    const filePath = expandHome(rawPath, HOME_DIR)
    try {
      const top = await gitFileExec(['git', 'rev-parse', '--show-toplevel'], cwd, 64 * 1024)
      if (top.code !== 0 || !top.stdout.trim()) return ok({ outcome: 'not-a-repo' })
      // git answers with symlinks resolved (/private/var on macOS for a /var cwd),
      // so the file's directory is resolved the same way before the two are
      // compared; otherwise every checkout under /tmp or /var reads as "outside".
      const repoRoot = await fs.promises.realpath(top.stdout.trim())
      const realDir = await fs.promises.realpath(path.dirname(filePath)).catch(() => path.dirname(filePath))
      const rel = path.relative(repoRoot, path.join(realDir, path.basename(filePath))).split(path.sep).join('/')
      if (!rel || rel === '..' || rel.startsWith('../')) return fail('git.ensureExcluded failed: file is outside the repository')
      // Exit 0 = already ignored (by any rule, global ones included); 1 = not ignored.
      const ignored = await gitFileExec(['git', 'check-ignore', '-q', '--', rel], repoRoot, 64 * 1024)
      if (ignored.code === 0) return ok({ outcome: 'already' })
      const tracked = await gitFileExec(['git', 'ls-files', '--error-unmatch', '--', rel], repoRoot, 64 * 1024)
      if (tracked.code === 0) return ok({ outcome: 'already' })
      const excludeFile = await gitFileExec(['git', 'rev-parse', '--git-path', 'info/exclude'], repoRoot, 64 * 1024)
      if (excludeFile.code !== 0 || !excludeFile.stdout.trim()) return fail('git.ensureExcluded failed: cannot locate info/exclude')
      const excludePath = path.resolve(repoRoot, excludeFile.stdout.trim())
      await fs.promises.mkdir(path.dirname(excludePath), { recursive: true })
      let existing = ''
      try { existing = await fs.promises.readFile(excludePath, 'utf-8') } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      const line = '/' + rel
      const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
      await fs.promises.appendFile(excludePath, sep + line + '\n')
      return ok({ outcome: 'added', excludeFile: excludePath })
    } catch (err: unknown) {
      return fail('git.ensureExcluded failed: ' + (err as Error).message)
    }
  }


  const answers: Answers<W> = {
    'git.diff': cmdGitDiff, 'git.status': cmdGitStatus, 'git.refs': cmdGitRefs,
    'git.fileLog': cmdGitFileLog, 'git.fileShow': cmdGitFileShow, 'git.ensureExcluded': cmdGitEnsureExcluded,
  }
  return { answers }
}
