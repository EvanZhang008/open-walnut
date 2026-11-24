/**
 * The session daemon's view of what a session changed, computed on this host from its own
 * transcripts and files (changes.compute, changes.file: 'changes-v1'), the usage scans over the
 * engines' own records (usage.scan, usage.costState, usage.sessionCost, usage.codexOutside),
 * and the session commit that plans from those changes (git.commitPlan, git.commitStart,
 * git.commitJob: 'git-commit-v1').
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), whose dispatcher
 * calls the returned commands. The turn guard reads computeChangesCached, and the runtime's
 * timer calls releaseIdleChangesState. The code is the runtime's as it was; deps carry the
 * runtime's own names.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  computeHostLocalChanges,
  toLightChangesResult,
  type HostLocalComputeOutput,
  type FileAccum as ChangesFileAccum,
  type MainParseState,
  type SessionChangesResult,
} from './session-changes-core.js'
import { scanHostUsage, scanCostState, scanSessionCost, scanCodexOutside, createUsagePages } from './usage-host-core.js'
import { createGitAttribution } from './git-attribution-core.js'
import { createGitCommitCore, type PlanChanges } from './git-commit-core.js'
import type { ChildProcessFns, ChildProcessUse } from './daemon-child-spawn.js'
import type { createDaemonCommandDrain } from './daemon-command-drain.js'
import type { DaemonEnv, DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonChangesDeps<W> extends DaemonReplies<W> {
  daemonEnv: DaemonEnv
  HOME_DIR: string
  DAEMON_DIR: string
  /** A service daemon keeps its change checkpoints in its state dir. */
  SERVICE_MODE: boolean
  DAEMON_STATE_DIR: string | undefined
  /** The CLI's config home (CLAUDE_CONFIG_DIR or ~/.claude). */
  CLAUDE_CONFIG_HOME: string
  childUse: ChildProcessUse
  /** The runtime's spawn, for the commit's git runs. */
  spawn: ChildProcessFns['spawn']
  /** The runtime's command drain: a commit job rides it, so a shutdown waits for it. */
  daemonCommands: ReturnType<typeof createDaemonCommandDrain>
  /** The runtime's sessions, read only: a running or just-ended session keeps its parse state. */
  sessions: { get(sid: string): { state: string; exitedAt: number | null } | undefined }
  logMsg: DaemonLog
}

/** One session's full changes output, keyed on its transcript's stat. */
export interface ChangesCacheEntry {
  mtimeMs: number
  size: number
  output: HostLocalComputeOutput
  lastUsed: number
}

/** What makes a recompute cheap for one session (kept for more sessions than the full outputs). */
export interface ChangesMemo {
  subCache: Map<string, { size: number; fileMap: Map<string, ChangesFileAccum> }>
  gitRootByDir: Map<string, string | null>
  // Where the main transcript parse stopped: a recompute after an append reads
  // only the new bytes (session-changes-core.ts MainParseState).
  mainParse: { state?: MainParseState }
  // The last compute's wire answer and the transcript stat it came from. Only
  // 12 full outputs fit (each holds every before/after string) and the sweep
  // warms ~20 sessions, so every sweep rebuilt every session's before/after for
  // an answer that had not changed (1 to 18 s each, 2026-09-29). This copy is
  // light, so every memo keeps one and changes.compute answers from it.
  light?: { mtimeMs: number; size: number; jsonlPath: string; result: SessionChangesResult }
  lastUsed: number
}

