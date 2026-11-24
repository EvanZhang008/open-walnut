/**
 * Text ratchets on the session daemon: versioned events and task state, tailer self-heal, scheduled-task fire detection, idle reaper, durable-cron guards, silent-death guards.
 *
 * Source text is checked where no behavior test reaches the line (the guard names which
 * test covers the behavior when one does). The daemon is one program: nothing here
 * compares two copies.
 */
import { describe, it, expect, vi } from 'vitest'
import ts from 'typescript'
import fs from 'node:fs'
import path from 'node:path'
import { readTwinText } from '../helpers/standalone-twin-text.js'

const ROOT = path.resolve(__dirname, '../..')
const corePath = path.join(ROOT, 'src/providers/daemon-core.ts')

// daemon-standalone.ts reads as the whole runtime, its area modules included (readTwinText).
const readFile = readTwinText
// The live tailer, a module of its own (ensureWatcher runs it).
const tailerSrc = fs.readFileSync(path.join(ROOT, 'src/providers/session-tailer.ts'), 'utf-8')

describe('versioned events + task state', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  // L1 — both stamp `v` (end-of-line byte offset) on forwarded jsonl events, live AND replay.
  it('daemon: stamp v = lineStartV + byteLength(line) + 1 in the watcher loop', () => {
    const re = /lineStartV\s*\+\s*Buffer\.byteLength\(line,\s*['"]utf-8['"]\)\s*\+\s*1/
    expect(standaloneSrc).toMatch(re)
  })
  it('daemon: forward jsonl events WITH the v field', () => {
    expect(standaloneSrc).toMatch(/sendEvent\(ws,\s*['"]jsonl['"],\s*\{\s*sid,\s*line,\s*v\s*\}\)/)
  })

  // L2 — both define the task-state helpers with identical terminal set + transition cap.
  // 'killed' is in the set: the CLI fork emits task_updated {patch:{status:'killed'}}
  // right after the task_notification 'stopped' bookend (inc-1786222771315) — without
  // it, the kill's own patch REVIVES the task as non-terminal (phantom derivedRunning).
  it("daemon: define the BG terminal status set (completed/failed/stopped/cancelled/killed)", () => {
    const re = /BG_TERMINAL_STATUSES\s*=\s*new Set\(\[['"]completed['"],\s*['"]failed['"],\s*['"]stopped['"],\s*['"]cancelled['"],\s*['"]killed['"]\]\)/
    expect(standaloneSrc).toMatch(re)
  })
  it('daemon: define applyTaskEvent + emptyTaskState + rebuildTaskStateFromJsonl', () => {
    for (const fn of ['applyTaskEvent', 'emptyTaskState', 'rebuildTaskStateFromJsonl', 'runningTaskCount']) {
      expect(standaloneSrc.includes(fn)).toBe(true)
    }
  })
  it('daemon: enforce terminal-is-terminal on task_started/task_progress', () => {
    // a late/duplicate start or progress must not revive a finished task
    const re = /BG_TERMINAL_STATUSES\.has\(prev\.status\)\s*\?\s*prev\.status\s*:\s*['"]running['"]/
    expect(standaloneSrc).toMatch(re)
  })
  it('daemon: feed task_* lines into applyTaskEvent from the watcher (substring pre-filter)', () => {
    expect(standaloneSrc).toMatch(/line\.includes\(['"]"task_['"]\)/)
    expect(standaloneSrc).toMatch(/applyTaskEvent\(s\.taskState,\s*parsed,\s*v,\s*Date\.now\(\)\)/)
  })
  it('daemon: expose the getState RPC (case + handler) and rebuild-from-jsonl fallback', () => {
    expect(standaloneSrc).toMatch(/case\s*['"]getState['"]:/)
    expect(standaloneSrc).toMatch(/function cmdGetState/)
    // unknown-in-memory → rebuild from the durable jsonl
    expect(standaloneSrc).toMatch(/rebuildTaskStateFromJsonl\(jsonlPath,\s*Date\.now\(\)\)/)
  })
  it('getState tells whether the CLI is between turns, a same-host line included, (the prompt respawn asks it before its stop)', () => {
    const src = standaloneSrc
    const start = src.indexOf('function cmdGetState(')
    const body = src.slice(start, src.indexOf('\n// ── Rename session files', start))
    expect(body).toMatch(/quiet:\s*\{/)
    expect(body).toMatch(/turnActive:[^,\n]*foldState[^,\n]*turnActive === true/)
    expect(body).toMatch(/lineAwaitingAnswer:\s*session\.ttftSendTs != null/)
    expect(body).toMatch(/promptOpen:\s*!!session\.pendingCtrl/)
  })
  it('memory-only getState never probes disk', () => {
    const src = standaloneSrc
    const start = src.indexOf('function cmdGetState(')
    const end = src.indexOf('\n// ── Rename session files', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const code = ts.transpileModule(src.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText
    const diskRead = vi.fn(() => { throw new Error('Unexpected disk access') })
    const sendOk = vi.fn((_ws, _id, body) => body)
    const snapshot = { v: 600, cliState: 'dead' }
    const sessions = new Map<string, unknown>()
    const handler = new Function('sessions', 'sendOk', 'sendError', 'cronSupervisionStatus',
      'assembleSessionSnapshot', 'deriveSessionProtection', 'fs', 'path', 'STREAMS_DIR',
      `${code}; return cmdGetState`)(sessions, sendOk, vi.fn(), () => null,
      () => snapshot, () => ({}), new Proxy({}, { get: () => diskRead }),
      new Proxy({}, { get: () => diskRead }), '/unused')
    expect(handler({}, 1, { sid: 'cold', memoryOnly: true })).toEqual({ snapshotAvailable: false, cronSupervision: null })
    expect(diskRead).not.toHaveBeenCalled()
    sessions.set('known', { state: 'dead', taskState: {} })
    expect(handler({}, 2, { sid: 'known', memoryOnly: true })).toMatchObject({ exists: true, alive: false, snapshot })
    expect(diskRead).not.toHaveBeenCalled()
  })

  it('memory-only snapshots are optional rather than forcing daemon replacement', () => {
    const capsSrc = readFile(path.join(ROOT, 'src/providers/daemon-capabilities.ts'))
    const advertised = capsSrc.indexOf('export const ADVERTISED_DAEMON_CAPABILITIES')
    const required = capsSrc.slice(capsSrc.indexOf('export const REQUIRED_DAEMON_CAPABILITIES'), capsSrc.indexOf('] as const'))
    expect(required).not.toContain('snapshot-memory-v1')
    expect(capsSrc.slice(advertised)).toContain('snapshot-memory-v1')
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
  it('daemon: declare isBackgrounded on the task-state entry (object literal in applyTaskEvent)', () => {
    const re = /isBackgrounded:\s*isBackgrounded\s*\|\|\s*undefined/
    expect(standaloneSrc).toMatch(re)
  })
  it('daemon: exclude isBackgrounded tasks from runningTaskCount', () => {
    const re = /if\s*\(\s*ts\.tasks\[id\]\.isBackgrounded\)\s*continue/
    expect(standaloneSrc).toMatch(re)
  })
  it('daemon: seed isBackgrounded from the previous entry (carries forward across events)', () => {
    const re = /let\s+isBackgrounded\s*=\s*prev\s*\?\s*prev\.isBackgrounded\s*===\s*true\s*:\s*false/
    expect(standaloneSrc).toMatch(re)
  })
  it('daemon: set isBackgrounded stickily from patch.is_backgrounded === true (never cleared by false)', () => {
    // The assignment is a plain `isBackgrounded = true` — never `= patch.is_backgrounded`
    // or similar, which would let a `false` patch clear a previously-true flag.
    const re = /is_backgrounded\s*===\s*true\)\s*isBackgrounded\s*=\s*true/
    expect(standaloneSrc).toMatch(re)
    // Guard against the regression this test exists to catch: no direct
    // assignment from the patch value that could carry a `false` through.
    expect(standaloneSrc).not.toMatch(/isBackgrounded\s*=\s*patch\??\.\s*is_backgrounded\s*[^=]/)
  })

  // inc-1786222771315 + the /loop incident before it — every keep-alive
  // decision flows through ONE verdict function with a source, and getState
  // exposes the same verdict. The reaper knowing about a cross-turn state
  // only via scattered inline checks is exactly how team/cron/bg-task each
  // became an incident.
  it('daemon: derive keep-alive protection through deriveSessionProtection', () => {
    const fnRe = /function deriveSessionProtection\(/
    expect(standaloneSrc).toMatch(fnRe)
    // the scan consumes the verdict (not its own inline logic)
    const useRe = /deriveSessionProtection\(session,\s*sid,\s*now\)/
    expect(standaloneSrc).toMatch(useRe)
    // getState exposes the same verdict (debuggability = same source of truth)
    const stateRe = /protection:\s*deriveSessionProtection\(session,\s*sid,\s*Date\.now\(\)\)/
    expect(standaloneSrc).toMatch(stateRe)
  })
  it('deriveSessionProtection covers all three cross-turn states with extended ceilings', () => {
    const constRe = /SESSION_BG_IDLE_KILL_MS\s*=\s*3\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/
    expect(standaloneSrc).toMatch(constRe)
    // cron → 7d, team → 3d, bg-task → 3d; each verdict names its source
    expect(standaloneSrc).toMatch(/source:\s*['"]cron['"],\s*killMs:\s*SESSION_CRON_IDLE_KILL_MS/)
    expect(standaloneSrc).toMatch(/source:\s*['"]team['"],\s*killMs:\s*SESSION_BG_IDLE_KILL_MS/)
    expect(standaloneSrc).toMatch(/source:\s*['"]bg-task['"],\s*killMs:\s*SESSION_BG_IDLE_KILL_MS/)
    // bg-task derives from the daemon's own fold, not a cached flag
    expect(standaloneSrc).toMatch(/taskState.*derivedRunning\s*>\s*0/)
    // team derives from the fold's teamActive
    expect(standaloneSrc).toMatch(/foldState\.teamActive/)
  })
})

describe('tailer self-heal', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: watcher poll loop never swallows tick errors silently (catch must log)', () => {
    expect(standaloneSrc).toMatch(/logMsg\(['"]error['"],\s*['"]watcher poll tick failed['"]/)
  })
  it('daemon: use the same stall threshold and heal cooldown', () => {
    expect(standaloneSrc).toMatch(/STALL_ERRORS_BEFORE_HEAL\s*=\s*50/)
    expect(standaloneSrc).toMatch(/HEAL_COOLDOWN_MS\s*=\s*60[_]?000/)
  })
  it('daemon: rebuild the watcher on sustained failure (stop + ensure from frozen offset)', () => {
    expect(standaloneSrc).toMatch(/watcher stalled — forcing rebuild/)
    expect(standaloneSrc).toMatch(/stopSessionWatcher\(sid\)[\s\S]{0,40}ensureWatcher\(sid\)/)
  })
  it('daemon: reset consecutiveErrors on every successful tick (incl. no-new-bytes)', () => {
    // The daemon's tailer (session-tailer.ts), which ensureWatcher runs.
    expect(tailerSrc).toMatch(/size\s*<=\s*lines\.cursor\)\s*\{\s*consecutiveErrors\s*=\s*0;?\s*return;?\s*\}/)
    expect(standaloneSrc).toMatch(/createSessionTailer\(\{/)
  })
  it('daemon: guard against healing an orphaned watcher after session replacement', () => {
    expect(standaloneSrc).toMatch(/s\.watcher\.pollTimer\s*!==\s*tailer\.timer/)
  })
})

describe('scheduled-task fire detection', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: check scheduled_tasks.json + lock on turn-start lines via checkCronFires', () => {
    expect(standaloneSrc).toMatch(/scheduled_tasks\.json/)
    expect(standaloneSrc).toMatch(/scheduled_tasks\.lock/)
    // Tailer hook: substring gate on init/session_state_changed then checkCronFires
    expect(standaloneSrc).toMatch(/"session_state_changed"'\)\)\s*\{\s*\n?\s*try \{ checkCronFires\(sid, s\)/)
  })
  it('daemon: throttle the on-disk check to 30s per session', () => {
    expect(standaloneSrc).toMatch(/CRON_CHECK_THROTTLE_MS = 30[_]?000/)
    expect(standaloneSrc).toMatch(/lastCronCheckTs/)
  })
  it('daemon: append a scheduled_task_fire marker to the STREAM file (never canonical)', () => {
    expect(standaloneSrc).toMatch(/subtype: 'scheduled_task_fire'/)
    expect(standaloneSrc).toMatch(/appendFileSync\(session\.jsonlPath, marker\)/)
  })
  it('daemon: EVICT the orphaned row on a hook cron.fire evict and inject NOTHING into the model', () => {
    // 2026-08-13: the old behavior injected a provenance warning on every foreign
    // fire — a turn + context burned hourly that could not stop the loop. A
    // foreign fire proves no CronDelete will come from this process, so the row
    // must go. Now gated by hook rules (cron.fire → evict, when foreign:true in
    // the built-in set). Regression guard: no FIFO write may reappear here.
    expect(standaloneSrc).toMatch(/hookActions\('cron\.fire', \{\s*\n?\s*foreign: fire\.foreign, taskId: fire\.taskId,/)
    expect(standaloneSrc).toMatch(/stripCronTaskById\(tasksJson, fire\.taskId\)/)
    expect(standaloneSrc).toMatch(/hook evict: removed orphaned foreign cron/)
    expect(standaloneSrc).not.toMatch(/cronFireFifoWarning/)
    // The eviction block must not write to the FIFO at all.
    const start = standaloneSrc.indexOf("hookActions('cron.fire'")
    expect(start).toBeGreaterThan(-1)
    const block = standaloneSrc.slice(start, start + 1400)
    expect(block).not.toMatch(/writeFifoRaw/)
  })
})

describe('idle-reaper disk cron signal', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: idle scans consult hasDiskCronInterest when the fold shows no cron', () => {
    // The fold signal (cronIds) is checked FIRST; the disk check only runs
    // when the fold shows nothing (deriveSessionProtection's branch order).
    const foldIdx = standaloneSrc.search(/foldState\.cronIds/)
    const diskIdx = standaloneSrc.search(/hasDiskCronInterest\(\{ sid(?:: sid)?, tasksJson(?:: tasksJson)?, lockJson(?:: lockJson)?, nowMs: now \}\)/)
    expect(foldIdx).toBeGreaterThan(-1)
    expect(diskIdx).toBeGreaterThan(-1)
    // both signals resolve to the same 'cron' verdict, disk with provenance
    expect(standaloneSrc).toMatch(/source:\s*['"]cron['"],\s*killMs:\s*SESSION_CRON_IDLE_KILL_MS,\s*detail:\s*['"]disk:/)
  })
  it('daemon: cache the disk check per session with a 10-minute TTL', () => {
    expect(standaloneSrc).toMatch(/diskCronCache/)
    expect(standaloneSrc).toMatch(/diskCronCache\.at < 10 \* 60_?000/)
  })
  it('daemon: snapshots OR the disk signal into cronActive one-way (never clears fold-armed)', () => {
    expect(standaloneSrc).toMatch(/if \(!snap\.cronActive && session\.diskCronCache && session\.diskCronCache\.armed\) snap\.cronActive = true/)
  })
})

describe('shouldAutoRespond AskUserQuestion exemption', () => {
  const coreSrc = readFile(corePath)

  // Extract just the shouldAutoRespond body so an unrelated
  // mention of the tool name elsewhere in a 3000-line file can't satisfy this.
  function autoRespondBody(src: string): string {
    const at = src.indexOf('function shouldAutoRespond(')
    expect(at, 'shouldAutoRespond not found').toBeGreaterThan(-1)
    const end = src.indexOf('\n}', at)
    return src.slice(at, end)
  }

  it('daemon: exempt AskUserQuestion BEFORE the bypass auto-allow', () => {
    // Order is the whole fix: the bypass branch returns true unconditionally, so a
    // guard placed after it would never run for the exact mode that broke (bypass
    // auto-allowed AskUserQuestion with an empty `answers` set — 11 occurrences in
    // production daemon logs, each one telling the model the human answered nothing).
    for (const body of [autoRespondBody(coreSrc)]) {
      const askAt = body.indexOf("toolName === 'AskUserQuestion'")
      const bypassAt = body.indexOf("mode === 'bypass'")
      expect(askAt).toBeGreaterThan(-1)
      expect(bypassAt).toBeGreaterThan(-1)
      expect(askAt).toBeLessThan(bypassAt)
      expect(body).toMatch(/toolName === 'AskUserQuestion'\) return false/)
    }
  })

})

describe('durable-cron invariant', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: take ALL interventions from pushed hook rules, with env back-compat + kill switch', () => {
    // Default OFF: no pushed hooks.json + no legacy enforce env ⇒ daemonHooks
    // stays null ⇒ hookActions returns [] everywhere. A legacy server that
    // still sets WALNUT_ENFORCE_SESSION_CRON=1 at spawn gets the synthesized
    // built-in rule set; WALNUT_ALLOW_DURABLE_CRON=1 kills everything.
    expect(standaloneSrc).toMatch(/loadDaemonHooksAtBoot\(\)/)
    expect(standaloneSrc).toMatch(/WALNUT_ENFORCE_SESSION_CRON === '1'/)
    expect(standaloneSrc).toMatch(/hash: 'env-compat', hooks: \[builtinSessionOnlyCronHook\(\)\]/)
    // The kill switch guards BOTH boot load and every evaluation.
    expect(standaloneSrc).toMatch(/process\.env\.WALNUT_ALLOW_DURABLE_CRON === '1'/)
    // hooks.configure persists to hooks.json and is NOT bridge-reachable.
    expect(standaloneSrc).toMatch(/'hooks\.configure': cmdHooksConfigure\b/)
    expect(standaloneSrc).toMatch(/const DRAINED_ANSWERS = new Set\(\[[^\]]*'hooks\.configure'/)
    expect(standaloneSrc).toMatch(/hooks\.configure: invalid config/)
    const bridgeSetStart = standaloneSrc.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set(')
    const bridgeSetEnd = standaloneSrc.indexOf('])', bridgeSetStart)
    expect(standaloneSrc.slice(bridgeSetStart, bridgeSetEnd)).not.toContain('hooks.configure')
  })

  it('daemon: evaluate the cron.create hook (deny) BEFORE the auto-allow check', () => {
    // Order matters: a bypass-mode session hits shouldAutoRespond first and would
    // be waved through, so the deny must come earlier in the same block.
    const denyAt = standaloneSrc.indexOf("hookActions('cron.create',")
    const autoAt = standaloneSrc.indexOf('if (shouldAutoRespond(s.mode, toolName))')
    expect(denyAt).toBeGreaterThan(-1)
    expect(autoAt).toBeGreaterThan(-1)
    expect(denyAt).toBeLessThan(autoAt)
    expect(standaloneSrc).toMatch(/durableCronDenyMessage\(\)/)
    expect(standaloneSrc).toMatch(/hook deny: durable CronCreate refused \(session-scoped crons only\)/)
  })


  it('daemon: run the corrective stream check on CronCreate lines (bypass mode has no permission round-trip)', () => {
    expect(standaloneSrc).toMatch(/line\.includes\('CronCreate'\)/)
    expect(standaloneSrc).toMatch(/try \{ checkDurableCronCreate\(sid, s, line(?:, parse)?\)/)
    expect(standaloneSrc).toMatch(/durableCronCorrectionMessage\(undefined\)/)
    expect(standaloneSrc).toMatch(/durableCronNudged/)
  })

})

describe('durable-cron death-funnel strip', () => {
  const coreSrc = readFile(corePath)

  it('daemon: reapSessions strip the dying session durable rows after unlinking the FIFO', () => {
    expect(coreSrc).toMatch(/stripDurableTasksForSession\(raw, sid\)/)
    expect(coreSrc).toMatch(/stripped dead session durable crons \(Walnut policy: session-scoped only\)/)
    // Ordering: the strip must sit inside reapSession, after the FIFO unlink
    // and before the process-group kill (so a slow kill can't race a fire).
    const parsed = ts.createSourceFile('daemon.ts', coreSrc, ts.ScriptTarget.Latest, true)
    let body: string | undefined
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'reapSession') body = node.body?.getText(parsed)
      if (!body) ts.forEachChild(node, visit)
    }
    visit(parsed)
    expect(body, 'actual reapSession function must be available').toBeDefined()
    const unlink = body!.indexOf('unlinkSync(session.pipePath)')
    const strip = body!.indexOf('stripDurableTasksForSession(raw, sid)')
    const kill = body!.search(/killProcessGroup(?:Fn)?\(groupPid, 'SIGTERM'\)/)
    expect(unlink).toBeGreaterThan(-1)
    expect(strip).toBeGreaterThan(unlink)
    expect(kill).toBeGreaterThan(strip)
  })

  it('daemon: write atomically via a same-dir tmp + rename (EXDEV-safe, no torn read)', () => {
    expect(coreSrc).toMatch(/tasksPath \+ '\.walnut-'/)
    expect(coreSrc).toMatch(/renameSync\(tmp, tasksPath\)/)
    expect(coreSrc).toMatch(/mode: 0o600/)
  })

  it('daemon: gate the strip on the session.reap hook rules and only ever remove OWN rows', () => {
    // daemon-core consults the injected hookActionsFn: no strip-own-rows action ⇒ no rewrite.
    expect(coreSrc).toMatch(/hookActionsFn\?\.\('session\.reap', \{ sid, cwd: session\.cwd \}\)\s*\n?\s*\?\.includes\('strip-own-rows'\)/)
    expect(coreSrc).toMatch(/createdBySessionId !== sid\) return true/)
  })
})

describe('control_cancel_request pendingCtrl clear', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  // Incident a172ce49: the CLI withdraws a pending can_use_tool via
  // control_cancel_request (turn abort / restart). Without these two pieces the
  // daemon's pendingCtrl stays set forever → snapshot waiting=true → permanent
  // amber "Waiting" badge + an unanswerable permission card in the UI.
  it('daemon: pre-filter the tailer intercept on the control_cancel_request substring', () => {
    // The intercept gate is a substring pre-filter; '"control_request"' does
    // NOT match control_cancel_request, so the cancel needs its own clause.
    expect(standaloneSrc).toMatch(/line\.includes\('"control_cancel_request"'\)/)
  })

  it('daemon: clear pendingCtrl when the cancel request_id matches', () => {
    const watcher = standaloneSrc.indexOf('function ensureWatcher(')
    expect(watcher, 'actual tailer missing').toBeGreaterThan(-1)
    const at = standaloneSrc.indexOf("parsed.type === 'control_cancel_request' && s.pendingCtrl", watcher)
    expect(at, 'cancel branch missing from actual tailer').toBeGreaterThan(watcher)
    const branch = standaloneSrc.slice(at, at + 900)
    expect(branch).toMatch(/request_id === s\.pendingCtrl\.reqId/)
    expect(branch).toMatch(/s\.pendingCtrl = null/)
    expect(branch).toMatch(/persistRegistry\(\)/)
    expect(branch).toMatch(/control_cancel_request cleared pendingCtrl/)
  })
})

describe('silent-death guards', () => {
  const standaloneSrc = readFile(path.join(ROOT, 'src/providers/daemon-standalone.ts'))

  it('daemon: register uncaughtException + unhandledRejection funnels into daemonCrash', () => {
    // The daemon: its process entry registers them, they call the runtime's daemonCrash
    // (handed over through onCrashReporter) and then exit 1 (supervisor respawns clean).
    expect(standaloneSrc).toMatch(/options\.onCrashReporter\?\.\(daemonCrash\)/)
    expect(standaloneSrc).toMatch(/const onCrashReporter = \(report: /)
    expect(standaloneSrc).toMatch(/process\.on\('uncaughtException', \(err\) => \{ report\('uncaughtException', err\); process\.exit\(1\) \}\)/)
    expect(standaloneSrc).toMatch(/process\.on\('unhandledRejection', \(reason\) => \{ report\('unhandledRejection', reason\); process\.exit\(1\) \}\)/)
    const body = standaloneSrc.slice(standaloneSrc.indexOf('function daemonCrash'))
    const crash = body.slice(0, body.indexOf('\n}'))
    expect(crash).toMatch(/FATAL: ' \+ kind \+ ' — daemon exiting/)
    expect(crash).toMatch(/writeExitBreadcrumb\(kind, err\)/)
  })

  it('daemon: write an exit breadcrumb file named daemon-exit-<instanceId>.log with vitals', () => {
    expect(standaloneSrc).toMatch(/daemon-exit-.{0,10}DAEMON_INSTANCE_ID/)
    const at = standaloneSrc.indexOf('function writeExitBreadcrumb')
    expect(at).toBeGreaterThan(-1)
    const body = standaloneSrc.slice(at, standaloneSrc.indexOf('\n}', at))
    for (const field of ['uptimeSec', 'rssMb', 'heapMb', 'sessions:', 'stack:']) {
      expect(body, `breadcrumb missing ${field}`).toContain(field)
    }
    // The breadcrumb itself must be throw-proof.
    expect(body).toMatch(/catch \{ \/\* the breadcrumb must never be the thing that crashes \*\/ \}/)
  })

  it('daemon: wrap the command dispatch so a throwing handler replies instead of dying', () => {
    // handleCommand delegates through a try/catch to dispatchCommand (the gates and handlerThrew sit between them)…
    const hc = standaloneSrc.slice(standaloneSrc.indexOf('function handleCommand'), standaloneSrc.indexOf('function dispatchCommand'))
    expect(hc).toMatch(/try \{/)
    expect(hc).toMatch(/dispatchCommand\(ws, id(?: as number)?, cmd\)/)
    expect(hc).toMatch(/handleCommand: handler threw — replying with error instead of dying/)
    expect(hc).toMatch(/internal daemon error handling/)
    // …and an async handler's rejection is caught too (fs.* return promises).
    expect(hc).toMatch(/typeof (?:\(out as Promise<unknown>\)\.then|out\.then) === 'function'/)
    // …and a valid-JSON-but-not-object frame can't throw before the guard.
    expect(hc).toMatch(/if \(!(cmd|sent) \|\| typeof \1 !== 'object'\) \{ reply\(errorFrame\(ws, null, 'invalid JSON'\)\); return null \}/)
    // The switch itself must live in dispatchCommand (nothing dispatches outside the guard); only the
    // command table's answer runs before it, under the same guard (answerCommand catches its throws).
    expect(standaloneSrc).toMatch(/function dispatchCommand\(ws(?:: ServerWebSocket<WsData>)?, id(?:: number)?, cmd(?:: Record<string, unknown>)?\) \{\s*\n\s*\/\/[^\n]*\n\s*const answerFn = answerFnOf\(cmd\.cmd\)\n\s*if \(answerFn\) return answerCommand\(ws, cmd, answerFn, \(answer\) => sendAnswer\(ws, id, answer\)\)\n\s*switch \(cmd\.cmd\)/)
  })

  it('daemon: stream rebuildTaskStateFromJsonl in chunks (no whole-file readFileSync)', () => {
    const src = standaloneSrc
    const at = src.indexOf('function rebuildTaskStateFromJsonl')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, src.indexOf('\n}', at))
    expect(body, `task rebuild still materializes the whole file`)
      .not.toMatch(/readFileSync/)
    expect(body).toMatch(/FOLD_REBUILD_CHUNK/)
    // Byte-level pre-filter: only task_* lines get decoded.
    expect(body).toMatch(/TASK_LINE_MARKER/)
    expect(src).toMatch(/TASK_LINE_MARKER = Buffer\.from\('"task_'\)/)
  })
})
