/**
 * Guard: in a leader switch's stop, nothing this server runs still writes the home's leader data while the final
 * batch copies it (src/web/server.ts stopWritersForSwitch, docs/reference/leader-switch.md "The switch stop").
 *
 * Found by a 20 GB rehearsal between machines (2026-11-24): after "the switch stop begins" the old leader's log still
 * had two git-sync lines (a commit of the routine files, and "committed large files {files: 1, waiting: 19}"): the
 * auto-commit's stop() only cleared its timer, its tick and its background `git hash-object -w` lane ran on, the
 * final batch found `.git` changing until the commit window ended, and the switch rolled back after 6 min with no
 * leader, its refusal blaming "a writer outside Walnut".
 *
 * The class, from the source:
 *  - every stop of stopServer that is NOT awaited is listed below with what may still run after it: `settled`
 *    (stopWritersForSwitch stops it at the switch stop's start, and what outlives that, a git child or the forked
 *    rewrite, is waited for before the final batch), `short` (an in-process tick already past its check may land one
 *    store write in leader data; the final batch's next pass carries it), `none` (nothing in flight writes leader
 *    data: timers only, memory, the network, machine or rebuildable places). A new stop fails here until it is
 *    classified; a `settled` one must be in stopWritersForSwitch;
 *  - every git child outside git-sync.ts is pinned with where it runs, and so is every file that builds a git
 *    child's environment (gitChildEnv: a git started through a variable): a git under the home must go through
 *    the spawners of git-children.ts's rule, which refuse a start in a quiet home and let quietGitWriters end it;
 *  - every forked Node child of the server is pinned, and the history rewrite's is tracked for the stop.
 * The classes of the `short` and `none` entries come from a read of each stop and of the work it controls
 * (2026-11-24); where a write lands is the home manifest's (src/core/home-manifest/home-entries.ts).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { clockFiles, clocksIn, codeOf, rearmingFiles, rearmingIn, sourcesUnder } from './clock-scan.js'
import { CLOCKS, REARMING, STARTERS, type Clock } from './clock-table.js'

const ROOT = path.resolve(__dirname, '../../../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

type Kind = 'settled' | 'short' | 'none'
const STOPS: Record<string, [Kind, string]> = {
  // ---- settled: outlive their stop, stopped and waited for by stopWritersForSwitch ----
  stopWritersForSwitch: ['settled', 'the switch stop\'s own: git quiet, the auto-commit and the standby stopped at the entry'],
  'gitAutoCommitHandle.stop': ['settled', 'its tick, boot commit, pulls and large-file lane (git children writing .git); no last commit in a switch stop'],
  'gitMaintenanceHandle.stop': ['settled', 'a gc or repack in flight (a git child writing .git)'],
  'standbyHandle.stop': ['settled', 'its periodic batches: stopped at the entry, not waited for (its side here writes only tmp/, rebuildable); an apply of its last batch on the other machine is waited out by the final batch'],
  // ---- awaited later in stopServer ----
  'leaderPermitHandle.stop': ['none', 'its promise is awaited at the end (leader permit release); witness records, never the home'],
  stopInProcessDaemon: ['none', 'its promise is awaited at "in-process daemon"; the daemon dir is daemon state, not leader data'],
  // ---- short: an in-process tick in flight may land one store write in leader data ----
  'leaderLoopHandle.stop': ['short', 'the test-run sweep deletes tasks, the task-dir sweep writes cache/task-dir-size-notices.json'],
  stopOrgDuties: ['short', 'a reflection pass in flight writes org-reflection'],
  'healthMonitor.stop': ['short', 'a runPeriodic tick in flight updates a session record'],
  'sideThreadManager.stop': ['short', 'updates a session record'],
  'sessionReaper.stop': ['short', 'deletes session records'],
  stopUserStatusSync: ['short', 'a tick in flight updates a task'],
  stopStatusPush: ['short', 'its returned stopRiding() writes cache/status-riding.json'],
  stopNeedsRecheck: ['short', 'a recheck in flight updates a task'],
  stopStartQueue: ['short', 'a start in flight starts a session (session records)'],
  stopBriefRefreshLooks: ['short', 'a look in flight enqueues text for a session'],
  stopStatusReconcile: ['short', 'a pass in flight writes cache/status-reconcile.json'],
  stopStatusCheck: ['short', 'its tick writes status-check-told.json'],
  stopCompleteArchive: ['short', 'writeJsonFile of the archive state'],
  stopTriggerCompletionPause: ['short', 'writeJsonFile of the pause state'],
  stopLeadWaits: ['short', 'a check in flight updates a task'],
  'triageRunsHandle.stop': ['short', 'a handler in flight completes the task and appends the runs note'],
  'recordingReaperHandle.stop': ['short', 'removes old files under tmp/recordings'],
  'replaySweeperHandle.stop': ['short', 'a sweep in flight removes old browser replays'],
  'diskWatermarkHandle.stop': ['short', 'a poll in flight may write notifications.json'],
  'restoreDrillHandle.stop': ['short', 'runs in the OS temp dir; its end may write notifications.json'],
  'revokeQueueHandle.stop': ['short', 'a drain in flight writes push tokens into config.yaml'],
  'threadFollowHandle.stop': ['short', 'a sweep in flight writes threads (org/)'],
  'threadRepliesHandle.stop': ['short', 'a sweep in flight writes threads (org/)'],
  'letterThreadsHandle.stop': ['short', 'a sweep in flight writes letters (human-inbox/)'],
  'choiceThreadsHandle.stop': ['short', 'a sweep in flight writes threads (org/)'],
  'threadAnswersHandle.stop': ['short', 'a sweep in flight writes threads (org/)'],
  'topicsHandle.stop': ['short', 'its live loop stops; a round in flight may write its topics store'],
  'budgetLettersHandle.stop': ['short', 'a runPeriodic sweep in flight writes letters'],
  'pinRetirementHandle.stop': ['short', 'a runPeriodic sweep in flight updates tasks'],
  'h.stop': ['short', 'the thread AI handles: a reply in flight writes its thread'],
  'endpointWaitHandle.stop': ['short', 'a session state machine: a step in flight updates a session'],
  'promptRefreshRespawnHandle.stop': ['short', 'a session state machine: a step in flight updates a session'],
  'idleCompactionHandle.stop': ['short', 'a session state machine: a step in flight updates a session'],
  'safeguardSwitchHandle.stop': ['short', 'a session state machine: a step in flight updates a session'],
  'modelRestoreHandle.stop': ['short', 'a session state machine: a step in flight updates a session'],
  'contextFullRecoveryHandle.stop': ['short', 'a session state machine: a step in flight updates a session'],
  'usageLimitWaitHandle.stop': ['short', 'a session state machine: a step in flight updates a session'],
  'autoContinueHandle.stop': ['short', 'a session state machine: a step in flight enqueues a message'],
  'turnRunHandle.stop': ['short', 'a step in flight updates a session'],
  'autoRecoverHandle.stop': ['short', 'a step in flight enqueues or starts a session'],
  'pluginAutoUpdateHandle.stop': ['short', 'a round in flight writes plugin-stores (rebuildable) and reloads a plugin'],
  stopTimeTracking: ['short', 'an async bank() in flight appends to time-tracking/<day>.jsonl'],
  'hookDispatcher.destroy': ['short', 'a hook in flight may write its session\'s records'],
  'sessionRunner.destroy': ['short', 'detaches; a daemon event in flight may update a session record'],
  // ---- none: nothing in flight writes leader data ----
  'localDaemonLane.stop': ['none', 'the local daemon\'s link lane: the network'],
  closeDaemonDials: ['none', 'no daemon link is dialled: the network'],
  'serverPortHold.release': ['none', 'a port'],
  'hostReplicaAway.stop': ['none', 'a timer asking the link'],
  stopMemoryPressureMonitor: ['none', 'a timer reading memory'],
  closeApiV1Streams: ['none', 'SSE streams'],
  closeAllBridges: ['none', 'daemon bridge sockets'],
  stopCloudBoxHost: ['none', 'the pairing probe: the network'],
  closeAllDaemonTunnels: ['none', 'tunnels'],
  disposeRouterWake: ['none', 'in memory'],
  disposeCoreServices: ['none', 'in memory'],
  'historyReadyRefresher.stop': ['none', 'writes cache/history (rebuildable)'],
  'changesPrewarmer.stop': ['none', 'writes cache/session-changes (rebuildable)'],
  'hostWarmup.stop': ['none', 'warms host links: the network'],
  stopHealthMonitor: ['none', 'timers; reads'],
  stopHealthErrorWatch: ['none', 'a log subscriber'],
  stopHostDownWatch: ['none', 'a gauge in memory'],
  stopRealUse: ['short', 'its stop flushes once into local/usage-watch.sqlite (leader data, home-nested-entries.ts local.usage-watch)'],
  stopBoardReminders: ['none', 'its subscriber and timer; a reminder goes out through a door, which is closed'],
  stopBoardKanbanWatch: ['none', 'a watcher'],
  'routineWakeHandle.stop': ['none', 'a timer'],
  'triageConfigWatcher.stop': ['none', 'a file watcher'],
  'collector.stop': ['none', 'its flush was awaited just before'],
  'terminalReaperHandle.stop': ['none', 'local terminal ptys'],
  'subagentRunner.destroy': ['none', 'clears its maps; the subagents were detached (awaited) before'],
  'notesWatcherHandle.stop': ['none', 'the reindex writes notes-index.sqlite and search.sqlite (rebuildable)'],
  cancelNotesWarmup: ['none', 'the same index (rebuildable)'],
  uninstallLogErrorNotifications: ['none', 'a log subscriber'],
  'backupSchedulerHandle.stop': ['none', 'a backup in flight writes tmp/backup-staging, local/backup and its destination, never leader data'],
  'keepAwakeHandle.stop': ['none', 'pmset; its release is awaited'],
  'sendPathCanaryHandle.stop': ['none', 'the companion\'s; machine places'],
  'taskProjectionHandle.stop': ['none', 'writes cache/projections (rebuildable; the legacy files only with sync.legacy_projection_files)'],
  'sessionProjectionHandle.stop': ['none', 'writes cache/transcripts (rebuildable)'],
  'projectionSelfHealHandle.stop': ['none', 'the projections above (rebuildable)'],
  'taskQueueFlushHandle.stop': ['none', 'the companion\'s cache/task-queue (machine)'],
  'controlQueueFlushHandle.stop': ['none', 'the companion\'s cache/control-queue (machine)'],
  'sendQueueFlushHandle.stop': ['none', 'the companion\'s cache/send-queue (machine)'],
  'cloudChatOutboxFlushHandle.stop': ['none', 'the companion\'s cache/cloud-chat-outbox (machine)'],
  'humanInboxQueueFlushHandle.stop': ['none', 'the companion\'s queue (machine)'],
  'companionJournalDueHandle.stop': ['none', 'the companion\'s'],
  'companionCardsHandle.stop': ['none', 'the companion\'s'],
  'companionUsesHandle.stop': ['none', 'the companion\'s real-use sends (cloud companion only, never a leader)'],
  stopMobileEventsFeed: ['none', 'a feed in memory'],
  stopQuiet: ['none', 'in memory'],
  stopOverviewMaintainer: ['none', 'in memory'],
  'terminalManager.shutdown': ['none', 'local ptys'],
  closeWss: ['none', 'sockets'],
  'foreignWriterWatchdog.stop': ['none', 'a watchdog reading the home'],
  releaseInstanceLock: ['none', 'server.lock.json (machine data)'],
  releaseSelfApiRoot: ['none', 'in memory'],
}

/** The body of a top-level function of `src`, without comments. */
function functionBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  if (start < 0) throw new Error(`${signature} not found`)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start + signature.length, end)
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/[^'"`]*$/, '').replace(/\/\*[^*]*\*\//g, ''))
    .join('\n')
}

