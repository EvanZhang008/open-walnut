/**
 * Unit test: the LEGACY session_* ops stay callable and keep their words
 * (src/ops/core.ts session_list mapResult + the registry's deprecation rule).
 *
 * Two things are pinned here:
 *
 * 1. Deprecation is a CATALOGUE decision, not a removal. `listOps()` hides every
 *    session_* op so a model reads one way to do each thing (task_list /
 *    task_start / task_send / task_history), while `getOp()` still resolves the
 *    old names — a session running older instructions must not hit "unknown op".
 *    So the lookup here uses getOp, exactly like a real legacy call does.
 *
 * 2. session_list's `scope` answer. The defect it pins is a words defect: an
 *    agent that could not find the session it should talk to used its harness's
 *    built-in cross-session messaging instead, because nothing in the answer told
 *    it (a) which row is itself, (b) which rows are near it, or (c) how to widen
 *    the search. So the result text is tested like the feature it is: the place,
 *    the ring, and the escalation.
 */
import { describe, it, expect } from 'vitest'
import { getOp, listOps } from '../../../src/ops/index.js'

const op = () => getOp('session_list')!

/** Every session_* name that survives only for compatibility, and its replacement. */
const LEGACY: Array<{ name: string; replacement: string }> = [
  { name: 'session_list', replacement: 'task_list' },
  { name: 'session_start', replacement: 'task_start' },
  { name: 'session_send', replacement: 'task_send' },
  { name: 'session_transcript', replacement: 'task_history' },
]

/** The projected-row shape the route answers with (only the fields used here). */
function row(over: Record<string, unknown>): Record<string, unknown> {
  return { process_status: 'idle', ...over }
}

const YOU = row({
  id: 'aaaa1111-2222-3333', title: 'Refactor the fixture', project: 'marina',
  group_id: 'g_auth', group_label: 'Auth cleanup',
})

function mapped(body: Record<string, unknown>): {
  sessions: Array<Record<string, unknown>>
  you?: Record<string, unknown>
  outcome: string
  next: string
} {
  return op().mapResult!({ body, args: {} }) as never
}

describe('the legacy session_* ops are hidden, not gone', () => {
  it('the default catalogue advertises no session_* op', () => {
    // One name per job: a model reading the catalogue must not find two ways to
    // start work and guess which one is current.
    expect(listOps().filter((o) => o.name.startsWith('session_')).map((o) => o.name)).toEqual([])
  })

  it('getOp still resolves every old name, and each names its replacement', () => {
    for (const { name, replacement } of LEGACY) {
      const legacy = getOp(name)
      expect(legacy, name).toBeTruthy()
      expect(legacy?.deprecated, name).toBeTruthy()
      // The note is what a caller reads after using the old name: it must say
      // which op to use instead, by name.
      expect(legacy?.deprecated, name).toContain(replacement)
    }
  })

  it('includeDeprecated lists them, as a superset of the default catalogue', () => {
    const all = listOps({ includeDeprecated: true }).map((o) => o.name)
    const visible = listOps().map((o) => o.name)
    for (const { name } of LEGACY) {
      expect(all, name).toContain(name)
      expect(visible, name).not.toContain(name)
    }
    for (const name of visible) expect(all).toContain(name)
    expect(all.length).toBe(visible.length + LEGACY.length)
  })

  it('each legacy op still executes and still shapes its result', () => {
    for (const { name } of LEGACY) {
      const legacy = getOp(name)!
      expect(!!legacy.bind || !!legacy.handler, `${name} must still be executable`).toBe(true)
      expect(!!legacy.handler || !!legacy.mapResult, `${name} must still shape its result`).toBe(true)
    }
  })
})

describe('session_list takes a scope', () => {
  it('declares folder | project | all and teaches which one to start with', () => {
    const scope = op().input.scope
    expect(scope).toBeTruthy()
    const described = scope?.description ?? ''
    expect(described).toContain('folder')
    expect(described).toContain('project')
    expect(described).toContain('all (default)')
    // The op description must name the two things the caller needs to know.
    expect(op().description).toContain('scope')
    expect(op().description).toContain('you')
  })

  it('rejects a scope word the route does not accept', () => {
    const scope = op().input.scope!
    expect(scope.safeParse('folder').success).toBe(true)
    expect(scope.safeParse('host').success).toBe(false)
  })
})

