/**
 * Unit test: session_list's `scope` argument and the "where you stand" ladder it
 * renders (src/ops/core.ts mapResult).
 *
 * The defect this pins is a words defect. An agent that could not find the
 * session it should talk to used its harness's built-in cross-session messaging
 * instead, because nothing in the answer told it (a) which row is itself,
 * (b) which rows are near it, or (c) how to widen the search. So the result text
 * is tested like the feature it is: the place, the ring, and the escalation.
 */
import { describe, it, expect } from 'vitest'
import { listOps } from '../../../src/ops/index.js'

const op = () => listOps().find((o) => o.name === 'session_list')!

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

  it('never invites narrowing when the caller has no place to narrow from', () => {
    const r = mapped({ scope: 'all', sessions: [row({ id: 'eeee1111' })] })
    expect(r.next).not.toContain('scope=')
    expect(r.next).toContain('session_send')
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
})