/** Every stop-like call of stopServer, and whether it is awaited (its line awaits, or it is inside an awaited shutdownStep). */
function stopCalls(): Array<{ key: string; awaited: boolean }> {
  const body = functionBody(read('src/web/server.ts'), 'export async function stopServer(')
  const awaitedSpans: Array<[number, number]> = []
  for (let at = body.indexOf('await shutdownStep('); at >= 0; at = body.indexOf('await shutdownStep(', at + 1)) {
    let depth = 0
    let i = body.indexOf('(', at)
    for (; i < body.length; i++) { if (body[i] === '(') depth++; else if (body[i] === ')' && --depth === 0) break }
    awaitedSpans.push([at, i])
  }
  const out: Array<{ key: string; awaited: boolean }> = []
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\(/g)) {
    const chain = m[1]!.replace(/\?\./g, '.')
    if (!/^(stop|destroy|dispose|shutdown|close|release|uninstall|cancel)/.test(chain.split('.').at(-1)!)) continue
    const pos = m.index!
    const line = body.slice(body.lastIndexOf('\n', pos) + 1, pos)
    out.push({ key: chain.replace(/^m\./, ''), awaited: /\bawait\b/.test(line) || awaitedSpans.some(([a, b]) => pos > a && pos < b) })
  }
  return out
}