describe('session_list result: where you stand', () => {
  it('names the caller, its project and its folder, and keeps the base lesson', () => {
    const r = mapped({
      scope: 'all',
      you: YOU,
      sessions: [YOU, row({ id: 'bbbb1111', title: 'Far away', project: 'acme', process_status: 'running' })],
    })
    expect(r.outcome).toContain('You are Refactor the fixture [aaaa1111]')
    expect(r.outcome).toContain('in project marina')
    expect(r.outcome).toContain('folder Auth cleanup')
    // The pre-existing lesson survives the new sentence.
    expect(r.outcome).toContain('2 session(s) listed, 1 of them working')
    expect(r.outcome).toContain('live process doing work')
    // `you` comes back with its own handle, so the caller can recognise itself
    // in the rows without re-deriving anything.
    expect(r.you?.handle).toBe('Refactor the fixture [aaaa1111]')
  })

  it('says the Inbox rather than an empty project name, and omits a folder it has none of', () => {
    const r = mapped({ scope: 'all', you: row({ id: 'cccc1111', title: 'Loose' }), sessions: [] })
    expect(r.outcome).toContain('in the Inbox')
    expect(r.outcome).not.toMatch(/, folder /)
  })

  it('says nothing about a place when the server could not place the caller', () => {
    const r = mapped({ scope: 'all', sessions: [row({ id: 'dddd1111' })] })
    expect(r.outcome).not.toContain('You are')
    expect(r.you).toBeUndefined()
    // Unplaced callers still get the base lesson, unchanged.
    expect(r.outcome).toContain('1 session(s) listed, 0 of them working')
  })

  it('an empty answer says zero of zero rather than reading as a failure', () => {
    const r = mapped({ scope: 'all', sessions: [] })
    expect(r.outcome).toContain('0 session(s) listed, 0 of them working')
    expect(r.sessions).toEqual([])
  })

  it('rows carry the printed handle session_send accepts back', () => {
    const r = mapped({
      scope: 'all',
      sessions: [
        row({ id: '9f3a2c1d-4b7e-4c1a-9d2e-0f1a2b3c4d5e', title: 'Fix auth fixture' }),
        row({ id: 'bbbb1111-2222-3333' }),
        row({}),
      ],
    })
    expect(r.sessions[0].handle).toBe('Fix auth fixture [9f3a2c1d]')
    // No title → the bare id handle; no id at all → no handle invented.
    expect(r.sessions[1].handle).toBe('[bbbb1111]')
    expect(r.sessions[2].handle).toBeUndefined()
    // The rest of the row is passed through untouched.
    expect(r.sessions[0].title).toBe('Fix auth fixture')
  })

  it('falls back to the owning task title when the session has none', () => {
    // A row with no session title still has to read as a name, because the id
    // half is what actually routes.
    const r = mapped({ scope: 'all', sessions: [row({ id: 'eeee1111-2222', task_title: 'Fix the flaky auth test' })] })
    expect(r.sessions[0].handle).toBe('Fix the flaky auth test [eeee1111]')
  })
})

