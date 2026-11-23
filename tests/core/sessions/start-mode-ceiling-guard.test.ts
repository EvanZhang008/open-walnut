/**
 * Every path that starts a session, or sets a session's mode, applies the launch-mode ceiling: a
 * session starts work at most as loose as its own mode (src/core/sessions/delegated-mode.ts
 * capStartMode, modeChangeRefusal). A permission gap is the risky kind, so this lists from the
 * source every call of the start functions, every SESSION_START emit and every route that changes
 * a session's mode: each one hands the asking session on (`callerSid: <value>` in the call) or
 * caps the mode itself (`capStartMode` / `modeChangeRefusal` in or right above the call), or is
 * listed below with why no session's mode bounds it. A new one fails until it is one of those.
 *
 * A plugin's job vouched for by its host's daemon (src/core/plugin-jobs/job-caller.ts) starts work
 * in the mode it asks for, but only where the vouched job is handed on beside the caller: every
 * start call that hands on the caller also hands on `callerJob`, and every capStartMode call
 * passes `job`, or is listed with why a job's call stays capped there (it does not reach it, or
 * a job does not need it). So a new start entry that drops the job fails here, as one that drops
 * the caller does.
 *
 * A session sid its host's daemon could not prove (src/lib/caller-unproven.ts) is an outside caller
 * to the ceiling. The mark lowers trust, so dropping it is the risky gap (the opposite of the job):
 * every start call that hands on the caller also hands on `callerUnproven`, and every capStartMode
 * and modeChangeRefusal call passes `unproven`, or is listed with why no relayed call reaches it.
 *
 * A host's own Walnut server starts work too while the Mac is away (src/replica: `follower.start`
 * to its daemon). Each file that sends one caps the mode with the Mac's rule (replica/start-ceiling.ts
 * capAwayStart), and no mode read off the request body reaches the daemon but through it.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')
const START_FUNCTIONS = ['quickStartSession', 'startSessionForTask', 'requestEngineSwitch', 'performMobileLaunch', 'forkSessionToTask']
const MODE_CHANGES = ['patchSession', 'applySessionControl']

/** file -> why its uncapped start calls need no caller's ceiling (one reason per file, with the count). */
const NOT_A_SESSIONS_START: Record<string, { count: number; why: string }> = {
  'src/core/org/org-autostart.ts': { count: 1, why: 'Walnut starts Main or a VP by itself; no session asks for it' },
  'src/core/routines/run-start-deps.ts': { count: 2, why: 'a routine or watcher run names no mode; the engine settings decide it' },
  'src/core/sessions/mobile-launch.ts': { count: 1, why: 'the companion relay: the primary sees no calling session across the bridge' },
  'src/core/sessions/engine-switch.ts': { count: 1, why: 'runs a switch whose mode requestEngineSwitch already capped (capSwitchMode)' },
  'src/core/sessions/session-controls.ts': { count: 1, why: 'the companion relay of a fork: no calling session crosses the bridge; a fork keeps its source\'s mode' },
  'src/core/transfer/transfer.ts': { count: 1, why: 'the native fork of a transfer, whose mode transferTask capped when it planned it' },
  'src/core/health-monitor/fix-task.ts': { count: 2, why: 'Walnut\'s own repair task, named no mode' },
  'src/core/router/wake.ts': { count: 1, why: 'the router runtime wakes its own task, named no mode' },
  'src/core/router/service.ts': { count: 1, why: 'the router hands an item to a task with no conversation yet: that task starts with it, named no mode' },
  'src/web/routes/session-control-v1.ts': { count: 1, why: 'a fork names no mode: it keeps the mode its source session already runs in' },
  'src/web/routes/sessions.ts': { count: 1, why: 'a fork names no mode: it keeps the mode its source session already runs in' },
  'src/web/routes/triage-rules-v1.ts': { count: 1, why: 'starts the task a person or Main named in a routing rule, with no mode' },
  'src/web/routes/notifications.ts': { count: 1, why: 'the person\'s Fix button on a notification' },
  'src/web/routes/session-chat.ts': { count: 1, why: 'the person\'s engine picker over the browser socket; sessions never use it' },
  'src/providers/subagent-runner.ts': { count: 1, why: 'the Personal AI\'s subagent, named no mode' },
}

