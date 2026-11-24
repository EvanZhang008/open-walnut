/**
 * The session daemon's reads of a session's transcript and working tree, run on this host:
 * transcript.rewindProbe ('rewind-probe-v1'), history.readyView / history.readyKeys
 * ('history-ready-v1', the wire of the runtime's history-ready worker), the per-turn
 * working-tree snapshots and rewind guard (turns.*: 'turn-snapshot-v1'), and the scans of
 * sessions started outside Walnut (sessions.discoverExternal / sessions.describeExternal).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), whose command table
 * takes the returned answers by name; its session code calls turnSnapshots at a turn's start and end.
 * The code is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { probeTranscriptRewindHostLocal, type RewindProbeInput, type RewindProbeOutput } from './transcript-rewind-core.js'
import { readyRequestFromWire, type createHistoryReady } from './history-ready-core.js'
import { createTurnSnapshots } from './turn-snapshot-core.js'
import { createTurnGuard } from './turn-guard-core.js'
import { describeExternalSessions, scanExternalSessions } from './external-session-scan-core.js'
import type { ChildProcessFns } from './daemon-child-spawn.js'
import type { createWalnutScope } from './walnut-scope-core.js'
import type { createDaemonChanges } from './daemon-changes.js'
import { ok, fail, type Answer, type Answers, type DaemonEnv, type DaemonLog } from './daemon-module-deps.js'

export interface DaemonTranscriptsDeps<W extends object> {
  daemonEnv: DaemonEnv
  DAEMON_DIR: string
  /** The CLI's config home (CLAUDE_CONFIG_DIR or ~/.claude). */
  CLAUDE_CONFIG_HOME: string
  /** The runtime's execFile, for the snapshots' git runs. */
  execFileCb: ChildProcessFns['execFile']
  /** Each Walnut's own dir under the runtime's (turn snapshot settings are per Walnut). */
  walnutScope: ReturnType<typeof createWalnutScope>
  /** The Walnut each trusted socket speaks for. */
  gatewayClientHomes: WeakMap<W, string>
  /** The Walnut a session belongs to. */
  sessionHomeOf: (sid: string) => string
  /** The runtime's sessions, read only: a turn in progress is not snapshotted twice. */
  sessions: { get(sid: string): { foldState: { turnActive?: boolean } } | undefined }
  /** The changes compute (daemon-changes.ts): the rewind guard reads a session's own edits. */
  computeChangesCached: ReturnType<typeof createDaemonChanges>['computeChangesCached']
  /** The runtime's history-ready view (its worker lives with the runtime's entry). */
  historyReady: ReturnType<typeof createHistoryReady>
  logMsg: DaemonLog
}

