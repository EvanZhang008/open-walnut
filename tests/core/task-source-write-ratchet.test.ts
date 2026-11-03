/**
 * Ratchet: nothing gives a task an outside service, or a project a service, unless someone chose
 * it (2026-11-01: a project move migrated the user's personal tasks to a work tracker, and the
 * project they were moved into had become a tracker project by inheriting the service of the
 * first task moved into its brand-new name; tests/core/move-never-changes-service.test.ts walks
 * every move).
 *
 * Scans src/ for every assignment to a `.source` field and every project registry row written
 * with a `source:`, and fails on one no entry below names, or on a listed file whose count moved.
 * Taking a task OFF a service (`= 'local'`) is always allowed. Any other write is listed with the
 * choice that makes it, and the file must still carry the code that holds it to that choice.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'src')

/** `<x>.source = <value>` (not a comparison), on any object but the unrelated fields below. */
const ASSIGN_RE = /\b([A-Za-z_$][\w$]*)\.source\s*=(?!=)\s*([^;\n]+)/g
/** Objects whose `.source` is not a task's service (an event, a view, a log record, a query, a
 *  host daemon update's facts, whose source is the daemon file). */
const NOT_A_TASK = new Set(['this', 'entry', 'view', 'rec', 'params', 'options', 'opts', 'meta', 'audio', 'node', 'facts'])
/** A project registry row written with a source: `[<name>]: { ...?, source: <value> }`. */
const ROW_RE = /\]:\s*\{\s*(?:\.\.\.[^,}]+,\s*)?source\b(?:\s*:\s*([^,}\n]+?))?\s*[,}]/g

interface Site { count: number; why: string; mustContain: RegExp }