/** file -> why its SESSION_START emits need no ceiling of their own. */
const SESSION_START_EMITS: Record<string, { count: number; why: string }> = {
  'src/core/sessions/quick-start.ts': { count: 1, why: 'quickStartSession\'s own start, capped above it' },
  'src/core/sessions/session-lifecycle.ts': { count: 1, why: 'starts a session the task\'s start already planned and capped' },
  'src/core/sessions/session-controls.ts': { count: 1, why: 'forkSessionToTask: the fork keeps its source session\'s mode' },
  'src/web/routes/sessions.ts': { count: 1, why: 'a plan\'s execution: capped with capStartMode from the caller header (execMode)' },
  'src/web/routes/session-chat.ts': { count: 1, why: 'the person\'s browser socket' },
  'src/core/sessions/side-thread-fork.ts': { count: 1, why: 'a side thread of a session keeps that session\'s mode' },
  'src/core/sessions/lane-fork.ts': { count: 1, why: 'a chat lane fork keeps its lane\'s mode' },
  'src/core/sessions/session-rewind.ts': { count: 1, why: 'a rewind restarts the same session in its own mode' },
  'src/core/sessions/personal-ai-lane.ts': { count: 2, why: 'the Personal AI\'s own lanes, in their fixed mode' },
  'src/core/sessions/cloud-chat-lane.ts': { count: 1, why: 'the companion\'s chat lane, in its fixed mode' },
  'src/core/ai/ai-agent.ts': { count: 1, why: 'the Personal AI agent\'s own start' },
  'src/core/subagents/on-host.ts': { count: 1, why: 'a Walnut subagent (Claude Code, or an ACP engine that names its own session): subagentMode never runs above its caller (bypass only for a full-access caller)' },
}

/** file -> why its start calls hand on the caller but not the vouched job (a job stays capped at default there). */
const HANDS_CALLER_NOT_JOB: Record<string, { count: number; why: string }> = {
  'src/commands/direct-commands.ts': { count: 1, why: 'a CLI command typed on this machine: no host relays a job\'s call here' },
  'src/web/routes/sessions.ts': { count: 1, why: 'the web quick start: a job reaches it only through the generic api op, and stays capped' },
  'src/web/routes/engine-switch-v1.ts': { count: 1, why: 'task_switch_engine: a job does not need to loosen a switch, so it stays capped' },
  'src/web/routes/task-move-v1.ts': { count: 2, why: 'task_move\'s engine switch: a job does not need to loosen it, so it stays capped' },
  'src/web/routes/quick-input-v1.ts': { count: 2, why: 'the quick input box of the UI and phone: a job never starts work through it, capped' },
  'src/web/routes/session-launch-v1.ts': { count: 2, why: 'the phone\'s launch routes: a job never starts work through them, capped' },
  'src/core/sessions/mobile-launch.ts': { count: 1, why: 'the phone\'s launch: a job never starts work through it, capped' },
  'src/core/sessions/engine-switch.ts': { count: 1, why: 'an engine switch\'s first start runs the mode the switch capped, a job\'s included' },
  'src/core/sessions/task-start.ts': { count: 1, why: 'the move off a lost host names no mode: the conversation keeps its own' },
  'src/core/sessions/start-queue.ts': { count: 2, why: 'only a session\'s automatic start waits for a slot (waitForHostSlot refuses an outside caller)' },
  'src/core/transfer/transfer.ts': { count: 1, why: 'task_transfer: a job does not need to loosen a transfer, so it stays capped' },
  'src/core/workspaces/manager.ts': { count: 1, why: 'a quick start\'s replay: only a task_start\'s pending start keeps its job (launch.ts taskStartPending)' },
}

/** file -> why its capStartMode calls pass no vouched job. */
const CAPS_WITHOUT_JOB: Record<string, { count: number; why: string }> = {
  'src/core/sessions/delegated-mode.ts': { count: 1, why: 'modeChangeRefusal: a job does not change a live session\'s mode, so it stays capped' },
  'src/core/sessions/quick-start.ts': { count: 2, why: 'the quick start: a job reaches it only through the generic api op, and stays capped' },
  'src/web/routes/sessions.ts': { count: 4, why: 'the web quick start and a plan\'s execution: no job starts work through them, capped' },
  'src/core/sessions/engine-switch.ts': { count: 1, why: 'an engine switch\'s mode: a job does not need to loosen it, so it stays capped' },
  'src/core/transfer/transfer.ts': { count: 1, why: 'a transfer\'s mode: a job does not need to loosen it, so it stays capped' },
}

/** file -> why its start calls hand on the caller but not the unproven mark: no relayed session call reaches them. */
const HANDS_CALLER_NOT_UNPROVEN: Record<string, { count: number; why: string }> = {
  'src/commands/direct-commands.ts': { count: 1, why: 'a CLI command typed on this machine: no host relays a call here, so nothing is unproven' },
}

