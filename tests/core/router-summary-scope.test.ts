/**
 * Automatic text stays inside one incoming-item area (src/core/router/same-area.ts).
 *
 * Walnut builds text on its own for a node's or a session's model: the status question's list of
 * the tree's open asks (same-ask-tree.ts), the teammates a fold reads, a Brief's live lists and the
 * asks Walnut adds to it (brief.ts, brief-structure.ts), and the org report (morning-report.ts).
 * A task in an area must never reach a task outside it through any of these, and the other way
 * round; two unassigned tasks, or two of the same area, still share. The person's own views and
 * the lines a writer put into a Brief are not touched.
 *
 * The last block is a source guard: a new builder that walks a node's team or Main's whole org
 * must keep it to the owner's area too.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { sameTaskArea, sameAreaTasks } from '../../src/core/router/context-sharing.js'
import { relativeAsksIndex, teammatesIndex, treeAround, treeAsksOf } from '../../src/core/same-ask-tree.js'
import { briefNeedsAsks, briefSectionLines } from '../../src/core/sessions/brief.js'
import { briefAskScope, structureBrief } from '../../src/core/sessions/brief-structure.js'
import { buildMorningReport } from '../../src/core/org/morning-report.js'
import type { Task } from '../../src/core/types.js'
import type { LetterRecord } from '../../src/core/human-inbox/types.js'

const NOW = Date.parse('2026-11-07T10:00:00.000Z')
const SINCE = Date.parse('2026-11-07T00:00:00.000Z')

let n = 0
function task(id: string, extra: Partial<Task> = {}): Task {
  n += 1
  return {
    id, title: `Title ${id}`, phase: 'NEED_ACTION', status: 'in_progress', project: 'Garden',
    created_at: `2026-11-06T00:00:${String(n).padStart(2, '0')}.000Z`, phase_changed_at: '2026-11-07T05:00:00.000Z',
    user_status: { state: 'needs', source: 'session', ask: `Ask of ${id}: pick the garden layout option`, checkedAt: '2026-11-07T05:00:00.000Z' },
    ...extra,
  } as Task
}

const main = task('main', { org_role: 'main', project: '', phase: 'IN_PROGRESS', user_status: undefined })
const lead = task('lead', { org_role: 'lead', project: 'Garden', parent_task_id: 'main', phase: 'IN_PROGRESS', user_status: undefined })
const plain = task('plain', { parent_task_id: 'lead' })
const plain2 = task('plain2')
const inA = task('in-a', { router_area_id: 'area-a' })
const inA2 = task('in-a2', { router_area_id: 'area-a' })
const inB = task('in-b', { router_area_id: 'area-b' })
const inAUnderLead = task('in-a-kid', { parent_task_id: 'lead', router_area_id: 'area-a' })
const ALL: Task[] = [main, lead, plain, plain2, inA, inA2, inB, inAUnderLead]
const AREA_IDS = ['in-a', 'in-a2', 'in-b', 'in-a-kid']

describe('sameTaskArea', () => {
  it('both unassigned share, an empty mark is unassigned', () => {
    expect(sameTaskArea({ id: 'x' }, { id: 'y' })).toBe(true)
    expect(sameTaskArea({ id: 'x', router_area_id: '' }, { id: 'y' })).toBe(true)
  })
  it('the same area shares', () => {
    expect(sameTaskArea({ id: 'x', router_area_id: 'area-a' }, { id: 'y', router_area_id: 'area-a' })).toBe(true)
  })
  it('one area against none, or two areas, never share, either way round', () => {
    expect(sameTaskArea({ id: 'x', router_area_id: 'area-a' }, { id: 'y' })).toBe(false)
    expect(sameTaskArea({ id: 'x' }, { id: 'y', router_area_id: 'area-a' })).toBe(false)
    expect(sameTaskArea({ id: 'x', router_area_id: 'area-a' }, { id: 'y', router_area_id: 'area-b' })).toBe(false)
  })
  it('sameAreaTasks keeps the owner\'s area only', () => {
    expect(sameAreaTasks(main, ALL).map((t) => t.id)).toEqual(['main', 'lead', 'plain', 'plain2'])
    expect(sameAreaTasks(inA, ALL).map((t) => t.id)).toEqual(['in-a', 'in-a2', 'in-a-kid'])
  })
})

describe('the same-ask tree reads one area', () => {
  it('teammates: unassigned see unassigned, an area task sees its own area only', () => {
    const of = teammatesIndex(ALL)
    for (const t of of(plain2)) expect(AREA_IDS).not.toContain(t.id)
    expect(of(plain2).map((t) => t.id)).toContain('plain')
    expect(of(inA).map((t) => t.id)).toEqual(['in-a2', 'in-a-kid'])
    expect(of(inB)).toEqual([])
  })

  it('treeAround of a lead (its Brief team) and of a worker never holds another area', () => {
    const forLead = treeAround('lead', ALL).map((a) => a.task.id)
    expect(forLead).toContain('plain')
    for (const id of AREA_IDS) expect(forLead).not.toContain(id)
    const forAreaKid = treeAround('in-a-kid', ALL).map((a) => a.task.id)
    // Its leader is unassigned: not in its area, so not listed either.
    expect(forAreaKid).not.toContain('lead')
    expect(forAreaKid).toEqual(expect.arrayContaining(['in-a', 'in-a2']))
    expect(forAreaKid).not.toContain('in-b')
  })

  it('the status question and the fold index carry no ask of another area', () => {
    const letters = [{ id: 'lt-a', subject: 'Letter from area A about the layout', taskId: 'in-a' }]
    const asks = treeAsksOf('plain2', ALL, letters, false)
    expect(asks.map((a) => a.taskId)).toContain('plain')
    for (const a of asks) expect(AREA_IDS).not.toContain(a.taskId)
    expect(JSON.stringify(asks)).not.toContain('area A')
    const rel = relativeAsksIndex(ALL)
    for (const r of rel(plain2)) expect(AREA_IDS).not.toContain(r.id)
    expect(rel(inA).map((r) => r.id)).toEqual(['in-a2', 'in-a-kid'])
  })
})

describe('Brief text reads one area', () => {
  it('Main\'s and a lead\'s live lists hold no area task', () => {
    for (const owner of [main, lead]) {
      const text = JSON.stringify(briefSectionLines(owner, ALL, NOW))
      for (const id of AREA_IDS) expect(text).not.toContain(`Title ${id}`)
      const needs = Object.keys(briefNeedsAsks(owner, ALL))
      for (const id of AREA_IDS) expect(needs).not.toContain(id)
    }
    expect(Object.keys(briefNeedsAsks(main, ALL))).toEqual(expect.arrayContaining(['plain', 'plain2']))
  })

  it('an owner in an area reads only that area', () => {
    const areaLead = task('area-lead', { org_role: 'lead', router_area_id: 'area-a', phase: 'IN_PROGRESS', user_status: undefined })
    const scope = briefAskScope(areaLead, [...ALL, areaLead]).map((t) => t.id)
    expect(scope).toEqual(['in-a', 'in-a2', 'in-a-kid'])
  })

  it('Walnut adds no area ask to Main\'s Brief, and keeps a line the writer put there', () => {
    const written = `### Needs you\n- <task-ref id="in-a" label="Title in-a"/>: written by the node\n### Working\n- None\n### Waiting / snoozed\n- None`
    const out = structureBrief(written, main.id, ALL, { live: main })
    expect(out.asksAdded).toEqual(expect.arrayContaining(['plain', 'plain2']))
    for (const id of AREA_IDS) expect(out.asksAdded).not.toContain(id)
    expect(out.text).toContain('written by the node')
    expect(out.text).not.toContain('Title in-a2')
    expect(out.text).not.toContain('Title in-b')
  })
})

describe('the org report reads one area', () => {
  const letter = (id: string, taskId: string, subject: string): LetterRecord => ({
    id, type: 'action_required', subject, sender: { sessionId: 's', taskId, host: 'local' }, actions: [{ id: 'a', label: 'Go' }],
  }) as unknown as LetterRecord

  it('Main\'s report names no area task, ask or letter; unassigned work stays', () => {
    const done = task('done-a', { router_area_id: 'area-a', phase: 'COMPLETE', status: 'done', completed_at: '2026-11-07T06:00:00.000Z', result_report: { result: 'Secret area result' } as never })
    const letters = [letter('lt-a', 'in-a', 'Area decision subject'), letter('lt-p', 'lead', 'Plain decision subject')]
    const r = buildMorningReport(main, [...ALL, done], letters, SINCE, NOW)
    for (const id of [...AREA_IDS, 'done-a']) {
      expect(r.markdown).not.toContain(`Title ${id}`)
      expect(r.taskRefs).not.toContain(id)
    }
    expect(r.markdown).not.toContain('Area decision subject')
    expect(r.markdown).not.toContain('Secret area result')
    expect(r.markdown).toContain('Title plain')
    expect(r.markdown).toContain('Plain decision subject')
    expect(r.withheld).toBeUndefined()
  })

  it('a letter whose sending task is gone is counted, never quoted; one with no task is listed as before', () => {
    const gone = letter('lt-gone', 'task-no-longer-stored', 'Gone sender decision subject')
    const system = { ...letter('lt-sys', '', 'Walnut system decision subject'), sender: { sessionId: 'external', host: 'local' } } as unknown as LetterRecord
    for (const owner of [main, lead]) {
      const r = buildMorningReport(owner, ALL, [gone, system], SINCE, NOW)
      expect(r.markdown).not.toContain('Gone sender decision subject')
      expect(r.text).not.toContain('Gone sender decision subject')
      expect(r.withheld).toEqual({ decisions: 1 })
    }
    expect(buildMorningReport(main, ALL, [system], SINCE, NOW).markdown).toContain('Walnut system decision subject')
  })
})

// ── Source guard ──────────────────────────────────────────────────────────

const SRC = path.resolve(__dirname, '../../src')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : []
  })
}

/** Readers of a node's team or Main's whole org: a file that builds text from one must scope it. */
const TEAM_READERS: Array<{ name: string; re: RegExp }> = [
  { name: 'briefTeam(', re: /\bbriefTeam\(/ },
  { name: "Main's whole org", re: /!t\.plugin_only && t\.id !== owner\.id/ },
]
const SCOPED = /\bsameTaskArea\(|\bsameAreaTasks\(/

/** Files that read a team for something other than text a model reads, each with why. */
const NOT_TEXT: Record<string, string> = {
  'core/user-status.ts': 'defines briefTeam; the person\'s views read it whole',
  'core/sessions/ask-answer.ts': 'authorization (is the caller above the target), builds no text',
}

/** The automatic text builders this guard covers by name; each must scope by area. */
const BUILDERS = [
  'core/same-ask-tree.ts', 'core/sessions/brief.ts', 'core/sessions/brief-structure.ts', 'core/org/morning-report.ts',
]

describe('source guard: automatic team text is scoped by area', () => {
  const files = walk(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }))

  it('every named builder keeps its tasks to the owner\'s area', () => {
    for (const rel of BUILDERS) {
      const f = files.find((x) => x.rel === rel)
      expect(f, rel).toBeTruthy()
      expect(SCOPED.test(f!.text), `${rel} must filter with sameTaskArea / sameAreaTasks`).toBe(true)
    }
  })

  it('a new file reading a team or the whole org scopes it, or says why it builds no text', () => {
    const offenders: string[] = []
    for (const f of files) {
      if (NOT_TEXT[f.rel] || f.rel === 'core/router/same-area.ts') continue
      const reads = TEAM_READERS.filter((r) => r.re.test(f.text.replace(/export function briefTeam/g, '')))
      if (reads.length && !SCOPED.test(f.text)) offenders.push(`${f.rel} (${reads.map((r) => r.name).join(', ')})`)
    }
    expect(offenders, 'Scope the list with sameAreaTasks (src/core/router/same-area.ts), or list the file in NOT_TEXT with why').toEqual([])
  })

  it('the not-text list names files that still exist, and never a router or report builder', () => {
    for (const rel of Object.keys(NOT_TEXT)) {
      expect(files.some((f) => f.rel === rel), rel).toBe(true)
      // Router processing and reports build text from items: they filter by area, never get excused.
      expect(rel, `${rel} builds automatic text: filter it by area instead`).not.toMatch(/^core\/router\/|report/)
    }
  })
})