describe('the switch stop\'s writers, from stopServer', () => {
  it('every stop of stopServer that is not awaited is classified (a new one: say what may still write after it)', () => {
    const unawaited = [...new Set(stopCalls().filter((c) => !c.awaited).map((c) => c.key))]
    expect(unawaited.length).toBeGreaterThan(50)
    const unknown = unawaited.filter((k) => !STOPS[k])
    expect(unknown, `classify these in STOPS (settled / short / none, and why): ${unknown.join(', ')}`).toEqual([])
  })

  it('every classified stop is still there (a removed one leaves the table)', () => {
    const found = new Set(stopCalls().map((c) => c.key))
    const stale = Object.keys(STOPS).filter((k) => !found.has(k))
    expect(stale).toEqual([])
  })

  it('each settled one is stopped by stopWritersForSwitch, and the final batch runs only after its settle', () => {
    const server = read('src/web/server.ts')
    const writers = functionBody(server, 'function stopWritersForSwitch(')
    for (const [key, [kind]] of Object.entries(STOPS)) {
      if (kind !== 'settled' || key === 'stopWritersForSwitch') continue
      expect(writers, key).toContain(key.split('.')[0])
    }
    expect(writers).toContain('quietGitWriters(WALNUT_HOME')
    expect(writers).toContain('finalCommit: false')
    expect(writers).toContain('compactionChild')
    const stop = functionBody(server, 'export async function stopServer(')
    // Stopped before the first await of the stop, settled right before the final batch.
    const entry = stop.indexOf('stopWritersForSwitch(')
    expect(entry).toBeGreaterThan(0)
    expect(stop.slice(0, entry)).not.toMatch(/\bawait\b/)
    expect(stop.indexOf('settleWritersForSwitch(')).toBeLessThan(stop.indexOf('finalStop.run('))
  })
})

