/**
 * An e2e wait on a per-session broadcast names the session or task it waits for.
 *
 * The server broadcasts `session:result`, `session:error`, `session:status-changed`
 * and the other per-session events to every client, for every session, and an e2e
 * file runs its tests against one server. A wait on "the next session:result" also
 * takes a late frame of the previous test's session (GitHub CI, 2026-11-07:
 * session-lifecycle's plan-mode test got `sess-task-001`'s result). Every such
 * wait passes a match (`{ taskId }`, `{ sessionId }`, `newSession(...)` or a
 * predicate; tests/helpers/ws-event-wait.ts).
 *
 * The per-session events are read from source: every event of
 * `EventPayloadMap` (src/core/event-types.ts) whose payload carries a top-level
 * `sessionId` or `taskId`, following `extends`. The scan finds every call of a
 * function named wait... in tests/e2e/**\/*.test.ts with such an event name as a
 * string argument, and fails when no other argument filters (only numbers,
 * constants, `() => true`, `undefined` or nothing).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(__dirname, '../..')
const TYPE_FILES = ['src/core/event-types.ts', 'src/core/types.ts']

/** The text between the brace at `open` and its match. */
function braceBody(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

/** Top-level field names of an object type body (nested object types skipped). */
function topLevelFields(body: string): string[] {
  const fields: string[] = []
  let depth = 0
  for (const line of body.split('\n')) {
    if (depth === 0) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(line)
      if (m) fields.push(m[1])
    }
    for (const c of line.replace(/\/\/.*$/, '')) {
      if (c === '{') depth++
      else if (c === '}') depth--
    }
  }
  return fields
}

/** Whether the named payload type carries sessionId or taskId at its top level; null when not found. */
export function carriesSessionOrTask(typeName: string, sources: string[], seen = new Set<string>()): boolean | null {
  if (seen.has(typeName)) return false
  seen.add(typeName)
  for (const text of sources) {
    const m = new RegExp(String.raw`export interface ${typeName}\b(?:<[^>{]*>)?\s*(?:extends\s+([^{]+))?\{`).exec(text)
    if (!m) continue
    const fields = topLevelFields(braceBody(text, m.index + m[0].length - 1))
    if (fields.includes('sessionId') || fields.includes('taskId')) return true
    for (const base of (m[1] ?? '').split(',').map((b) => b.trim().replace(/<.*$/, '')).filter(Boolean)) {
      if (carriesSessionOrTask(base, sources, seen)) return true
    }
    return false
  }
  return null
}

/** Event names from `EventPayloadMap` whose payload belongs to one session or task. */
export function perSessionEvents(sources: string[]): string[] {
  const map = sources[0]
  const start = map.indexOf('export interface EventPayloadMap')
  if (start < 0) throw new Error('EventPayloadMap not found in src/core/event-types.ts')
  const body = braceBody(map, map.indexOf('{', start))
  const names: string[] = []
  for (const m of body.matchAll(/^\s*'([a-z-]+:[a-z-]+)':\s*([A-Za-z_$][\w$]*)\s*;/gm)) {
    const carries = carriesSessionOrTask(m[2], sources)
    // A session event whose payload type is not found here counts as per-session.
    if (carries || (carries === null && m[1].startsWith('session:'))) names.push(m[1])
  }
  return names
}

/** Split a call's argument text at top-level commas (strings, templates, comments and brackets respected). */
export function splitArgs(text: string): string[] {
  const args: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      cur += text.slice(i, j + 1)
      i = j
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const j = text.indexOf('\n', i)
      i = j < 0 ? text.length : j
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2)
      i = j < 0 ? text.length : j + 1
      continue
    }
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    if (c === ',' && depth === 0) {
      args.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) args.push(cur.trim())
  return args
}

