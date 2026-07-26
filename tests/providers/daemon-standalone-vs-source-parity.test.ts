/**
 * L1.6 daemon-standalone vs daemon-source parity.
 *
 * The embedded JS template in `daemon-source.ts` is SSH-deployed and runs on
 * plain Node — it can't import `daemon-core.ts`. Instead it mirrors the same
 * logic verbatim. This test locks in the parity by verifying that each
 * primitive in the template contains the exact key statements defined in
 * the daemon-core source of truth.
 *
 * Strategy: regex-extract each function body from both sources and assert
 * that each key invariant (idempotent guard, SIGTERM→SIGKILL sequence,
 * atomic rename, reason strings, re-entrant guard) is present on BOTH sides.
 *
 * If you modify a primitive in one place you MUST mirror it in the other,
 * and this test will fail loudly when they diverge.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const corePath = path.join(ROOT, 'src/providers/daemon-core.ts')
const sourcePath = path.join(ROOT, 'src/providers/daemon-source.ts')

function readFile(p: string) { return fs.readFileSync(p, 'utf-8') }

describe('L1.6 daemon-core vs daemon-source template parity', () => {
  const coreSrc = readFile(corePath)
  const templateSrc = readFile(sourcePath)

  // P1 — reapSession idempotent guard
  it('both implementations have reapSession idempotent state===dead guard', () => {
    expect(coreSrc).toMatch(/if\s*\(\s*session\.state\s*===\s*['"]dead['"]\s*\)\s*return/)
    expect(templateSrc).toMatch(/if\s*\(\s*session\.state\s*===\s*['"]dead['"]\s*\)\s*return/)
  })

  // P1b — reapSession SIGTERM → SIGKILL 2s sequence
  it('both implementations schedule SIGKILL 2000ms after SIGTERM', () => {
    // Asserts the SEQUENCE, not the vocabulary. This used to be six independent
    // `toMatch(/SIGTERM/)`-style checks, which passed as long as each word appeared
    // ANYWHERE in a 3000-line file — including inside an unrelated comment. Reordering
    // the escalation, or dropping the 2000ms delay, could not fail it.
    const escalates = (src: string, label: string) => {
      const termIdx = src.search(/'SIGTERM'|"SIGTERM"/)
      const killIdx = src.search(/'SIGKILL'|"SIGKILL"/)
      expect(termIdx, `${label}: no SIGTERM signal literal`).toBeGreaterThan(-1)
      expect(killIdx, `${label}: no SIGKILL signal literal`).toBeGreaterThan(-1)
      expect(termIdx, `${label}: SIGKILL is sent before SIGTERM — the ladder is inverted`).toBeLessThan(killIdx)
      // The SIGKILL must be on a timer, not immediate: a bare kill defeats the grace period.
      expect(
        src.slice(termIdx, killIdx + 400),
        `${label}: SIGKILL is not scheduled on a 2000ms timer after SIGTERM`,
      ).toMatch(/setTimeout[\s\S]{0,200}2000|2000[\s\S]{0,200}SIGKILL/)
    }
    escalates(coreSrc, 'daemon-core')
    escalates(templateSrc, 'daemon-source template')
  })

  // P1c — reapSession persists BEFORE broadcast
  it('both implementations persist registry before broadcasting session_state', () => {
    // This test USED TO be unable to fail: it computed persistIdx and broadcastIdx
    // and then returned `persistIdx > -1 && broadcastIdx > -1` — i.e. "both words
    // appear somewhere in the file", never their ORDER. Swapping the two calls (the
    // exact regression it exists to catch: a crash between broadcast and persist
    // leaves subscribers told 'dead' while the registry still says alive) kept it
    // green. It now compares positions inside reapSession's own body.
    const orderWithinReap = (src: string, label: string) => {
      // Slice from `function reapSession` to the next top-level function, so a
      // persistRegistry() elsewhere in the file can't satisfy the assertion.
      const start = src.search(/(?:function|const)\s+reapSession/)
      expect(start, `${label}: reapSession not found — parity test is checking nothing`).toBeGreaterThan(-1)
      const rest = src.slice(start + 1)
      const nextFn = rest.search(/\n(?:function|const)\s+\w+/)
      const body = nextFn === -1 ? rest : rest.slice(0, nextFn)

      const persistIdx = body.indexOf('persistRegistry')
      const broadcastIdx = body.search(/broadcastSessionState\(\s*sid\s*,\s*['"]dead['"]/)
      expect(persistIdx, `${label}: reapSession does not call persistRegistry`).toBeGreaterThan(-1)
      expect(broadcastIdx, `${label}: reapSession does not broadcast 'dead'`).toBeGreaterThan(-1)
      expect(
        persistIdx,
        `${label}: reapSession broadcasts 'dead' BEFORE persisting the registry — a crash in ` +
          'between leaves subscribers believing the session died while the registry still lists it alive',
      ).toBeLessThan(broadcastIdx)
    }
    orderWithinReap(coreSrc, 'daemon-core')
    orderWithinReap(templateSrc, 'daemon-source template')
  })

  // P1d — stderr tail cap at 4096 bytes
  it('both implementations cap stderr tail at 4096 bytes', () => {
    expect(coreSrc).toMatch(/4096/)
    expect(templateSrc).toMatch(/4096/)
  })

  // P2 — atomic tmp → rename
  it('both implementations do atomic writeFileSync(tmp) → fsyncSync → renameSync', () => {
    const checkAtomic = (src: string) => {
      const idxWrite = src.indexOf("writeFileSync(tmp")
      const idxFsync = src.indexOf('fsyncSync')
      const idxRename = src.indexOf('renameSync(tmp')
      return idxWrite > 0 && idxFsync > idxWrite && idxRename > idxFsync
    }
    expect(checkAtomic(coreSrc)).toBe(true)
    expect(checkAtomic(templateSrc)).toBe(true)
  })

  // P2b — envelope is {version:1, sessions:{}}
  it('both implementations wrap in {version:1, sessions:...} envelope', () => {
    expect(coreSrc).toMatch(/version:\s*1,\s*sessions/)
    expect(templateSrc).toMatch(/version:\s*1,\s*sessions/)
  })

  // P2c — only running+pid persisted
  it('both implementations skip dead / pid-less sessions in persist', () => {
    expect(coreSrc).toMatch(/state\s*!==\s*['"]running['"]\s*\|\|\s*!\s*s\.pid/)
    expect(templateSrc).toMatch(/state\s*!==\s*['"]running['"]\s*\|\|\s*!\s*s\.pid/)
  })

  // P3 — orphan poll interval 1000ms
  it('both implementations use ORPHAN_POLL_INTERVAL_MS = 1000 or 1000 literal', () => {
    // daemon-core takes it via deps (defaults to 1000); daemon-source has const
    expect(coreSrc).toMatch(/orphanPollIntervalMs\s*\?\?\s*1000|orphanPollIntervalMs:\s*1000/)
    expect(templateSrc).toMatch(/ORPHAN_POLL_INTERVAL_MS\s*=\s*1000/)
  })

  // P3b — orphan poll reap reasons
  it('both implementations use reason=orphan-poll-dead and pid-recycled', () => {
    expect(coreSrc).toMatch(/orphan-poll-dead/)
    expect(coreSrc).toMatch(/pid-recycled/)
    expect(templateSrc).toMatch(/orphan-poll-dead/)
    expect(templateSrc).toMatch(/pid-recycled/)
  })

  // P4 — reconcile reap reasons
  it('both implementations use exact reconcile reason strings', () => {
    for (const reason of ['reconcile-dead', 'reconcile-not-ours', 'reconcile-pid-recycled']) {
      expect(coreSrc.includes(reason)).toBe(true)
      expect(templateSrc.includes(reason)).toBe(true)
    }
  })

  // P4b — reconcile re-entrant guard (fix for timer leak bug)
  it('both implementations skip already-adopted sessions (re-entrant guard)', () => {
    expect(coreSrc).toMatch(/if\s*\(\s*sessions\.has\(sid\)\s*\)\s*continue/)
    expect(templateSrc).toMatch(/if\s*\(\s*sessions\.has\(sid\)\s*\)\s*continue/)
  })

  // P4c — reconcile adopts with parented:false + broadcasts adopted:true
  it('both implementations set parented:false and broadcast adopted:true on reconcile', () => {
    // parented:false lives in createAdoptedSession (adapter-level in standalone,
    // inline in the source template); adopted:true is emitted by reconcile itself.
    const standalonePath = path.join(ROOT, 'src/providers/daemon-standalone.ts')
    const standaloneSrc = fs.readFileSync(standalonePath, 'utf-8')
    expect(standaloneSrc).toMatch(/parented:\s*false/)
    expect(coreSrc).toMatch(/adopted:\s*true/)
    expect(templateSrc).toMatch(/parented:\s*false/)
    expect(templateSrc).toMatch(/adopted:\s*true/)
  })

  // P4d — reconcile scans STREAMS_DIR for zombie *.pipe
  it('both implementations sweep zombie *.pipe files in streams dir', () => {
    expect(coreSrc).toMatch(/\.pipe/)
    expect(coreSrc).toMatch(/readdirSync/)
    expect(templateSrc).toMatch(/\.pipe/)
    expect(templateSrc).toMatch(/readdirSync/)
  })

  // P5 — broadcast session_state event name
  it('both implementations emit {ev: "session_state"} on wsClients', () => {
    expect(coreSrc).toMatch(/session_state/)
    expect(templateSrc).toMatch(/session_state/)
  })

  // P5b — cmdSend reap reasons
  it('both implementations use send-precheck-dead and send-enxio reason strings', () => {
    // daemon-core owns handleSendCommand for the Bun adapter; the source
    // template inlines the equivalent code.
    for (const reason of ['send-precheck-dead', 'send-enxio']) {
      expect(coreSrc.includes(reason)).toBe(true)
      expect(templateSrc.includes(reason)).toBe(true)
    }
  })

  // P5c — readStartTime reads /proc/<pid>/stat field 22 (index 19)
  it('both implementations read /proc/<pid>/stat start_time at field index 19', () => {
    expect(coreSrc).toMatch(/\/proc\//)
    expect(coreSrc).toMatch(/fields\[19\]/)
    expect(templateSrc).toMatch(/\/proc\//)
    expect(templateSrc).toMatch(/fields\[19\]/)
  })

  // P5d — idle scanner converges on reapSession (not inline cleanup)
  it('idle scanner in template calls reapSession(idle-scan-missed-exit)', () => {
    expect(templateSrc).toMatch(/idle-scan-missed-exit/)
  })

  // Turn-start delivery marker (incident inc-1783644415695): both implementations
  // expose the appendUserMarker RPC writing the walnut-injected marker line, and
  // both open the CLI's stdout fd in append mode so the marker is never clobbered.
  it('both implementations handle the appendUserMarker command', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [coreSrc, templateSrc]) {
      expect(src.includes('walnut-injected')).toBe(true)
      expect(src.includes('walnutMessageId')).toBe(true)
      expect(src).toMatch(/appendFileSync\(session\.jsonlPath/)
    }
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src.includes("case 'appendUserMarker'")).toBe(true)
    }
  })

  it("both spawn the CLI's stdout fd in append mode (marker-clobber defense)", () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/openSync\(jsonlPath, 'a'\)/)
      // 'w' open of the jsonl must be gone — fresh spawn truncates explicitly instead.
      expect(src).not.toMatch(/openSync\(jsonlPath, resume \? 'a' : 'w'\)/)
    }
  })

  it('both bridge resume paths authorize runtime bypass mode changes', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    expect(standaloneSrc).toContain('--dangerously-skip-permissions')
    expect(templateSrc).toContain('--dangerously-skip-permissions')
  })

  it('both daemon twins enforce owner-only umask and repair existing storage modes', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/process\.umask\(0o077\)/)
      expect(src).toMatch(/function ensureOwnerOnlyStorage/)
      expect(src).toMatch(/chmodSync\(DAEMON_DIR,\s*0o700\)/)
      expect(src).toMatch(/chmodSync\(STREAMS_DIR,\s*0o700\)/)
      expect(src).toMatch(/stat\.mode\s*&\s*0o111\s*\?\s*0o700\s*:\s*0o600/)
    }
  })

  // b12 retry hardening — both twins inject CLAUDE_CODE_MAX_RETRIES into the CLI
  // spawn env so a turn survives upstream Bedrock degradation windows (10-103 min)
  // that outlast the CLI's default 10-retry (~3min) budget. Precedence must match:
  // explicit process-env override → WALNUT_CLI_MAX_RETRIES → default '60'.
  it('both twins compute cliMaxRetries with the same precedence (env → WALNUT_CLI_MAX_RETRIES → 60)', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    const re = /process\.env\.CLAUDE_CODE_MAX_RETRIES\s*\?\?\s*process\.env\.WALNUT_CLI_MAX_RETRIES\s*\?\?\s*'60'/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both twins pass CLAUDE_CODE_MAX_RETRIES: cliMaxRetries into the spawn env', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/CLAUDE_CODE_MAX_RETRIES:\s*cliMaxRetries/)
    }
  })

  // Isolated-dir CLI reap (2026-07-25 leak): cleanup() preserves session process
  // groups for successor adoption in PROD, but isolated-dir daemons (sandbox /
  // tests / demos, marked by WATCHDOG_PARENT_PID) never get a successor — they
  // must kill their CLI children on exit or the CLIs leak forever (25 orphans,
  // oldest 8 days). Both twins must gate the reap on WATCHDOG_PARENT_PID and
  // use the sync SIGTERM→wait→SIGKILL helper (cleanup runs right before
  // process.exit, so async kill sequences would never fire).
  it('both twins reap session groups on isolated-dir cleanup, gated on ownsFiles', () => {
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/function reapAllSessionGroupsSync/)
      // Isolation is DERIVED from DAEMON_DIR, never from WALNUT_DAEMON_PARENT_PID:
      // direct-spawn test launchers must get the fix without opting in, and a
      // stale inherited parent pid must never make PROD reap live sessions.
      expect(src).toMatch(/function shouldReapOnExit/)
      expect(src).toMatch(/path\.resolve\(DAEMON_DIR\)\s*!==\s*path\.resolve\(PROD_DAEMON_DIR\)/)
      // ownsFiles gate is load-bearing: a daemon that LOST the pid-file race must
      // not kill the process groups its successor already adopted.
      expect(src).toMatch(/if\s*\(ownsFiles\s*&&\s*shouldReapOnExit\(\)\)\s*reapAllSessionGroupsSync\(\)/)
      // …and ownsFiles must be computed BEFORE the reap call.
      const ownsIdx = src.indexOf('let ownsFiles = true')
      const reapIdx = src.indexOf('shouldReapOnExit()) reapAllSessionGroupsSync()')
      expect(ownsIdx).toBeGreaterThan(0)
      expect(ownsIdx).toBeLessThan(reapIdx)
      // Full kill ladder — SIGINT (hooks) → SIGTERM → SIGKILL, not SIGTERM-then-kill.
      expect(src).toMatch(/isolated-dir exit: SIGINT session group/)
      expect(src).toMatch(/isolated-dir exit: SIGTERM session group/)
      expect(src).toMatch(/isolated-dir exit: SIGKILL session group/)
      // Only LIVE sessions: a dead session's pid is never nulled and pids recycle.
      expect(src).toMatch(/exitCode !== null\) continue/)
      // Sync sleep helper (cleanup() runs right before process.exit — no timers).
      expect(src).toMatch(/function sleepSync/)
    }
  })

  it('both twins scrub WALNUT_DAEMON_PARENT_PID from the CLI spawn env', () => {
    // Env-carrier chain: isolated daemon → CLI → `npm run dev:prod` → PROD daemon
    // inherits a dead parent pid, watchdog trips, prod sessions die.
    const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/WALNUT_DAEMON_PARENT_PID:\s*undefined/)
    }
  })
})

// ── L1/L2 parity: versioned events + daemon-authoritative task state ──
// These live in daemon-standalone.ts (real TS) and daemon-source.ts (embedded JS template).
// They MUST stay byte-equivalent — this block fails loudly if one side drifts.
describe('L1/L2 daemon-standalone vs daemon-source parity (versioned events + task state)', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  // L1 — both stamp `v` (end-of-line byte offset) on forwarded jsonl events, live AND replay.
  it('both stamp v = lineStartV + byteLength(line) + 1 in the watcher loop', () => {
    const re = /lineStartV\s*\+\s*Buffer\.byteLength\(line,\s*['"]utf-8['"]\)\s*\+\s*1/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both forward jsonl events WITH the v field', () => {
    expect(standaloneSrc).toMatch(/sendEvent\(ws,\s*['"]jsonl['"],\s*\{\s*sid,\s*line,\s*v\s*\}\)/)
    expect(templateSrc).toMatch(/sendEvent\(ws,\s*['"]jsonl['"],\s*\{\s*sid,\s*line,\s*v\s*\}\)/)
  })

  // L2 — both define the task-state helpers with identical terminal set + transition cap.
  it('both define the BG terminal status set (completed/failed/stopped/cancelled)', () => {
    const re = /BG_TERMINAL_STATUSES\s*=\s*new Set\(\[['"]completed['"],\s*['"]failed['"],\s*['"]stopped['"],\s*['"]cancelled['"]\]\)/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both define applyTaskEvent + emptyTaskState + rebuildTaskStateFromJsonl', () => {
    for (const fn of ['applyTaskEvent', 'emptyTaskState', 'rebuildTaskStateFromJsonl', 'runningTaskCount']) {
      expect(standaloneSrc.includes(fn)).toBe(true)
      expect(templateSrc.includes(fn)).toBe(true)
    }
  })
  it('both enforce terminal-is-terminal on task_started/task_progress', () => {
    // a late/duplicate start or progress must not revive a finished task
    const re = /BG_TERMINAL_STATUSES\.has\(prev\.status\)\s*\?\s*prev\.status\s*:\s*['"]running['"]/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both feed task_* lines into applyTaskEvent from the watcher (substring pre-filter)', () => {
    expect(standaloneSrc).toMatch(/line\.includes\(['"]"task_['"]\)/)
    expect(templateSrc).toMatch(/line\.includes\(['"]"task_['"]\)/)
    expect(standaloneSrc).toMatch(/applyTaskEvent\(s\.taskState,\s*parsed,\s*v,\s*Date\.now\(\)\)/)
    expect(templateSrc).toMatch(/applyTaskEvent\(s\.taskState,\s*parsed,\s*v,\s*Date\.now\(\)\)/)
  })
  it('both expose the getState RPC (case + handler) and rebuild-from-jsonl fallback', () => {
    expect(standaloneSrc).toMatch(/case\s*['"]getState['"]:/)
    expect(templateSrc).toMatch(/case\s*['"]getState['"]:/)
    expect(standaloneSrc).toMatch(/function cmdGetState/)
    expect(templateSrc).toMatch(/function cmdGetState/)
    // unknown-in-memory → rebuild from the durable jsonl
    expect(standaloneSrc).toMatch(/rebuildTaskStateFromJsonl\(jsonlPath,\s*Date\.now\(\)\)/)
    expect(templateSrc).toMatch(/rebuildTaskStateFromJsonl\(jsonlPath,\s*Date\.now\(\)\)/)
  })
  it('getState is declared in REQUIRED_DAEMON_CAPABILITIES', () => {
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    expect(capsSrc).toMatch(/['"]getState['"]/)
  })

  // Incident-D fix (bash task is_backgrounded gating): both sides must carry
  // the isBackgrounded field end-to-end — task-state entry, the running-count
  // exclusion, and the sticky set-from-patch in applyTaskEvent. Without this,
  // one side could silently drop the gating exclusion (incident 07fffbe5
  // reopening) while this whole describe block stayed green.
  it('both declare isBackgrounded on the task-state entry (object literal in applyTaskEvent)', () => {
    const re = /isBackgrounded:\s*isBackgrounded\s*\|\|\s*undefined/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both exclude isBackgrounded tasks from runningTaskCount', () => {
    const re = /if\s*\(\s*ts\.tasks\[id\]\.isBackgrounded\)\s*continue/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both seed isBackgrounded from the previous entry (carries forward across events)', () => {
    const re = /let\s+isBackgrounded\s*=\s*prev\s*\?\s*prev\.isBackgrounded\s*===\s*true\s*:\s*false/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
  })
  it('both set isBackgrounded stickily from patch.is_backgrounded === true (never cleared by false)', () => {
    // The assignment is a plain `isBackgrounded = true` — never `= patch.is_backgrounded`
    // or similar, which would let a `false` patch clear a previously-true flag.
    const re = /is_backgrounded\s*===\s*true\)\s*isBackgrounded\s*=\s*true/
    expect(standaloneSrc).toMatch(re)
    expect(templateSrc).toMatch(re)
    // Guard against the regression this test exists to catch: no direct
    // assignment from the patch value that could carry a `false` through.
    expect(standaloneSrc).not.toMatch(/isBackgrounded\s*=\s*patch\??\.\s*is_backgrounded\s*[^=]/)
    expect(templateSrc).not.toMatch(/isBackgrounded\s*=\s*parsed\.patch\s*&&\s*parsed\.patch\.is_backgrounded\s*[^=]/)
  })
})

// ── Tailer self-heal parity (incident 6c8428ac: frozen watcher offset) ──
// The poll loop's catch must LOG (no-silent-failures) and force a watcher
// rebuild after sustained failure. Both sides must carry identical thresholds.
describe('tailer self-heal daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  it('neither watcher poll loop swallows tick errors silently (catch must log)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/logMsg\(['"]error['"],\s*['"]watcher poll tick failed['"]/)
    }
  })
  it('both use the same stall threshold and heal cooldown', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/STALL_ERRORS_BEFORE_HEAL\s*=\s*50/)
      expect(src).toMatch(/HEAL_COOLDOWN_MS\s*=\s*60[_]?000/)
    }
  })
  it('both rebuild the watcher on sustained failure (stop + ensure from frozen offset)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/watcher stalled — forcing rebuild/)
      expect(src).toMatch(/stopSessionWatcher\(sid\)[\s\S]{0,40}ensureWatcher\(sid\)/)
    }
  })
  it('both reset consecutiveErrors on every successful tick (incl. no-new-bytes)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/stat\.size\s*<=\s*offset\)\s*\{\s*consecutiveErrors\s*=\s*0;?\s*return;?\s*\}/)
    }
  })
  it('both guard against healing an orphaned watcher after session replacement', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/s\.watcher\.pollTimer\s*!==\s*pollTimer/)
    }
  })
})

// ── Cloud bridge parity (phone → cloud → daemon dial-out) ──
// The bridge is implemented twice (standalone + source template). Lock the
// invariants: configure RPC + persistence, generation guard, hello frame,
// silence-based teardown, backoff bounds, cleanup ordering, and startup
// self-heal. If you touch the bridge in one file, mirror it in the other.
describe('cloud bridge daemon-standalone vs daemon-source parity', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))
  const templateSrc = readFile(sourcePath)

  it('both dispatch the bridge.configure command', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/case 'bridge\.configure': return cmdBridgeConfigure/)
    }
  })
  it('both persist bridge.json (0600) and redial only on change', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/BRIDGE_FILE = path\.join\(DAEMON_DIR, 'bridge\.json'\)/)
      expect(src).toMatch(/mode: 0o600/)
      expect(src).toMatch(/if \(changed\) startBridge\('configure'\)/)
    }
  })
  it('both carry the generation guard against stale dials', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/bridgeGeneration\+\+/)
      expect(src).toMatch(/gen !== bridgeGeneration/)
    }
  })
  it('both send hello with hostAlias/version/instanceId/sids as the first frame', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/ev: 'hello',\s*hostAlias: cfg\.hostAlias,\s*version: DAEMON_VERSION,\s*instanceId: DAEMON_INSTANCE_ID,\s*sids: \[\.\.\.sessions\.keys\(\)\]/)
    }
  })
  it('both share ping interval, silence threshold, and backoff cap', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/BRIDGE_PING_INTERVAL_MS = 30[_]?000/)
      expect(src).toMatch(/BRIDGE_SILENCE_MS = 75[_]?000/)
      expect(src).toMatch(/BRIDGE_BACKOFF_MAX_MS = 60[_]?000/)
    }
  })
  it('both route inbound bridge frames through handleCommand (no second dispatch)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/handleCommand\(bridgeAdapter,/)
    }
  })
  it('both put the token on the query string (browser-style clients cannot set headers)', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/searchParams\.set\('token', cfg\.token\)/)
    }
  })
  it('both stop the bridge first in cleanup() and self-heal at startup', () => {
    for (const src of [standaloneSrc, templateSrc]) {
      expect(src).toMatch(/try \{ stopBridge\(\);? \} catch \{\}/)
      expect(src).toMatch(/loadBridgeConfig\(\);?\s*\n\s*startBridge\('startup'\)/)
    }
  })
})