/** Files with their exact count of git children spawned outside git-sync.ts, and where those run. */
const GIT_CHILDREN: Record<string, [number, string]> = {
  'src/providers/session-changes-core.ts': [1, 'reads a session\'s work dir (git diff), never the home'],
  'src/providers/turn-snapshot-core.ts': [1, 'snapshots a session\'s work dir into its own refs, never the home'],
  'src/web/routes/git-http.ts': [1, 'the companion\'s hub repo, never a leader\'s home'],
  'src/web/routes/git-bundle-push.ts': [2, 'the companion\'s hub repo, never a leader\'s home'],
  'src/core/self-repair/walnut-source.ts': [2, '`git --version`, and Walnut\'s own source checkout (self-repair), never the home'],
  'src/hooks/on-stop.ts': [1, 'a session\'s Stop hook: its own process, in the session\'s work dir'],
  'src/core/data-copy-compact.ts': [1, '`git check-ignore` of a copy it may compact: reads the index, takes no lock, writes nothing'],
  'src/integrations/git-bundle-client.ts': [1, 'a bundle of the home\'s repo: refused in a quiet home and tracked for the stop (git-children.ts)'],
  'src/integrations/git-compaction-chain.ts': [1, 'the history rewrite\'s chain (cat-file, hash-object): runs in the forked compaction worker, which the switch stop waits for and which starts none in a quiet home'],
}