/** The argument text of the call whose `(` is at `open`. */
function callArgs(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1
      i = j
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

const NO_FILTER = /^(?:[\d_.]+|[A-Z][A-Z0-9_]*|[\d_.\sA-Z*+-]+|undefined|null|\{\s*\}|\(\s*\)\s*=>\s*true|\(\s*\w*\s*\)\s*=>\s*true|\w+\s*=>\s*true)$/

/** Waits in one file's text on a per-session event with no filtering argument. */
export function unfilteredWaits(text: string, events: ReadonlySet<string>): Array<{ line: number; call: string }> {
  const out: Array<{ line: number; call: string }> = []
  for (const m of text.matchAll(/\b(wait\w*)\s*\(/gi)) {
    const before = text.slice(Math.max(0, m.index - 9), m.index)
    if (/function\s+$/.test(before)) continue
    const open = m.index + m[0].length - 1
    const args = splitArgs(callArgs(text, open))
    const eventAt = args.findIndex((a) => /^'[^']*'$/.test(a) && events.has(a.slice(1, -1)))
    if (eventAt < 0 || eventAt > 1) continue
    const rest = args.filter((_, i) => i !== eventAt && !(eventAt === 1 && i === 0))
    if (rest.some((a) => !NO_FILTER.test(a))) continue
    out.push({ line: text.slice(0, m.index).split('\n').length, call: `${m[1]}(${args.join(', ')})` })
  }
  return out
}

function e2eTestFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.test.ts')) out.push(path.relative(REPO, full).split(path.sep).join('/'))
    }
  }
  walk(path.join(REPO, 'tests/e2e'))
  return out.sort()
}

describe('e2e waits on per-session broadcasts', () => {
  const sources = TYPE_FILES.map((f) => fs.readFileSync(path.join(REPO, f), 'utf8'))
  const events = new Set(perSessionEvents(sources))

  it('reads the per-session events from the event payload types', () => {
    for (const name of ['session:result', 'session:started', 'session:error', 'session:text-delta',
      'session:status-changed', 'session:tool-use', 'session:messages-delivered', 'session:usage-update']) {
      expect(events.has(name), name).toBe(true)
    }
    // Payloads that name no session or task are not per-session.
    expect(events.has('task:groups-changed')).toBe(false)
    expect(events.has('host:subscription-limits')).toBe(false)
  })

  it('finds the shapes a test writes', () => {
    const ev = new Set(['session:result'])
    const sites = (t: string) => unfilteredWaits(t, ev).map((s) => s.call)
    expect(sites("await waitForWsEvent(ws, 'session:result')")).toEqual(["waitForWsEvent(ws, 'session:result')"])
    expect(sites("waitForWsEvent(ws, 'session:result', 30_000)")).toHaveLength(1)
    expect(sites("waitForWsEvent(ws, 'session:result', () => true, TIMEOUT_MS)")).toHaveLength(1)
    expect(sites("waitForWsEvents(ws, 'session:result', 2, 30000)")).toHaveLength(1)
    expect(sites("waitEvent(ws, 'session:result')")).toHaveLength(1)
    expect(sites("waitForWsEvent(\n  ws,\n  'session:result',\n)")).toHaveLength(1)
    // Filtered, a different event, or the helper's own definition.
    expect(sites("waitForWsEvent(ws, 'session:result', { taskId: 'a' })")).toEqual([])
    expect(sites("waitForWsEvent(ws, 'session:result', { sessionId }, 20000)")).toEqual([])
    expect(sites("waitForWsEvent(ws, 'session:result', newSession({ taskId: '' }), 30000)")).toEqual([])
    expect(sites("waitForWsEvent(\n  ws,\n  'session:result',\n  (d) => d.sessionId === sid, // why\n)")).toEqual([])
    expect(sites("waitForWsEvent(ws, 'task:updated')")).toEqual([])
    expect(sites('function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 15000) {}')).toEqual([])
  })

  it('every e2e wait on a per-session event names its session or task', () => {
    const offenders: string[] = []
    for (const file of e2eTestFiles()) {
      for (const site of unfilteredWaits(fs.readFileSync(path.join(REPO, file), 'utf8'), events)) {
        offenders.push(`${file}:${site.line}  ${site.call}`)
      }
    }
    expect(offenders, 'the server broadcasts these events for every session: pass { taskId }, { sessionId }, '
      + 'newSession(...) or a predicate (tests/helpers/ws-event-wait.ts)').toEqual([])
  })
})
