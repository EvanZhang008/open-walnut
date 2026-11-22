/**
 * The read-back both trial starts share (src/core/trial-start/read-back.ts): which note it
 * picks in each notes layout, and that a task or note that does not come back as the files hold
 * it is named.
 */
import { describe, expect, it } from 'vitest'
import { pickReadBackNote, readBackThroughServer, type TrialApi } from '../../../src/core/trial-start/read-back.js'

describe('pickReadBackNote', () => {
  it('before the one tree: the first note under notes/, its path under the notes route without the folder', () => {
    expect(pickReadBackNote(['tasks/tasks.sqlite', 'notes/b.md', 'notes/a/x.md', 'artifacts/notes/y.md', 'notes/.hidden/z.md']))
      .toEqual({ rel: 'notes/a/x.md', apiPath: 'a/x.md' })
  })

  it('in the one tree (its marker is in the list): the vault root is artifacts/', () => {
    expect(pickReadBackNote(['artifacts/.unified.json', 'notes/old.md', 'artifacts/projects/p/notes/n.md']))
      .toEqual({ rel: 'artifacts/projects/p/notes/n.md', apiPath: 'projects/p/notes/n.md' })
  })

  it('no note: null', () => {
    expect(pickReadBackNote(['tasks/tasks.sqlite', 'artifacts/notes/x.md'])).toBeNull()
  })
})

describe('readBackThroughServer', () => {
  const server = (answers: Record<string, { status: number; json: unknown }>): TrialApi & { asked: string[] } => {
    const asked: string[] = []
    const api = (async (_m: 'GET', p: string) => { asked.push(p); return answers[p] ?? { status: 404, json: null } }) as TrialApi & { asked: string[] }
    api.asked = asked
    return api
  }
  const want = {
    task: { id: 't 1', title: 'Plan the garden 花园' },
    note: { rel: 'notes/g/花.md', apiPath: 'g/花.md', content: '# Garden\n' },
  }

  it('both as the files hold them: read, no problem; ids and paths are escaped', async () => {
    const api = server({
      '/api/tasks/t%201': { status: 200, json: { task: { title: want.task.title } } },
      [`/api/notes-v2/content/g/${encodeURIComponent('花.md')}`]: { status: 200, json: { content: '# Garden\n' } },
    })
    const r = await readBackThroughServer(api, want)
    expect(r.problems).toEqual([])
    expect(r.read).toHaveLength(2)
  })

  it('another title, other content, a failing route: each named', async () => {
    const api = server({
      '/api/tasks/t%201': { status: 200, json: { task: { title: 'Something else' } } },
      [`/api/notes-v2/content/g/${encodeURIComponent('花.md')}`]: { status: 200, json: { content: '# Changed\n' } },
    })
    const r = await readBackThroughServer(api, want)
    expect(r.problems).toEqual([
      expect.stringMatching(/^task t 1 did not read back \(status 200, title "Something else"\)/),
      expect.stringMatching(/^note notes\/g\/.+ did not read back .*other content/),
    ])
    const down = await readBackThroughServer(async () => { throw new Error('ECONNREFUSED') }, want)
    expect(down.problems).toHaveLength(2)
    expect(down.problems[0]).toMatch(/status 0/)
  })
})