/** A file's code without its comments (a comment naming a call is not a call). */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .map((l) => l.replace(/\s\/\/[^'"`]*$/, ''))
    .join('\n')
}

/** Files that build a git child's environment (src/lib/git-env.ts gitChildEnv), and what they run. */
const GIT_ENV_USERS: Record<string, string> = {
  'src/integrations/git-sync.ts': 'the data repo\'s git: its spawners refuse a start in a quiet home and track every child',
  'src/integrations/git-bundle-client.ts': 'a bundle of the home\'s repo: refused in a quiet home and tracked (git-children.ts)',
  'src/integrations/git-compaction-chain.ts': 'the history rewrite\'s chain, in the forked compaction worker (waited for by the switch stop)',
  'src/integrations/git-compaction-deliver.ts': 'the history rewrite\'s delivery to the hub, in the forked compaction worker (waited for by the switch stop)',
  'src/web/routes/git-bundle-push.ts': 'the companion\'s hub repo',
  'src/web/routes/git-http.ts': 'the companion\'s hub repo',
  'src/core/self-repair/walnut-source.ts': 'Walnut\'s own source checkout',
  'src/core/session-git-diff.ts': 'a session\'s work dir (reads)',
  'src/core/host-server/host-file-build.ts': 'a host server build in its own folder',
  'src/core/tailscale-install.ts': 'brew, not git',
  'src/providers/vscode-server-core.ts': 'the editor\'s work dir',
}

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) sources(p, out)
    else if (/\.(ts|tsx|mts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

describe('the switch stop\'s writers, as child processes', () => {
  it('every git child outside git-sync.ts is pinned (a new one under the home must use git-sync.ts\'s spawners)', () => {
    const found: Record<string, number> = {}
    for (const file of sources(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file)
      if (rel === path.join('src', 'integrations', 'git-sync.ts')) continue
      const n = [...code(file).matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|execSync|exec)\(\s*['"`]git[ '"`]/g)].length
      if (n) found[rel] = n
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(GIT_CHILDREN).map(([k, [n]]) => [k, n])))
  })

  it('every file that builds a git child\'s environment is pinned (a git started through a variable is not missed)', () => {
    const users = sources(path.join(ROOT, 'src')).map((f) => path.relative(ROOT, f))
      .filter((rel) => rel !== path.join('src', 'lib', 'git-env.ts') && /\bgitChildEnv\b/.test(code(path.join(ROOT, rel))))
    expect(users.sort()).toEqual(Object.keys(GIT_ENV_USERS).sort())
  })

  it('git-sync.ts\'s spawners refuse a start in a quiet home and track every child for the stop', () => {
    const sync = read('src/integrations/git-sync.ts')
    for (const sig of ['export async function execGitGroup(', 'export async function execGitArgsRaw(', 'export function git(']) {
      const body = functionBody(sync, sig)
      expect(body, sig).toContain('refuseGitInQuiet(')
      if (/spawn\(/.test(body)) expect(body, sig).toMatch(/trackOwnGit\(/)
    }
    const client = functionBody(read('src/integrations/git-bundle-client.ts'), 'function runGit(')
    expect(client).toContain('refuseGitInQuiet(')
    expect(client).toContain('trackOwnGit(')
  })

  it('the server forks only the history rewrite and the search embedder; the rewrite is tracked for the stop and starts none in a quiet home', () => {
    const forks: Record<string, number> = {}
    for (const file of sources(path.join(ROOT, 'src'))) {
      const n = [...code(file).matchAll(/(?<!\w)fork\(/g)].length
      if (n) forks[path.relative(ROOT, file)] = n
    }
    // The embedder writes the search index (rebuildable); daemon-child-spawn.ts forks the daemon (its own state).
    expect(forks).toEqual({ 'src/web/server.ts': 1, 'src/lib/hybrid-search/embedder.ts': 1, 'src/providers/daemon-child-spawn.ts': 2 })
    const server = read('src/web/server.ts')
    const at = server.indexOf('fork(workerPath')
    expect(server.slice(at - 300, at)).toContain('gitQuietAt(WALNUT_HOME)')
    expect(server.slice(at, at + 300)).toContain('compactionChild = child')
  })
})

/**
 * The leader's clocks, from the source (review 2026-11-25, M1): a writer started by `void import(...).then(start)` with
 * its handle thrown away is in no stop of stopServer, and a link's events reach the server after the stop began. Every
 * periodic timer under src/ is found wherever it is (clock-scan.ts) and so is every module web/server.ts starts, and
 * each one that writes leader data either asks homeWritesStopped() first (stopWritersForSwitch calls
 * stopLeaderClocks() at the switch stop's start) or is stopped by stopServer before the final batch.
 */
const GATE = 'homeWritesStopped()'

/** The `(...)` span that starts at the first `(` at or after `at` (balanced). */
function spanAt(code: string, at: number, open = '(', close = ')'): string {
  let i = code.indexOf(open, at)
  const from = i
  for (let depth = 0; i < code.length; i++) {
    if (code[i] === open) depth++
    else if (code[i] === close && --depth === 0) break
  }
  return code.slice(from, i + 1)
}

/** The body of a function, method or arrow named `name` in `code`, or ''. */
function definitionOf(code: string, name: string): string {
  const m = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=|\\b${name}\\s*\\([^)]*\\)\\s*(?::[^{=]*)?\\{)`).exec(code)
  if (!m) return ''
  const brace = code.indexOf('{', m.index)
  return brace < 0 ? '' : spanAt(code, brace, '{', '}')
}

/** A clock's tick asks the gate first: in its call, or in a function its call names. */
function gatedAt(code: string, at: number): boolean {
  const span = spanAt(code, at)
  if (span.includes(GATE)) return true
  const named = [...span.matchAll(/(?<![\w.])([A-Za-z_$][\w$]*)\b(?=\s*[(,)])/g)].map((m) => m[1]!)
  return named.some((n) => !/^(setInterval|runPeriodic|void|async|await|if|return)$/.test(n) && definitionOf(code, n).includes(GATE))
}

/** What stopServer runs before the final batch, and stopWritersForSwitch: where a `stopped` call must be. */
function stoppedBeforeFinalBatch(): string {
  const server = read('src/web/server.ts')
  const stop = functionBody(server, 'export async function stopServer(')
  // `a?.stop(` and `a.stop(` are one call.
  return (stop.slice(0, stop.indexOf('finalStop.run(')) + functionBody(server, 'function stopWritersForSwitch(')).replace(/\?\./g, '.')
}

/** Every module web/server.ts starts with a start* function, as a path under src/. */
function serverStarters(): string[] {
  // The raw text: codeOf would take a glob string's `/*` for a comment's start.
  const server = read('src/web/server.ts')
  const specs = new Set<string>()
  for (const m of server.matchAll(/import\(\s*'([^']+)'\s*\)\s*\.then\(([\s\S]{0,240})/g)) {
    if (/\bstart[A-Z]\w*\(/.test(m[2]!.split('.catch')[0]!)) specs.add(m[1]!)
  }
  for (const m of server.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*'([^']+)'\s*\)/g)) {
    if (/\bstart[A-Z]\w*/.test(m[1]!)) specs.add(m[2]!)
  }
  return [...specs].map((spec) => {
    const p = path.normalize(path.join('src/web', spec)).replace(/\.js$/, '.ts')
    return fs.existsSync(path.join(ROOT, p)) ? p : p.replace(/\.ts$/, '/index.ts')
  }).sort()
}

/**
 * Files that ask the gate where no scan of the source finds the writer: an event handler, or a timer armed again
 * through another function (a schedule() that a write calls, a retry a failure arms). A timer that names its own
 * function is found (clock-scan.ts rearmingIn, REARMING in clock-table.ts); these cannot be told from a one-shot by
 * their text. Plugins' own timers are not under src/ at all: their writes go through the plugin API and storage.
 */
const EVENT_GATES: Record<string, string> = {
  'src/core/plugins/server-api.ts': 'a plugin\'s writes of tasks, config and router items, and its API timers (its own native timers outlive its dispose)',
  'src/core/plugins/plugin-storage.ts': 'a plugin\'s data files (plugin-data/), from any timer of the plugin',
  'src/providers/daemon-connection.ts': 'a host\'s unsolicited events (session records, the queue, relayed sends, the offline journal): handleFrame',
  'src/core/offline-handover.ts': 'the offline journal\'s drain into session-requests.json and tasks (a link event): runOfflineHandover',
  'src/core/deferred-door-work.ts': 'the retry of deferred outward work (a re-arming timer)',
  'src/core/private-tasks/kept-digest.ts': 'the kept digest\'s two timers (re-arming)',
  'src/core/sessions/session-stop.ts': 'a session stop\'s retry and its fail deadline (each re-arms)',
  'src/core/sessions/subtask-notices.ts': 'the 3 s coalesce timers that flush edge notices into a session\'s queue',
  'src/core/sessions/turn-end-wait.ts': 'the turn-end wait\'s timer',
  'src/core/sessions/queue-after-turn.ts': 'the per-session release timers',
  'src/core/session-queue-spool.ts': 'the spool watch\'s drain',
  'src/core/pull-requests/pr-watch.ts': 'the task-link follow (an event) besides its clock',
}

describe('the leader\'s clocks, from the source', () => {
  const resolved = (list: Clock[]): Array<Exclude<Clock, 'same'>> => {
    const out: Array<Exclude<Clock, 'same'>> = []
    for (const c of list) out.push(c === 'same' ? out.at(-1)! : c)
    return out
  }

  it('every periodic timer under src/ is classified, one entry a timer (a new one: say how a switch stop ends it)', () => {
    const found = clockFiles(ROOT)
    expect(Object.keys(found).length).toBeGreaterThan(150)
    const want = Object.fromEntries(Object.entries(CLOCKS).map(([f, list]) => [f, list.length]))
    const unknown = Object.keys(found).filter((f) => !(f in want))
    expect(unknown, `classify these in clock-table.ts CLOCKS: ${unknown.join(', ')}`).toEqual([])
    expect(found).toEqual(want)
  })

  it('each gated timer asks homeWritesStopped() first; each stopped one is stopped before the final batch', () => {
    const before = stoppedBeforeFinalBatch()
    for (const [file, list] of Object.entries(CLOCKS)) {
      const code = codeOf(read(file))
      const at = clocksIn(code)
      resolved(list).forEach(([kind, why, stop], i) => {
        if (kind === 'gated') expect(gatedAt(code, at[i]!.at), `${file} timer ${i + 1} (${why})`).toBe(true)
        if (kind === 'stopped') expect(before, `${file} timer ${i + 1}: its stop ${stop}`).toContain(stop!.replace(/\?\./g, '.'))
      })
    }
  })

  it('every module the server starts is classified (a starter with no clock of its own: a re-arming timer, a bus handler, a helper)', () => {
    const starters = serverStarters()
    expect(starters.length).toBeGreaterThan(100)
    const missing = starters.filter((f) => !(f in CLOCKS) && !(f in STARTERS))
    expect(missing, `classify these in clock-table.ts STARTERS: ${missing.join(', ')}`).toEqual([])
    const stale = Object.keys(STARTERS).filter((f) => !starters.includes(f) || f in CLOCKS)
    expect(stale).toEqual([])
    const before = stoppedBeforeFinalBatch()
    for (const [file, [kind, why, more]] of Object.entries(STARTERS)) {
      if (kind === 'gated') expect(codeOf(read(file)), `${file} (${why})`).toContain(GATE)
      if (kind === 'stopped') expect(before, `${file}: its stop ${more}`).toContain(more!.replace(/\?\./g, '.'))
      if (kind === 'helper') expect(CLOCKS, `${file}: its timer's file ${more}`).toHaveProperty([more!])
    }
  })

  it('every timer that arms its own function again is classified, one entry a timer; each gated one asks first', () => {
    const found = rearmingFiles(ROOT)
    expect(Object.keys(found).length).toBeGreaterThan(50)
    const want = Object.fromEntries(Object.entries(REARMING).map(([f, list]) => [f, list.length]))
    const unknown = Object.keys(found).filter((f) => !(f in want))
    expect(unknown, `classify these in clock-table.ts REARMING: ${unknown.join(', ')}`).toEqual([])
    expect(found).toEqual(want)
    const before = stoppedBeforeFinalBatch()
    for (const [file, list] of Object.entries(REARMING)) {
      const code = codeOf(read(file))
      const at = rearmingIn(code)
      resolved(list).forEach(([kind, why, stop], i) => {
        if (kind === 'gated') expect(gatedAt(code, at[i]!), `${file} re-arming timer ${i + 1} (${why})`).toBe(true)
        if (kind === 'stopped') expect(before, `${file} re-arming timer ${i + 1}: its stop ${stop}`).toContain(stop!.replace(/\?\./g, '.'))
      })
    }
  })

  it('a link\'s events and the re-arming timers ask the gate; every file that asks it is in a table', () => {
    for (const [file, why] of Object.entries(EVENT_GATES)) expect(codeOf(read(file)), `${file}: ${why}`).toContain(GATE)
    const frame = functionBody(read('src/providers/daemon-connection.ts'), '  private handleFrame(')
    const event = frame.indexOf('const event = msg as unknown as DaemonEvent')
    expect(event).toBeGreaterThan(frame.indexOf('this.resolveCommandFrame(msg)'))
    expect(frame.slice(event, event + 400)).toContain(`if (${GATE}) return`)
    // The bulk socket: after a main link's reconnect the daemon's first trusted client may be it (message, launch and
    // trigger events): asked right after the command replies, as handleFrame does.
    const conn = codeOf(read('src/providers/daemon-connection.ts'))
    // The bulk socket's handler: the one that parses its own frames and resolves command replies (the main one hands
    // its data to handleMessage).
    const bulks = [...conn.matchAll(/ws\.on\('message', \(data\) => \{\s*let msg: Record<string, unknown>/g)]
    expect(bulks.length, 'one bulk socket handler').toBe(1)
    const handler = spanAt(conn, bulks[0]!.index!)
    expect(handler.indexOf('this.resolveCommandFrame(msg)')).toBeGreaterThan(0)
    expect(handler.indexOf(`if (${GATE}) return`)).toBeGreaterThan(handler.indexOf('this.resolveCommandFrame(msg)'))
    expect(handler.indexOf(`if (${GATE}) return`)).toBeLessThan(handler.indexOf("'stt-request'"))
    const api = codeOf(read('src/core/plugins/server-api.ts'))
    for (const w of ['create', 'update', 'keepInPlugin', 'appendNote', 'appendLog', 'complete', 'delete', 'createFolder', 'fileIntoFolder', 'fileIntoProject', 'deleteFolder', 'ensurePinGroup']) {
      expect(api, `the plugin API's tasks.${w}`).toContain(`assertMayWrite('tasks.${w}')`)
    }
    const handover = functionBody(read('src/core/offline-handover.ts'), 'export function runOfflineHandover(')
    expect(handover.slice(handover.indexOf('{'))).toMatch(/^\{\s*if \(homeWritesStopped\(\)\) return Promise\.reject/)
    const asking = sourcesUnder(path.join(ROOT, 'src')).map((f) => path.relative(ROOT, f))
      .filter((f) => f !== path.join('src', 'lib', 'leader-clocks.ts') && codeOf(read(f)).includes(GATE))
    const listed = (f: string) => f in EVENT_GATES || STARTERS[f]?.[0] === 'gated' || (CLOCKS[f] && resolved(CLOCKS[f]!).some(([k]) => k === 'gated')) || (REARMING[f] && resolved(REARMING[f]!).some(([k]) => k === 'gated'))
    expect(asking.filter((f) => !listed(f))).toEqual([])
  })

  it('the switch stop stops the leader\'s clocks first, and a server\'s start runs them again', () => {
    const server = read('src/web/server.ts')
    const writers = functionBody(server, 'function stopWritersForSwitch(')
    expect(writers.indexOf('stopLeaderClocks()')).toBeGreaterThan(0)
    expect(writers.indexOf('stopLeaderClocks()')).toBeLessThan(writers.indexOf('quietGitWriters('))
    const start = functionBody(server, 'export async function startServer(')
    expect(start.indexOf('resumeLeaderClocks()')).toBeGreaterThan(start.indexOf('endGitQuiet(WALNUT_HOME)'))
  })
})