export function createDaemonTranscripts<W extends object>(deps: DaemonTranscriptsDeps<W>) {
  const { daemonEnv, DAEMON_DIR, CLAUDE_CONFIG_HOME, execFileCb, walnutScope, gatewayClientHomes, sessionHomeOf, sessions, computeChangesCached, historyReady, logMsg } = deps

  // ── Transcript rewind probe (host-local — capability 'rewind-probe-v1') ──
  // Rewind's three questions about a session's JSONL (is this uuid resumable, what
  // is the current last tree line, which lines are dead for display) are pure
  // functions of the file, so they run HERE instead of shuttling the whole
  // transcript over the tunnel — which the byte ceiling refuses outright on a long
  // one. Deliberately UNCACHED: every caller asks precisely because the file may
  // have changed, and a host-local read of even a very large transcript is seconds.
  //
  // Concurrency is gated exactly like changes.compute (a streaming read of the same
  // files): one probe at a time daemon-wide, and identical in-flight requests share
  // ONE promise. The coalescing key is the whole request, not the sid: two callers
  // asking DIFFERENT questions about the same session (is uuid X resumable vs. what
  // is dead for these cuts) get different answers, so sharing by sid would hand one
  // of them the other's reply.
  let rewindProbeInflight: Promise<void> = Promise.resolve()
  const rewindProbeInflightByKey = new Map<string, Promise<RewindProbeOutput | null>>()

  function rewindProbeKey(input: RewindProbeInput): string {
    return [
      input.sessionId,
      input.cwd ?? '',
      input.uuid ?? '',
      (input.cuts ?? []).map((c) => c.uuid + '>' + c.lastUuidAtCommit).join(','),
    ].join('|')
  }

  async function probeTranscriptRewindGated(input: RewindProbeInput): Promise<RewindProbeOutput | null> {
    const key = rewindProbeKey(input)
    const existing = rewindProbeInflightByKey.get(key)
    if (existing) return existing
    const run = (async (): Promise<RewindProbeOutput | null> => {
      const prev = rewindProbeInflight
      let release!: () => void
      rewindProbeInflight = new Promise<void>((r) => { release = r })
      await prev.catch(() => { /* prior failure doesn't gate us */ })
      try {
        return await probeTranscriptRewindHostLocal(input)
      } finally {
        release()
        rewindProbeInflightByKey.delete(key)
      }
    })()
    rewindProbeInflightByKey.set(key, run)
    return run
  }

  async function cmdTranscriptRewindProbe(cmd: Record<string, unknown>): Promise<Answer> {
    const sid = cmd.sid as string
    if (!sid) return fail('transcript.rewindProbe: missing sid')
    const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined
    const uuid = typeof cmd.uuid === 'string' && cmd.uuid ? cmd.uuid : undefined
    const cuts = Array.isArray(cmd.cuts)
      ? (cmd.cuts as Array<Record<string, unknown>>)
        .filter((c) => c && typeof c.uuid === 'string' && typeof c.lastUuidAtCommit === 'string')
        .map((c) => ({
          uuid: c.uuid as string,
          lastUuidAtCommit: c.lastUuidAtCommit as string,
          ...(Array.isArray(c.trailingQueueKeys)
            ? { trailingQueueKeys: (c.trailingQueueKeys as unknown[]).filter((k): k is string => typeof k === 'string') }
            : {}),
        }))
      : undefined
    try {
      const output = await probeTranscriptRewindGated({
        sessionId: sid,
        cwd,
        claudeHome: CLAUDE_CONFIG_HOME,
        ...(uuid ? { uuid } : {}),
        ...(cuts ? { cuts } : {}),
      })
      if (!output) return ok({ found: false })
      return ok({ found: true, ...output } as unknown as Record<string, unknown>)
    } catch (err) {
      return fail('transcript.rewindProbe failed: ' + (err as Error).message)
    }
  }

  // ── A session's first-paint view ('history-ready-v1'): the wire of the runtime's historyReady ──
  async function cmdHistoryReadyView(cmd: Record<string, unknown>): Promise<Answer> {
    try {
      const answer = await historyReady.readyView(readyRequestFromWire(cmd, CLAUDE_CONFIG_HOME))
      return ok({ ...answer })
    } catch (err) {
      return fail('history.readyView failed: ' + (err as Error).message)
    }
  }

  async function cmdHistoryReadyKeys(cmd: Record<string, unknown>): Promise<Answer> {
    try {
      const items = Array.isArray(cmd.items) ? (cmd.items as Array<Record<string, unknown>>).slice(0, 500) : []
      const keys = await historyReady.readyKeys(items.map((item) => readyRequestFromWire(item, CLAUDE_CONFIG_HOME)), CLAUDE_CONFIG_HOME)
      return ok({ keys })
    } catch (err) {
      return fail('history.readyKeys failed: ' + (err as Error).message)
    }
  }

  // ── Per-turn working-tree snapshots + the rewind guard ('turn-snapshot-v1') ──
  // The git work lives in turn-snapshot-core.ts, the guard's verdict in
  // turn-guard-core.ts. The tailer calls onTurnEnd at every result line and
  // onTurnStart at spawn; both return at once.
  const turnSnapshots = createTurnSnapshots({
    execFile: execFileCb as unknown as import('./turn-snapshot-core.js').TurnSnapshotExecFile,
    fs: fs.promises as unknown as import('./turn-snapshot-core.js').TurnSnapshotFs,
    path,
    env: daemonEnv,
    tmpDir: path.join(DAEMON_DIR, 'turn-snapshots'),
    settingsPath: path.join(DAEMON_DIR, 'turn-snapshots.json'),
    // Each Walnut's own settings; a session's turn follows its Walnut's (else the unnamed copy).
    settingsPathFor: (home) => path.join(walnutScope.dirFor(DAEMON_DIR, home), 'turn-snapshots.json'),
    homeOf: (sid) => sessionHomeOf(sid),
    log: (level, msg, data) => logMsg(level, msg, data),
    turnActive: (sid) => sessions.get(sid)?.foldState.turnActive === true,
    forceDisabled: daemonEnv.WALNUT_TURN_SNAPSHOTS === '0',
  })
  const turnGuard = createTurnGuard({
    compare: (sid, cwd, files, budgetMs) => turnSnapshots.compareToLatest(sid, cwd, files, budgetMs),
    repoRootOf: (cwd) => turnSnapshots.repoRootOf(cwd),
    sessionOps: async (sid, cwd) => (await computeChangesCached(sid, cwd))?.output.fileMap ?? null,
    realpath: (p) => fs.promises.realpath(p),
    log: (level, msg, data) => logMsg(level, msg, data),
  })

  async function cmdTurns(cmd: Record<string, unknown>, from: W): Promise<Answer> {
    const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
    const cwd = typeof cmd.cwd === 'string' ? cmd.cwd : ''
    try {
      switch (cmd.cmd) {
        case 'turns.configure': {
          const scope = walnutScope.resolve(cmd, gatewayClientHomes.get(from), 'turns.configure')
          if (!scope.ok) return fail(scope.error, { code: 'not_owner' })
          return ok(await turnSnapshots.configure({ enabled: cmd.enabled, keep: cmd.keep }, scope.home))
        }
        case 'turns.list':
          return ok(await turnSnapshots.list(sid, cwd) as unknown as Record<string, unknown>)
        case 'turns.diff':
          return ok(await turnSnapshots.fileDiff(sid, cwd, Number(cmd.n), String(cmd.path ?? ''),
            cmd.against === 'worktree' ? 'worktree' : 'previous') as unknown as Record<string, unknown>)
        case 'turns.restore':
          return ok(await turnSnapshots.restore({
            sid, cwd, n: Number(cmd.n), dryRun: cmd.dryRun === true,
            ...(Array.isArray(cmd.paths) ? { paths: (cmd.paths as unknown[]).map(String) } : {}),
          }) as unknown as Record<string, unknown>)
        case 'turns.guard':
          return ok(await turnGuard.guard({ sid, cwd, files: cmd.files, siblings: cmd.siblings }) as unknown as Record<string, unknown>)
      }
      return fail('turns: unknown command')
    } catch (err) {
      const code = (err as { code?: unknown }).code
      return fail(String(cmd.cmd) + ' failed: ' + (err as Error).message, typeof code === 'string' ? { code } : undefined)
    }
  }

  // ── Discover sessions started OUTSIDE Walnut (capability 'external-scan-v1') ──
  // Host-local by design: this host owns thousands of transcript files, so the
  // walk + head/tail parse happen HERE and only the small descriptor list crosses
  // the tunnel. Serialized daemon-wide (one scan at a time) so a burst of server
  // ticks can't stack concurrent directory walks.
  let externalScanInflight: Promise<void> = Promise.resolve()

  async function cmdDiscoverExternalSessions(cmd: Record<string, unknown>): Promise<Answer> {
    const prev = externalScanInflight
    let release!: () => void
    externalScanInflight = new Promise<void>((r) => { release = r })
    await prev.catch(() => {})
    try {
      const sinceMs = typeof cmd.sinceMs === 'number' && cmd.sinceMs > 0
        ? cmd.sinceMs
        : 30 * 24 * 60 * 60 * 1000
      const knownSessionIds = Array.isArray(cmd.knownSessionIds)
        ? (cmd.knownSessionIds as unknown[]).filter((s): s is string => typeof s === 'string')
        : []
      const limit = typeof cmd.limit === 'number' && cmd.limit > 0 ? cmd.limit : undefined
      const t0 = Date.now()
      const excludedCwds = Array.isArray(cmd.excludedCwds)
        ? cmd.excludedCwds.filter((value): value is string => typeof value === 'string') : []
      const result = await scanExternalSessions({ sinceMs, knownSessionIds, excludedCwds, limit })
      logMsg('info', 'external session scan', {
        scanned: result.scanned,
        parsed: result.parsed,
        found: result.candidates.length,
        truncated: result.truncated,
        ms: Date.now() - t0,
      })
      return ok({
        candidates: result.candidates,
        scanned: result.scanned,
        truncated: result.truncated,
      })
    } catch (err) {
      return fail('sessions.discoverExternal failed: ' + (err as Error).message)
    } finally {
      release()
    }
  }

  // ── Re-read specific external transcripts by id (capability 'external-describe-v1') ──
  // The scan above is windowed by mtime; the server asks here for the sessions it
  // imported with a placeholder title whose files may have aged out of that
  // window, and retitles from the answer. Same serialization as the scan.
  async function cmdDescribeExternalSessions(cmd: Record<string, unknown>): Promise<Answer> {
    const prev = externalScanInflight
    let release!: () => void
    externalScanInflight = new Promise<void>((r) => { release = r })
    await prev.catch(() => {})
    try {
      const sessionIds = Array.isArray(cmd.sessionIds)
        ? (cmd.sessionIds as unknown[]).filter((s): s is string => typeof s === 'string')
        : []
      const activityOnly = cmd.activityOnly === true
      const t0 = Date.now()
      const result = await describeExternalSessions({ sessionIds, activityOnly })
      logMsg('info', 'external session describe', {
        asked: sessionIds.length, activityOnly,
        found: activityOnly ? result.activity.length : result.candidates.length, ms: Date.now() - t0,
      })
      return ok({ candidates: result.candidates, activity: result.activity })
    } catch (err) {
      return fail('sessions.describeExternal failed: ' + (err as Error).message)
    } finally {
      release()
    }
  }

  const answers: Answers<W> = {
    'transcript.rewindProbe': cmdTranscriptRewindProbe,
    'history.readyView': cmdHistoryReadyView, 'history.readyKeys': cmdHistoryReadyKeys,
    'turns.list': cmdTurns, 'turns.diff': cmdTurns, 'turns.restore': cmdTurns, 'turns.guard': cmdTurns, 'turns.configure': cmdTurns,
    'sessions.discoverExternal': cmdDiscoverExternalSessions, 'sessions.describeExternal': cmdDescribeExternalSessions,
  }

  return { answers, turnSnapshots }
}