describe('session_list result: the escalation ladder', () => {
  it('a folder answer offers project, then all', () => {
    const r = mapped({ scope: 'folder', you: YOU, sessions: [YOU] })
    expect(r.outcome).toContain('This is your folder only')
    expect(r.next).toContain('scope="project"')
    expect(r.next).toContain('scope="all"')
    expect(r.next).toContain('session_send')
  })

  it('a project answer offers all, and nothing narrower', () => {
    const r = mapped({ scope: 'project', you: YOU, sessions: [YOU] })
    expect(r.outcome).toContain('This is your project only')
    expect(r.next).toContain('scope="all"')
    expect(r.next).not.toContain('scope="project"')
  })

  it('the widest answer offers the narrow ring instead of a widening', () => {
    const r = mapped({ scope: 'all', you: YOU, sessions: [YOU] })
    expect(r.next).toContain('scope="folder"')
    expect(r.next).not.toContain('Widen')
  })

  it('follows the scope the SERVER applied, not the one that was asked for', () => {
    // The route may answer a folder request as a project one (a caller with no
    // folder). The ladder has to describe what came back, or the next rung
    // repeats a scope that was already tried.
    const r = mapped({ scope: 'project', you: row({ id: 'cccc1111', title: 'Loose', project: 'marina' }), sessions: [] })
    expect(r.outcome).toContain('This is your project only')
    expect(r.outcome).not.toContain('folder only')
    expect(r.next).toContain('scope="all"')
  })

  it('an answer with no scope word reads as the widest ring', () => {
    // An older server sends no scope at all; the default must be the wide answer,
    // never a claim that this is only the caller's folder.
    const r = mapped({ you: YOU, sessions: [YOU] })
    expect(r.outcome).not.toMatch(/This is your (folder|project) only/)
    expect(r.next).toContain('scope="folder"')
  })

  it('never invites narrowing when the caller has no place to narrow from', () => {
    const r = mapped({ scope: 'all', sessions: [row({ id: 'eeee1111' })] })
    expect(r.next).not.toContain('scope=')
    expect(r.next).toContain('session_send')
  })

  it('still offers the widening ladder to an unplaced caller inside a narrow ring', () => {
    // Widening does not need a place: the server already narrowed the answer, so
    // the escape hatch has to be printed either way.
    const r = mapped({ scope: 'folder', sessions: [] })
    expect(r.outcome).toContain('This is your folder only')
    expect(r.next).toContain('scope="project"')
    expect(r.next).toContain('scope="all"')
  })
})

describe('session_list result: nearest rows first', () => {
  const near = row({ id: 'n0001111', title: 'Same folder', project: 'marina', group_id: 'g_auth' })
  const nearer = row({ id: 'n0002222', title: 'Same folder too', project: 'marina', group_id: 'g_auth' })
  const project = row({ id: 'p0001111', title: 'Same project', project: 'marina' })
  const far = row({ id: 'f0001111', title: 'Elsewhere', project: 'acme' })
  const otherFolder = row({ id: 'o0001111', title: 'Other folder', project: 'acme', group_id: 'g_other' })

  it('orders same folder, then same project, then the rest', () => {
    const r = mapped({ scope: 'all', you: YOU, sessions: [far, project, otherFolder, near] })
    expect(r.sessions.map((s) => s.id)).toEqual(['n0001111', 'p0001111', 'f0001111', 'o0001111'])
  })

  it('keeps the server order inside a ring (recency survives the sort)', () => {
    const r = mapped({ scope: 'all', you: YOU, sessions: [nearer, near, project] })
    expect(r.sessions.map((s) => s.id)).toEqual(['n0002222', 'n0001111', 'p0001111'])
  })

  it('leaves the order exactly as the server sent it when nobody was placed', () => {
    const r = mapped({ scope: 'all', sessions: [far, near, project] })
    expect(r.sessions.map((s) => s.id)).toEqual(['f0001111', 'n0001111', 'p0001111'])
  })

  it('a folder-less caller ranks by project, never by a missing folder id', () => {
    // Both `you` and a row lacking group_id would compare '' === '' and every
    // row would land in the nearest ring, which is a lie about proximity.
    const you = row({ id: 'cccc1111', title: 'Loose', project: 'marina' })
    const r = mapped({ scope: 'all', you, sessions: [far, project, near] })
    expect(r.sessions.map((s) => s.id)).toEqual(['p0001111', 'n0001111', 'f0001111'])
  })

  it('matches a project ring case-insensitively', () => {
    // Project names are compared case-insensitively everywhere else (task_list
    // filters), so a differently-cased row is the SAME project, not "elsewhere".
    const cased = row({ id: 'p0002222', title: 'Same project, other case', project: 'Marina' })
    const r = mapped({ scope: 'all', you: row({ id: 'cccc1111', title: 'Loose', project: 'marina' }), sessions: [far, cased] })
    expect(r.sessions.map((s) => s.id)).toEqual(['p0002222', 'f0001111'])
  })
})