/** Every write that can give a task, or a project, an outside service. */
const TASK_SITES: Record<string, Site> = {
  'src/core/task-manager.ts': {
    count: 2,
    why: 'releaseSyncHold: the user chose Sync, or the privacy gate judged the task work; '
      + '_setSourceForTesting: a synced fixture for tests, called by no source file',
    mustContain: /export async function releaseSyncHold\([\s\S]*export async function _setSourceForTesting\(|export async function _setSourceForTesting\([\s\S]*export async function releaseSyncHold\(/,
  },
  'src/core/task-db-migration.ts': {
    count: 2,
    why: 'a one-time schema migration normalizes stored rows to the service they already had',
    mustContain: /pickMajoritySource|authoritativeSource/,
  },
}

const ROW_SITES: Record<string, Site> = {
  'src/core/task-manager.ts': {
    count: 5,
    why: 'a rename keeps the renamed project\'s own service; a move keeps the destination\'s own '
      + 'claim (`opts.claim`); a pull registers the project its own service named; a task created '
      + 'under a new name registers it with the service the caller named, the user\'s configured '
      + 'reservation (a plugin claim), or the personal list\'s default claim',
    mustContain: /source: renameSource[\s\S]*\[project\]: \{ source, [\s\S]*source: opts\.claim[\s\S]*\[incomingProject\]: \{ source: task\.source \}/,
  },
}

/** `ensureProject(<name>, <source>` with a source that is not the literal 'local'. */
const ENSURE_RE = /(?<!function )\bensureProject\(\s*[^,()]+,\s*([^,)]+)/g

/** Every create of a project row that can claim a service: the service's own, or a person's choice. */
const ENSURE_SITES: Record<string, Site> = {
  'src/core/task-manager.ts': {
    count: 1, why: 'deleteProject: the survivor a cascade redirects to keeps its own service',
    mustContain: /await ensureProject\(survivorProject, record\.source\)/,
  },
  'src/core/sync-reconciler.ts': {
    count: 1, why: 'a pull registers the project its own service named',
    mustContain: /ensureProject\(name, pluginId as Task\['source'\]/,
  },
  'src/integrations/microsoft-todo.ts': {
    count: 2, why: 'the plugin registers its own lists (a list, or a renamed one) as its projects',
    mustContain: /ensureProject\(parsed, 'ms-todo'/,
  },
  'src/web/routes/projects.ts': {
    count: 1, why: 'POST /api/projects: the person (the picker) or agent (project_create) chose the service',
    mustContain: /human: true/,
  },
  'src/web/routes/projects-v1.ts': {
    count: 1, why: 'POST /api/v1/projects: the phone\'s create, the person chose the service',
    mustContain: /ensureProject\(name,/,
  },
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

/** The file without its comment lines (a doc line quoting a write is no write). */
function code(text: string): string {
  return text.split('\n').filter((l) => !/^\s*(?:\*|\/\/|\/\*)/.test(l)).join('\n')
}

const isLocal = (value: string) => /^['"]local['"]/.test(value.trim())

function scan() {
  const tasks = new Map<string, string[]>()
  const rows = new Map<string, string[]>()
  const ensures = new Map<string, string[]>()
  for (const file of walk(SRC)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    const text = code(fs.readFileSync(file, 'utf8'))
    for (const m of text.matchAll(ASSIGN_RE)) {
      if (NOT_A_TASK.has(m[1]) || isLocal(m[2])) continue
      tasks.set(rel, [...(tasks.get(rel) ?? []), m[0].trim()])
    }
    for (const m of text.matchAll(ROW_RE)) {
      if (m[1] !== undefined && isLocal(m[1])) continue
      rows.set(rel, [...(rows.get(rel) ?? []), m[0].trim()])
    }
    for (const m of text.matchAll(ENSURE_RE)) {
      if (isLocal(m[1])) continue
      ensures.set(rel, [...(ensures.get(rel) ?? []), m[0].trim()])
    }
  }
  return { tasks, rows, ensures }
}

describe('a task or a project gets an outside service only by someone\'s choice', () => {
  const { tasks, rows, ensures } = scan()

  for (const [label, found, sites] of [
    ['task source', tasks, TASK_SITES], ['project row source', rows, ROW_SITES], ['ensureProject source', ensures, ENSURE_SITES],
  ] as const) {
    it(`every ${label} write is a listed, chosen one`, () => {
      const unlisted = [...found].filter(([f]) => !sites[f]).map(([f, w]) => `${f}: ${w.join(' | ')}`)
      expect(unlisted, `A new ${label} write. Taking a task off a service is \`= 'local'\`; any other `
        + 'write must come from a person\'s or the gate\'s choice (releaseSyncHold, an explicit project '
        + 'create) and be listed here with that choice').toEqual([])
      for (const [file, site] of Object.entries(sites)) {
        expect(found.get(file)?.length ?? 0, `${file}: ${site.why}`).toBe(site.count)
        expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).toMatch(site.mustContain)
      }
    })
  }

  it('no source file calls the test-only source helper', () => {
    const callers = walk(SRC).filter((f) => !f.endsWith('task-manager.ts') && /_setSourceForTesting\(/.test(fs.readFileSync(f, 'utf8')))
    expect(callers.map((f) => path.relative(ROOT, f))).toEqual([])
  })

  it('no source file picks a new project\'s service from a catch-all claim', () => {
    // getForProject answers for every name (the personal list claims them all); a new project
    // takes a service only from a claim set up for its exact name (getNamedClaimFor).
    const callers = walk(SRC).filter((f) => !f.endsWith('integration-registry.ts') && /\.getForProject\(/.test(code(fs.readFileSync(f, 'utf8'))))
    expect(callers.map((f) => path.relative(ROOT, f))).toEqual([])
  })

  it('the patterns see a write (so a renamed variable cannot hide one)', () => {
    const sample = "task.source = target;\nstore.projects = { ...projects, [name]: { source: task.source } };\n"
      + "store.projects = { ...projects, [name]: { source, order_index: 1 } };\nentry.source = 'x'"
    expect([...sample.matchAll(ASSIGN_RE)].filter((m) => !NOT_A_TASK.has(m[1])).length).toBe(1)
    expect([...sample.matchAll(ROW_RE)].length).toBe(2)
  })
})
