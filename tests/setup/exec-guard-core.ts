/**
 * The pure half of the test exec guard (tests/setup/exec-guard.ts): names,
 * paths and the guard log format, with no vitest import, so global-setup.ts
 * (the runner) and the guard's own tests can use them.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The refusing scripts, one per guarded tool. */
export const EXEC_GUARD_BIN = path.resolve(import.meta.dirname, 'exec-guard-bin')
export const EXEC_GUARD_TOOLS = ['claude', 'ssh', 'scp', 'sftp'] as const

/** Fake homes are named `<prefix><worker pid>`; global-setup.ts sweeps dead ones. */
export const EXEC_GUARD_HOME_PREFIX = 'open-walnut-test-home-'

/** In a fake home: the guard log, the run that owns it, and how far the worker read. */
export const EXEC_GUARD_LOG = 'exec-guard.log'
export const EXEC_GUARD_RUN_FILE = 'exec-guard.run'
export const EXEC_GUARD_OFFSET_FILE = 'exec-guard.offset'

/** Where a shim writes when the test env (and so this worker's log) was lost. */
export function unattributedLogPaths(tmpdir: string = os.tmpdir()): string[] {
  return [...new Set([path.join(tmpdir, 'open-walnut-exec-guard-unattributed.log'), '/tmp/open-walnut-exec-guard-unattributed.log'])]
}

/** Variables that point a tool past HOME at the user's own config or agent. */
export const REAL_CONFIG_VARS = ['ZDOTDIR', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'CLAUDE_CONFIG_DIR', 'SSH_AUTH_SOCK'] as const

export interface ExecGuardHit {
  at: string
  pid: number
  tool: string
  /** The test (or file hook) whose env the calling process carried. */
  startedBy: string
  args: string
}

/** `dirs`, then the guard, then `rest` (the worker's PATH by default) without the guard. */
export function guardedPath(dirs: readonly string[] = [], rest: string = process.env.PATH ?? ''): string {
  const tail = rest.split(path.delimiter).filter((d) => d && d !== EXEC_GUARD_BIN)
  return [...dirs.filter((d) => d && d !== EXEC_GUARD_BIN), EXEC_GUARD_BIN, ...tail].join(path.delimiter)
}

/** One parsed guard log line, or null for a torn or foreign line. */
export function parseHit(line: string): ExecGuardHit | null {
  const parts = line.split('\t')
  if (parts.length < 5 || !parts[2]) return null
  return { at: parts[0], pid: Number(parts[1]), tool: parts[2], startedBy: parts[3], args: parts.slice(4).join(' ') }
}

export function formatHit(hit: ExecGuardHit): string {
  return `  ${hit.tool} ${hit.args}`.trimEnd() + `\n    started by: ${hit.startedBy} (pid ${hit.pid}, ${hit.at})`
}

/** Create (once) the fake home a worker runs under. */
export function makeFakeHome(dir: string): void {
  fs.mkdirSync(path.join(dir, '.ssh'), { recursive: true, mode: 0o700 })
  const sshConfig = path.join(dir, '.ssh', 'config')
  if (!fs.existsSync(sshConfig)) {
    fs.writeFileSync(sshConfig, '# Open Walnut test home (tests/setup/exec-guard.ts): no real hosts here.\n', { mode: 0o600 })
  }
  const gitConfig = path.join(dir, '.gitconfig')
  if (!fs.existsSync(gitConfig)) {
    fs.writeFileSync(gitConfig, '[user]\n\tname = Walnut Test\n\temail = walnut-test@example.invalid\n[commit]\n\tgpgsign = false\n')
  }
}

/**
 * Hits in the shared unattributed logs (a shim whose caller had lost the test
 * env) written at or after `sinceMs`. The log is shared machine-wide, so a hit
 * here may come from a concurrent run; either way something escaped the mocks.
 */
export function unattributedHitsSince(sinceMs: number, tmpdir: string = os.tmpdir()): ExecGuardHit[] {
  const hits: ExecGuardHit[] = []
  for (const file of unattributedLogPaths(tmpdir)) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const hit = parseHit(line)
      // The shim stamps whole seconds.
      if (hit && Date.parse(hit.at) >= Math.floor(sinceMs / 1000) * 1000) hits.push(hit)
    }
  }
  return hits
}

/**
 * Hits no worker of run `runPid` (the vitest main process) read before it
 * ended: a background dial a test left running spawns its ssh after the file's
 * last check, and a forked worker is killed without an exit hook, so only the
 * runner can still report them. Read before the sweep removes the dead homes.
 */
export function unreadHitsOfRun(runPid: number, tmpdir: string = os.tmpdir()): ExecGuardHit[] {
  const hits: ExecGuardHit[] = []
  let names: string[] = []
  try { names = fs.readdirSync(tmpdir).filter((n) => n.startsWith(EXEC_GUARD_HOME_PREFIX)) } catch { return hits }
  for (const name of names) {
    const home = path.join(tmpdir, name)
    try {
      if (fs.readFileSync(path.join(home, EXEC_GUARD_RUN_FILE), 'utf8').trim() !== String(runPid)) continue
      let offset = 0
      try { offset = Number(fs.readFileSync(path.join(home, EXEC_GUARD_OFFSET_FILE), 'utf8').trim()) || 0 } catch { /* none read */ }
      const text = fs.readFileSync(path.join(home, EXEC_GUARD_LOG)).subarray(offset).toString('utf8')
      for (const line of text.split('\n')) {
        const hit = parseHit(line)
        if (hit) hits.push(hit)
      }
    } catch { /* not a guard home of this run, or already gone */ }
  }
  return hits
}
