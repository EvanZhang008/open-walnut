/**
 * Ratchet: every choice a person makes when creating and running a task in the
 * web UI has an op argument that makes it for an agent, or a written reason it
 * has none (src/ops/launch-parity.ts). 2026-10-27: task_create and task_start
 * took no reasoning effort, a lead could not stop or restart a worker's session,
 * and nothing noticed, because the draft column and the op registry grew apart.
 *
 * Reads the sources themselves, so a new field in the draft's launch payload,
 * the quick-start body, the task meta, a session's settings or the panel's
 * session actions fails here until it is mapped.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getOp } from '../../src/ops/index.js'
import {
  LAUNCH_PARITY, SESSION_ACTION_PARITY, SESSION_SETTING_PARITY, TASK_META_PARITY, type ParityEntry,
} from '../../src/ops/launch-parity.js'

const read = (rel: string) => fs.readFileSync(path.resolve(rel), 'utf-8')

/** Text between `start` and the first `end` after it. */
function region(src: string, start: string, end: string): string {
  const i = src.indexOf(start)
  expect(i, `marker not found: ${start}`).toBeGreaterThanOrEqual(0)
  const j = src.indexOf(end, i + start.length)
  expect(j, `end marker not found after: ${start}`).toBeGreaterThan(i)
  return src.slice(i + start.length, j)
}

/** Property names at the top level of a type literal body (comments stripped). */
function topLevelKeys(body: string): string[] {
  const text = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const keys: string[] = []
  let depth = 0
  for (const line of text.split('\n')) {
    const m = depth === 0 ? /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line) : null
    if (m) keys.push(m[1])
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth++
      else if (ch === '}' || ch === ')' || ch === ']') depth--
    }
  }
  return keys
}

function launchFields(): string[] {
  const client = topLevelKeys(region(read('web/src/api/sessions.ts'), 'export async function quickStartSession(opts: {', '}): Promise<'))
  const route = region(read('src/web/routes/sessions.ts'), "sessionsRouter.post('/quick-start'", '} = req.body')
  const destructured = region(route + '}', 'const {', '}').split(',')
    .map((part) => part.split(':')[0].trim()).filter(Boolean)
  // Fields the handler reads off the body directly, past the destructure.
  const handler = region(read('src/web/routes/sessions.ts'), "sessionsRouter.post('/quick-start'", 'sessionsRouter.')
  const direct = [
    ...handler.matchAll(/\(req\.body as \{ ([A-Za-z_]+)\??:/g),
    ...handler.matchAll(/req\.body\??\.([A-Za-z_]+)/g),
  ].map((m) => m[1])
  return [...new Set([...client, ...destructured, ...direct])]
}

function taskMetaFields(): string[] {
  return topLevelKeys(region(read('src/core/sessions/quick-start.ts'), 'export interface QuickStartTaskMeta {', '\n}'))
}

function sessionSettingFields(): string[] {
  const patch = region(read('src/core/sessions/session-lifecycle.ts'), 'export async function patchSession(', '} = input;')
  const keys = patch.slice(patch.indexOf('const {') + 'const {'.length)
  // Model and effort are their own routes (POST /sessions/:id/model and /effort).
  return [...keys.split(',').map((k) => k.trim()).filter(Boolean), 'model', 'effort']
}

/** Every source file under a directory (the web client: api modules, hooks and components alike). */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.resolve(dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
}

function sessionActions(): string[] {
  const actions = new Set<string>()
  for (const file of sourceFiles('web/src')) {
    for (const m of fs.readFileSync(file, 'utf-8').matchAll(/\/api\/sessions\/\$\{[^}]*\}\/([a-z][a-z-]*)/g)) actions.add(m[1])
  }
  return [...actions]
}

/** Every op argument an entry names exists in that op's input schema. */
function assertMapped(table: Readonly<Record<string, ParityEntry>>, fields: string[], what: string): void {
  const missing = fields.filter((f) => !(f in table))
  expect(missing, `${what} without an op argument or a reason in src/ops/launch-parity.ts`).toEqual([])
  const stale = Object.keys(table).filter((k) => !fields.includes(k))
  expect(stale, `${what} mapped in launch-parity.ts but no longer in the source`).toEqual([])
  for (const [field, entry] of Object.entries(table)) {
    if ('none' in entry) {
      expect(entry.none.length, `${what} "${field}" needs a real reason`).toBeGreaterThanOrEqual(15)
      continue
    }
    for (const ref of [entry.op].flat()) {
      const [name, arg] = ref.split('.')
      const op = getOp(name)
      expect(op, `${what} "${field}" names op ${name}, which does not exist`).toBeTruthy()
      if (arg) expect(Object.keys(op!.input), `${what} "${field}": ${name} has no argument ${arg}`).toContain(arg)
    }
  }
}

describe('launch parity: an agent makes every choice a person makes', () => {
  it('reads real fields from every source (the parsers still find them)', () => {
    expect(launchFields()).toEqual(expect.arrayContaining(['cwd', 'host', 'model', 'mode', 'engine', 'createCwd', 'workspace']))
    expect(taskMetaFields()).toEqual(expect.arrayContaining(['priority', 'pinTier', 'due_date']))
    expect(sessionSettingFields()).toEqual(expect.arrayContaining(['mode', 'output_mode', 'model', 'effort']))
    expect(sessionActions()).toEqual(expect.arrayContaining(['restart', 'terminate', 'effort', 'side-threads', 'commit']))
  })

  it('every draft launch option', () => assertMapped(LAUNCH_PARITY, launchFields(), 'launch option'))
  it('every task field of the draft', () => assertMapped(TASK_META_PARITY, taskMetaFields(), 'task meta field'))
  it('every setting of a running session', () => assertMapped(SESSION_SETTING_PARITY, sessionSettingFields(), 'session setting'))
  it('every session action of the panel', () => assertMapped(SESSION_ACTION_PARITY, sessionActions(), 'session action'))

  it('task_create and task_start share one set of launch arguments, effort included', () => {
    const create = Object.keys(getOp('task_create')!.input)
    const start = Object.keys(getOp('task_start')!.input)
    for (const arg of ['effort', 'model', 'mode', 'engine', 'cwd', 'host', 'create_cwd', 'workspace', 'user_request']) {
      expect(create).toContain(arg)
      expect(start).toContain(arg)
    }
  })
})