/** file -> why its capStartMode / modeChangeRefusal calls pass no unproven mark. */
const CAPS_WITHOUT_UNPROVEN: Record<string, { count: number; why: string }> = {}

/** file -> its `follower.start` calls (a start the host's own server makes while the Mac is away), and how each is capped. */
const FOLLOWER_STARTS: Record<string, { count: number; why: string }> = {
  'src/replica/away-starts.ts': { count: 1, why: 'task_start and task_create\'s start: capAwayStart before anything else, its mode sent' },
  'src/replica/ask-launch.ts': { count: 2, why: 'a new ask (its check, then its start): capAwayStart, as the Mac\'s quick start caps it' },
}

/** Routes (src/web/routes) whose mode changes are not a session's request. */
const MODE_CHANGE_ROUTES_EXEMPT: Record<string, { count: number; why: string }> = {}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

/** Each call `fn(...)` (also `fn?.(`), parentheses balanced, and the `lines` lines before it. */
function callsIn(src: string, names: string[], lines = 3): { call: string; before: string; at: number }[] {
  const calls: { call: string; before: string; at: number }[] = []
  const re = new RegExp(`\\b(?:${names.join('|')})\\s*(?:\\?\\.)?\\(`, 'g')
  for (const m of src.matchAll(re)) {
    const at = m.index!
    const lineStart = src.lastIndexOf('\n', at) + 1
    const lead = src.slice(lineStart, at)
    // Comment lines and the functions' own definitions are not calls.
    if (/^\s*(\*|\/\/|\/\*)/.test(lead) || /\bfunction\s*$/.test(lead)) continue
    let depth = 0
    let end = src.indexOf('(', at)
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++
      else if (src[end] === ')' && --depth === 0) break
    }
    calls.push({ at, call: src.slice(at, end + 1), before: src.slice(0, lineStart).split('\n').slice(-(lines + 1)).join('\n') })
  }
  return calls
}

const handsOnUnproven = (call: string) => /\bcallerUnproven\b/.test(call)
const passesUnproven = (call: string) => /\bunproven\s*(?::\s*(?!undefined\b)[\w.]|[,}\s])/.test(call)
const handsOnCaller = (call: string) => /\bcallerSid\s*(?::\s*(?!undefined\b)[\w.]|[,}\s])/.test(call)
const capsItself = (text: string, cap: string) => new RegExp(`\\b${cap}\\b`).test(text)

const files = sourceFiles(join(ROOT, 'src')).map(path => ({
  file: relative(ROOT, path).split('\\').join('/'),
  src: readFileSync(path, 'utf8'),
}))