export function createDaemonChanges<W>(deps: DaemonChangesDeps<W>) {
  const { daemonEnv, HOME_DIR, DAEMON_DIR, SERVICE_MODE, DAEMON_STATE_DIR, CLAUDE_CONFIG_HOME, childUse, spawn, daemonCommands, sessions, logMsg, sendOk, sendError } = deps

  // ── Session changes (host-local compute — capability 'changes-v1') ──
  // The design-principle path (AGENTS.md): this host parses its OWN session
  // JSONLs and reads its OWN files; only a light list / one file's diff crosses
  // the tunnel. The pipeline lives in session-changes-core.ts (shared with the
  // server's fallback compute so both produce identical results).
  //
  // Cache: per-sid full output keyed on the main JSONL's (mtimeMs, size), plus
  // the subagent size-cache and git-root memo reused ACROSS recomputes. Serial
  // gate: one compute at a time daemon-wide (a whale parse is CPU+fs heavy; two
  // in parallel would starve session I/O), followers of the same sid coalesce.
  const changesCache = new Map<string, ChangesCacheEntry>()
  const CHANGES_CACHE_MAX_SESSIONS = 12
  // What makes a recompute cheap, kept apart from the heavy output and for more
  // sessions: the prewarm sweep warms ~20 sessions, so with these inside the
  // 12-entry output LRU a whale's were evicted between its warms and every warm
  // re-read the whole transcript (907 MB, 5 to 20 s, 2026-09-29).
  const changesMemos = new Map<string, ChangesMemo>()
  const CHANGES_MEMO_MAX_SESSIONS = 64

  // A stopped session's transcript cannot grow until it is resumed, so once it has
  // been stopped and unused for a while its heavy parse state goes: every edit's
  // text, 2 to 50 MB a session, about half of this daemon's heap on 2026-10-26 (20
  // recent sessions held 150 MB). The light answer stays and serves changes.compute
  // while the transcript keeps its stat; a file click, or a compute after a resume,
  // reads the transcript from the start once. Not at exit: looking at a session's
  // changes and committing them right after it ends is the common case.
  const CHANGES_RELEASE_AFTER_MS = Number(daemonEnv.WALNUT_CHANGES_RELEASE_AFTER_MS) || 30 * 60_000
  function releaseIdleChangesState(now = Date.now()): void {
    for (const [sid, memo] of changesMemos) {
      if (sessions.get(sid)?.state === 'running' || changesInflightBySid.has(sid)) continue
      // From the later of the last use and the exit: a long turn nobody watched is
      // still looked at right after it ends.
      const lastUsed = Math.max(memo.lastUsed, changesCache.get(sid)?.lastUsed ?? 0, sessions.get(sid)?.exitedAt ?? 0)
      if (now - lastUsed < CHANGES_RELEASE_AFTER_MS) continue
      changesCache.delete(sid)
      if (memo.mainParse.state || memo.subCache.size) { memo.subCache = new Map(); memo.mainParse = {} }
    }
  }

  function evictLeastRecent<T extends { lastUsed: number }>(cache: Map<string, T>, max: number, keep: string): void {
    if (cache.size <= max) return
    let oldest: string | null = null
    let oldestTs = Infinity
    for (const [k, v] of cache) {
      if (v.lastUsed < oldestTs) { oldestTs = v.lastUsed; oldest = k }
    }
    if (oldest && oldest !== keep) cache.delete(oldest)
  }
  let changesInflight: Promise<void> = Promise.resolve()
  const changesInflightBySid = new Map<string, Promise<ChangesCacheEntry | null>>()

  async function computeChangesCached(sid: string, cwd: string | undefined, refresh?: boolean): Promise<ChangesCacheEntry | null> {
    // mtime+size fast-path — no lock needed for a pure cache hit. refresh
    // ("re-read the data") skips it but still reuses subCache/gitRoot memos.
    const cached = changesCache.get(sid)
    if (cached && !refresh) {
      try {
        const st = await fs.promises.stat(cached.output.jsonlPath)
        if (st.mtimeMs === cached.mtimeMs && st.size === cached.size) {
          cached.lastUsed = Date.now()
          return cached
        }
      } catch { /* stat failed → recompute below */ }
    }
    // Coalesce concurrent requests for the same sid.
    const existing = changesInflightBySid.get(sid)
    if (existing) return existing
    const run = (async (): Promise<ChangesCacheEntry | null> => {
      // Daemon-wide serial gate: chain onto whatever compute is running.
      const prev = changesInflight
      let release!: () => void
      changesInflight = new Promise<void>((r) => { release = r })
      await prev.catch(() => { /* prior failure doesn't gate us */ })
      try {
        // Created BEFORE the compute so its first run fills the same memos.
        const memo: ChangesMemo = changesMemos.get(sid)
          ?? { subCache: new Map(), gitRootByDir: new Map(), mainParse: {}, lastUsed: 0 }
        const startedAt = Date.now()
        const output = await computeHostLocalChanges({
          sessionId: sid,
          cwd,
          childProcess: childUse,
          claudeHome: CLAUDE_CONFIG_HOME,
          subCache: memo.subCache,
          gitRootByDir: memo.gitRootByDir,
          mainParse: memo.mainParse,
          checkpointDir: path.join(SERVICE_MODE && DAEMON_STATE_DIR ? DAEMON_STATE_DIR : DAEMON_DIR, 'changes-checkpoints'),
          // Fenced by the parser's own version (CHANGES_PARSER_VERSION), never
          // DAEMON_VERSION: a deploy keeps them. Keep in sync with the twin.
          reparse: refresh,
          // Files whose ops, stat and HEAD content are unchanged reuse their last
          // reconstruction; it lives and dies with the cached output.
          // Refresh ("re-read the data") rebuilds every file and asks git again.
          changesMemo: refresh ? undefined : changesCache.get(sid)?.output.changesMemo,
        })
        memo.lastUsed = Date.now()
        memo.light = output
          ? { mtimeMs: output.mtimeMs, size: output.size, jsonlPath: output.jsonlPath, result: toLightChangesResult(output.result) }
          : undefined
        changesMemos.set(sid, memo)
        evictLeastRecent(changesMemos, CHANGES_MEMO_MAX_SESSIONS, sid)
        if (!output) return null
        logMsg('info', 'changes.compute done', {
          sid, ms: memo.lastUsed - startedAt, resumed: output.parseStats.resumed,
          readBytes: output.parseStats.readBytes, subReadBytes: output.parseStats.subReadBytes ?? 0, size: output.size, files: output.result.fileCount,
          reconstructed: output.computeStats.reconstructed, reused: output.computeStats.reused,
          gitSpawns: output.computeStats.gitSpawns,
        })
        const entry: ChangesCacheEntry = { mtimeMs: output.mtimeMs, size: output.size, output, lastUsed: Date.now() }
        changesCache.set(sid, entry)
        // LRU bound — whale outputs hold full before/after strings.
        evictLeastRecent(changesCache, CHANGES_CACHE_MAX_SESSIONS, sid)
        return entry
      } finally {
        release()
        changesInflightBySid.delete(sid)
      }
    })()
    changesInflightBySid.set(sid, run)
    return run
  }

  /** The memo's light answer while the transcript still has the stat it came from. */
  async function lightChangesHit(sid: string): Promise<ChangesMemo['light'] | null> {
    const memo = changesMemos.get(sid)
    const light = memo?.light
    if (!memo || !light) return null
    try {
      const st = await fs.promises.stat(light.jsonlPath)
      if (st.mtimeMs !== light.mtimeMs || st.size !== light.size) return null
    } catch { return null }
    memo.lastUsed = Date.now()
    return light
  }

  let usageScanInflight: Promise<unknown> = Promise.resolve()
  const usagePages = createUsagePages()
  async function cmdUsageScan(ws: W, id: number, cmd: Record<string, unknown>) {
    if (typeof cmd.key === 'string') {
      try { return sendOk(ws, id, usagePages.page(cmd.key, typeof cmd.offset === 'number' ? cmd.offset : 0)) }
      catch (err) { return sendError(ws, id, String(err)) }
    }
    const until = typeof cmd.until === 'string' ? cmd.until : new Date().toISOString()
    const sessionIds = Array.isArray(cmd.sessionIds) ? cmd.sessionIds.filter((s): s is string => typeof s === 'string') : undefined
    const request = {
      projectsDir: path.join(daemonEnv.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude'), 'projects'),
      ...(typeof cmd.proxyLogDir === 'string' ? { proxyLogDir: cmd.proxyLogDir } : {}),
      ...(typeof cmd.since === 'string' ? { since: cmd.since } : {}), until, sessionIds,
      ...(cmd.outside === true ? { outside: true } : {}),
      // The transcript file index: a scan reads only what the files gained since the last one.
      indexDir: path.join(DAEMON_DIR, 'usage-scan-index'),
    }
    const run = () => {
      const work = usageScanInflight.catch(() => {}).then(() => scanHostUsage(request))
      usageScanInflight = work.then(() => {}, () => {})
      return work
    }
    try { sendOk(ws, id, await usagePages.scan(request, run)) }
    catch (err) { sendError(ws, id, 'usage.scan failed: ' + (err as Error).message) }
  }
  async function cmdUsageCostState(ws: W, id: number, cmd: Record<string, unknown>) {
    if (typeof cmd.sid !== 'string') return sendError(ws, id, 'usage.costState: missing sid')
    try {
      const result = await scanCostState({
        projectsDir: path.join(daemonEnv.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude'), 'projects'),
        sessionId: cmd.sid, ...(typeof cmd.cwd === 'string' ? { cwd: cmd.cwd } : {}),
      })
      sendOk(ws, id, { result })
    } catch (err) { sendError(ws, id, 'usage.costState failed: ' + (err as Error).message) }
  }

  // 'session-cost-v1': one session's per-request usage, folded host-side from the
  // engine's own records (session-cost-core.ts); 'session-cost-day-v1' adds the
  // optional `byDay` split.
  async function cmdUsageSessionCost(ws: W, id: number, cmd: Record<string, unknown>) {
    if (typeof cmd.sid !== 'string' || !cmd.sid) return sendError(ws, id, 'usage.sessionCost: missing sid')
    try {
      const result = await scanSessionCost({
        engine: typeof cmd.engine === 'string' ? cmd.engine : 'claude',
        sessionId: cmd.sid,
        ...(typeof cmd.cwd === 'string' ? { cwd: cmd.cwd } : {}),
        thresholds: Array.isArray(cmd.thresholds) ? cmd.thresholds.filter((t): t is number => typeof t === 'number') : [],
        projectsDir: path.join(daemonEnv.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude'), 'projects'),
        ...(cmd.byDay && typeof (cmd.byDay as { timeZone?: unknown }).timeZone === 'string'
          ? { byDay: { timeZone: (cmd.byDay as { timeZone: string }).timeZone } } : {}),
      })
      sendOk(ws, id, { result })
    } catch (err) { sendError(ws, id, 'usage.sessionCost failed: ' + (err as Error).message) }
  }

  // 'codex-outside-v1': Codex runs no Walnut session started (an agent's `codex exec`, the
  // desktop app), read from Codex's own rollout files, one time-budgeted page per call
  // (codex-outside-core.ts). Read-only.
  async function cmdUsageCodexOutside(ws: W, id: number, cmd: Record<string, unknown>) {
    const zone = (cmd.byDay as { timeZone?: unknown } | undefined)?.timeZone
    try {
      const result = await scanCodexOutside({
        byDay: { timeZone: typeof zone === 'string' ? zone : 'UTC' },
        thresholds: Array.isArray(cmd.thresholds) ? cmd.thresholds.filter((t): t is number => typeof t === 'number') : [],
        knownSessionIds: Array.isArray(cmd.known) ? cmd.known.filter((s): s is string => typeof s === 'string') : [],
        ...(typeof cmd.since === 'string' ? { since: cmd.since } : {}),
        ...(typeof cmd.cursor === 'string' ? { cursor: cmd.cursor } : {}),
        ...(typeof cmd.budgetMs === 'number' ? { budgetMs: Math.min(Math.max(cmd.budgetMs, 1000), 30_000) } : {}),
      })
      sendOk(ws, id, { result })
    } catch (err) { sendError(ws, id, 'usage.codexOutside failed: ' + (err as Error).message) }
  }

  async function cmdChangesCompute(ws: W, id: number, cmd: Record<string, unknown>) {
    const sid = cmd.sid as string
    if (!sid) return sendError(ws, id, 'changes.compute: missing sid')
    const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined
    const refresh = cmd.refresh === true
    try {
      const light = refresh ? null : await lightChangesHit(sid)
      if (light) {
        return sendOk(ws, id, { found: true, result: light.result, mtimeMs: light.mtimeMs, jsonlPath: light.jsonlPath })
      }
      const entry = await computeChangesCached(sid, cwd, refresh)
      if (!entry) return sendOk(ws, id, { found: false, result: null })
      // The wire result is ALWAYS light — per-file content rides changes.file.
      sendOk(ws, id, {
        found: true,
        result: toLightChangesResult(entry.output.result),
        mtimeMs: entry.mtimeMs,
        jsonlPath: entry.output.jsonlPath,
      })
    } catch (err) {
      sendError(ws, id, 'changes.compute failed: ' + (err as Error).message)
    }
  }

  async function cmdChangesFile(ws: W, id: number, cmd: Record<string, unknown>) {
    const sid = cmd.sid as string
    const filePath = cmd.path as string
    if (!sid) return sendError(ws, id, 'changes.file: missing sid')
    if (!filePath) return sendError(ws, id, 'changes.file: missing path')
    const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined
    try {
      // Serve from the cached full output even when slightly stale (mtime moved):
      // a file click must not wait behind a whale recompute. The list refresh
      // converges the frontend's per-file cache.
      let entry = changesCache.get(sid)
      if (!entry) entry = (await computeChangesCached(sid, cwd)) ?? undefined
      if (!entry) return sendOk(ws, id, { found: false })
      entry.lastUsed = Date.now()
      for (const group of entry.output.result.groups) {
        const file = group.files.find((f) => f.filePath === filePath)
        if (file) return sendOk(ws, id, { found: true, repoRoot: group.repoRoot, file })
      }
      sendOk(ws, id, { found: false })
    } catch (err) {
      sendError(ws, id, 'changes.file failed: ' + (err as Error).message)
    }
  }

  // ── Session commit (host-local, capability 'git-commit-v1') ──
  // PARITY: The logic is git-commit-core.ts +
  // git-attribution-core.ts (shared with the source twin); this twin only hands
  // the plan the session's ops from the changes cache and tracks commit jobs on
  // the command drain, so a shutdown waits for a commit instead of cutting it.
  const gitCommit = createGitCommitCore({
    spawn: spawn as unknown as import('./git-commit-core.js').GitCommitDeps['spawn'],
    fs: fs as unknown as import('./git-commit-core.js').GitCommitDeps['fs'],
    path, tmpdir: () => os.tmpdir(), env: daemonEnv,
    attribution: createGitAttribution(),
    randomId: () => crypto.randomBytes(6).toString('hex'),
    killGroup: (pid) => { if (pid > 1) process.kill(-pid, 'SIGKILL') },
    log: (level, msg, data) => logMsg(level, msg, data),
  })

  async function cmdGitCommitPlan(ws: W, id: number, cmd: Record<string, unknown>) {
    try {
      const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
      const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined
      const entry = sid ? await computeChangesCached(sid, cwd).catch(() => null) : null
      const changes = entry ? { groups: entry.output.result.groups, fileMap: entry.output.fileMap } as unknown as PlanChanges : null
      sendOk(ws, id, await gitCommit.plan(cmd, changes) as unknown as Record<string, unknown>)
    } catch (err) {
      sendError(ws, id, 'git.commitPlan failed: ' + (err as Error).message)
    }
  }

  function cmdGitCommitStart(ws: W, id: number, cmd: Record<string, unknown>) {
    try {
      daemonCommands.run(() => {
        const started = gitCommit.start(cmd)
        sendOk(ws, id, { job: started.job })
        return started.done
      })
    } catch (err) {
      sendError(ws, id, 'git.commitStart failed: ' + (err as Error).message, { code: (err as { code?: string }).code ?? 'failed' })
    }
  }

  return {
    cmdChangesCompute, cmdChangesFile,
    cmdUsageScan, cmdUsageCostState, cmdUsageSessionCost, cmdUsageCodexOutside,
    cmdGitCommitPlan, cmdGitCommitStart, gitCommit,
    computeChangesCached, releaseIdleChangesState, CHANGES_RELEASE_AFTER_MS,
  }
}
