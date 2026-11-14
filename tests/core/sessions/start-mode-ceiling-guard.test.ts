/**
 * Every path that starts a session, or sets a session's mode, applies the launch-mode ceiling: a
 * session starts work at most as loose as its own mode (src/core/sessions/delegated-mode.ts
 * capStartMode, modeChangeRefusal). A permission gap is the risky kind, so this lists from the
 * source every call of the start functions, every SESSION_START emit and every route that changes
 * a session's mode: each one hands the asking session on (`callerSid: <value>` in the call) or
 * caps the mode itself (`capStartMode` / `modeChangeRefusal` in or right above the call), or is
 * listed below with why no session's mode bounds it. A new one fails until it is one of those.
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

  it('every listed reason says something', () => {
    for (const { why } of [...Object.values(NOT_A_SESSIONS_START), ...Object.values(SESSION_START_EMITS)]) expect(why.length).toBeGreaterThan(20)
  })
})