describe('launch-mode ceiling on every start path', () => {
  it('finds the start paths at all', () => {
    expect(files.reduce((n, f) => n + callsIn(f.src, START_FUNCTIONS).length, 0)).toBeGreaterThan(20)
  })

  it('no file reaches a start function under another name', () => {
    const renamed = files.filter(f => new RegExp(`\\b(?:${START_FUNCTIONS.join('|')})\\s*:\\s*\\w+\\s*[,}]`).test(f.src)).map(f => f.file)
    expect(renamed).toEqual([])
  })

  it('every start call hands on the asking session or caps its mode, or is listed with why it needs no cap', () => {
    const uncapped: Record<string, number> = {}
    for (const { file, src } of files) {
      const n = callsIn(src, START_FUNCTIONS).filter(({ call, before }) => !handsOnCaller(call) && !capsItself(call + before, 'capStartMode')).length
      if (n) uncapped[file] = n
    }
    expect(uncapped).toEqual(Object.fromEntries(Object.entries(NOT_A_SESSIONS_START).map(([f, v]) => [f, v.count])))
  })

  it('every SESSION_START emit is listed with why its mode is bounded', () => {
    const emits: Record<string, number> = {}
    for (const { file, src } of files) {
      const n = (src.match(/emit\(\s*EventNames\.SESSION_START\b/g) ?? []).length
      if (n) emits[file] = n
    }
    expect(emits).toEqual(Object.fromEntries(Object.entries(SESSION_START_EMITS).map(([f, v]) => [f, v.count])))
  })

  it('every route that changes a session\'s mode checks the caller first', () => {
    const unchecked: Record<string, number> = {}
    for (const { file, src } of files.filter(f => f.file.startsWith('src/web/routes/'))) {
      // The check runs in the same route handler, before its relay branch: from the handler's start to the call.
      const n = callsIn(src, MODE_CHANGES, 0).filter(({ call, at }) => {
        const handler = src.slice(0, at).search(/\w+Router\.(?:get|post|patch|put|delete)\([^\n]*$(?![\s\S]*\w+Router\.(?:get|post|patch|put|delete)\()/m)
        return !capsItself(src.slice(Math.max(0, handler), at) + call, 'modeChangeRefusal')
      }).length
      if (n) unchecked[file] = n
    }
    expect(unchecked).toEqual(Object.fromEntries(Object.entries(MODE_CHANGE_ROUTES_EXEMPT).map(([f, v]) => [f, v.count])))
  })

  it('every start call that hands on the caller hands on the vouched job too, or is listed with why a job stays capped', () => {
    const dropped: Record<string, number> = {}
    for (const { file, src } of files) {
      const n = callsIn(src, START_FUNCTIONS).filter(({ call }) => handsOnCaller(call) && !/\bcallerJob/.test(call)).length
      if (n) dropped[file] = n
    }
    expect(dropped).toEqual(Object.fromEntries(Object.entries(HANDS_CALLER_NOT_JOB).map(([f, v]) => [f, v.count])))
  })

  it('every capStartMode call passes the vouched job, or is listed with why a job stays capped', () => {
    const bare: Record<string, number> = {}
    for (const { file, src } of files) {
      const n = callsIn(src, ['capStartMode'], 0).filter(({ call }) => !/\bjob\s*:\s*(?!undefined\b)[\w.]/.test(call)).length
      if (n) bare[file] = n
    }
    expect(bare).toEqual(Object.fromEntries(Object.entries(CAPS_WITHOUT_JOB).map(([f, v]) => [f, v.count])))
  })

  it('every start call that hands on the caller hands on the unproven mark too, or is listed with why no relayed call reaches it', () => {
    const dropped: Record<string, number> = {}
    for (const { file, src } of files) {
      const n = callsIn(src, START_FUNCTIONS).filter(({ call }) => handsOnCaller(call) && !handsOnUnproven(call)).length
      if (n) dropped[file] = n
    }
    expect(dropped).toEqual(Object.fromEntries(Object.entries(HANDS_CALLER_NOT_UNPROVEN).map(([f, v]) => [f, v.count])))
  })

  it('every capStartMode and modeChangeRefusal call passes the unproven mark, or is listed', () => {
    const bare: Record<string, number> = {}
    for (const { file, src } of files) {
      const n = callsIn(src, ['capStartMode', 'modeChangeRefusal'], 0).filter(({ call }) => !passesUnproven(call)).length
      if (n) bare[file] = n
    }
    expect(bare).toEqual(Object.fromEntries(Object.entries(CAPS_WITHOUT_UNPROVEN).map(([f, v]) => [f, v.count])))
  })

  it('the relay hands the daemon\'s unproven mark to the op, and the start routes read it', () => {
    const router = files.find(f => f.file === 'src/core/peers/capability-router.ts')!.src
    expect(router).toMatch(/relayedCallerUnproven\(payload\)/)
    expect(callsIn(router, ['executeOp']).some(c => /\bcallerUnproven\b/.test(c.call))).toBe(true)
    const route = files.find(f => f.file === 'src/web/routes/task-v1.ts')!.src
    const start = callsIn(route, ['startSessionForTask']).map(c => c.call)
    expect(start[0]).toMatch(/callerUnproven:\s*trust\.callerUnproven\b/)
    // The one request reader of the start routes reads the mark (core/sessions/start-request-caller.ts).
    expect(files.find(f => f.file === 'src/core/sessions/start-request-caller.ts')!.src).toMatch(/callerUnprovenOf\(req\)/)
    // The follower's away starts read it before their actor (replica/start-ceiling.ts).
    const away = files.find(f => f.file === 'src/replica/start-ceiling.ts')!.src
    expect(away).toMatch(/if \(callerUnprovenOf\(req\)\) return \{ kind: 'external' \}/)
  })

  it('the routes a job\'s task_create and task_start reach read the vouched job', () => {
    const route = files.find(f => f.file === 'src/web/routes/task-v1.ts')!.src
    expect(files.find(f => f.file === 'src/core/sessions/start-request-caller.ts')!.src).toMatch(/vouchedPluginJob\(req\)/)
    const start = callsIn(route, ['startSessionForTask']).map(c => c.call)
    expect(start.length).toBe(1)
    expect(start[0]).toMatch(/\bcallerJob:\s*trust\.callerJob\b/)
  })

  it('the start route and the start check read their caller through the one reader, and nothing else reads it apart', () => {
    // So a change to who a start's caller is (a new credential, a new mark) reaches task_start_check too.
    const handlerOf = (src: string, route: string) => {
      const at = src.indexOf(`.post('${route}'`)
      expect(at, route).toBeGreaterThan(-1)
      const next = src.slice(at + 1).search(/\n\w+Router\.(?:get|post|patch|put|delete)\(/)
      return next === -1 ? src.slice(at) : src.slice(at, at + 1 + next)
    }
    const start = handlerOf(files.find(f => f.file === 'src/web/routes/task-v1.ts')!.src, '/tasks/:id/start')
    const check = handlerOf(files.find(f => f.file === 'src/web/routes/task-start-check-v1.ts')!.src, '/tasks/start-check')
    for (const [name, handler] of [['start', start], ['check', check]] as const) {
      expect(handler, name).toMatch(/startRequestCaller\(req\)/)
      // No second reading beside it: the sid header, the job's credential and the mark come from the reader only.
      expect(handler, name).not.toMatch(/vouchedPluginJob\(|callerUnprovenOf\(|headers\[['"]x-walnut-caller-sid['"]\]/)
    }
    // The check hands the reader's three fields to the ceiling's own caller read (startCallerOf) and answer.
    expect(check).toMatch(/startCallerOf\(trust\.callerSid,\s*\{\s*job:\s*trust\.callerJob,\s*unproven:\s*trust\.callerUnproven\s*\}\)/)
    expect(check).toMatch(/startCheckAnswer\(/)
    // And a host replica's check reads the caller as its away starts do (start-ceiling.ts awayStartCaller).
    const replica = files.find(f => f.file === 'src/replica/start-ceiling.ts')!.src
    const awayCheck = replica.slice(replica.indexOf('export function awayStartCheck'))
    expect(awayCheck).toMatch(/awayStartCaller\(req, actor, deps\.startCaller\)/)
    expect(awayCheck).toMatch(/startCheckAnswer\(/)
  })

  it('every start a host\'s own server makes while the Mac is away meets the Mac\'s ceiling', () => {
    const starts: Record<string, number> = {}
    // The daemon twins answer the command; they do not send it.
    // The direct follower link only carries a caller's call to the runtime (its table row names the
    // command); the callers above cap it first, as they do over the socket link.
    const CARRIERS: Record<string, number> = { 'src/core/link/follower-link-direct.ts': 1 }
    for (const { file, src } of files.filter(f => !f.file.startsWith('src/providers/'))) {
      // Any quoted name of the command in code (a link's call or request, any quote), comments aside.
      const code = src.split('\n').filter(l => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')
      const n = (code.match(/['"`]follower\.start['"`]/g) ?? []).length
      if (file in CARRIERS) { expect(n, `${file} carries follower.start a new way`).toBe(CARRIERS[file]); continue }
      if (n) starts[file] = n
    }
    expect(starts).toEqual(Object.fromEntries(Object.entries(FOLLOWER_STARTS).map(([f, v]) => [f, v.count])))
    for (const file of Object.keys(FOLLOWER_STARTS)) {
      const src = files.find(f => f.file === file)!.src
      const caps = callsIn(src, ['capAwayStart'], 0).map(c => c.call)
      expect(caps.length, `${file} caps no start mode`).toBeGreaterThan(0)
      // A mode read off the body (b.mode, b['mode'], req.body.mode, bodyOf(req).mode, { mode } = b) only inside the cap's call.
      const rest = caps.reduce((left, call) => left.split(call).join(''), src)
      const outside = rest.match(/\b(?:b|body|req\.body|bodyOf\(req\))(?:\.mode\b|\[\s*['"`]mode['"`]\s*\])|\{[^}]*\bmode\b[^}]*\}\s*=\s*(?:b|body|req\.body|bodyOf\(req\))\b/g) ?? []
      expect(outside, `${file} reads a mode off the body outside capAwayStart`).toEqual([])
    }
  })

  it('every listed reason says something', () => {
    for (const { why } of [...Object.values(NOT_A_SESSIONS_START), ...Object.values(SESSION_START_EMITS), ...Object.values(HANDS_CALLER_NOT_JOB), ...Object.values(CAPS_WITHOUT_JOB), ...Object.values(HANDS_CALLER_NOT_UNPROVEN), ...Object.values(CAPS_WITHOUT_UNPROVEN), ...Object.values(FOLLOWER_STARTS)]) expect(why.length).toBeGreaterThan(20)
  })
})
