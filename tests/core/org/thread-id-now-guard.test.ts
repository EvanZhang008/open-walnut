/**
 * The id of a thread that was merged into another still names that thread, at every way in that
 * takes a thread id from a node or a person (src/core/org/threads-model.ts threadIdNow).
 *
 * 2026-11-27, real use: a thread handed to a task was merged into the task's own thread there. The
 * task kept the id it had been told, and five of its card lines in a day were refused as naming no
 * thread of its own, so the card stopped moving. One fix at one way in would leave the next one
 * open, so this guard lists the ways in from the source and fails when a new one appears unlisted.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** The body of a function declared in a file: from its `function <name>(` to the next top-level declaration. */
function bodyOf(file: string, fn: string): string {
  const src = read(file)
  const at = src.indexOf(`function ${fn}(`)
  expect(at, `${fn} in ${file}`).toBeGreaterThan(-1)
  const next = src.slice(at + 1).search(/\n(?:export |async |function |const |\/\*\*)/)
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next)
}

describe('a merged thread\'s id names the thread it is under, at every way in', () => {
  it('every thread route reads its :thread through threadNowOf, and merge_into through mergeIntoNow', () => {
    const src = read('src/web/routes/org-threads-v1.ts')
    const routes = src.split(/\norgThreadsV1Router\./).slice(1).filter((r) => /^\w+\('[^']*:thread/.test(r))
    expect(routes.length).toBeGreaterThanOrEqual(5)
    for (const r of routes) {
      const name = r.slice(0, r.indexOf('\n'))
      expect(r, name).toContain('threadNowOf(req, ')
      // The id as the URL wrote it is never the route's id.
      expect(r, name).not.toMatch(/const id = threadIdOf\(req\)/)
    }
    const merges = src.match(/const mergeInto = .*/g) ?? []
    expect(merges.length).toBeGreaterThanOrEqual(2)
    for (const m of merges) expect(m).toContain('await mergeIntoNow(')
  })

  // Each reader of a reply's card lines, and what it does with them.
  const CARD_READERS: Record<string, 'writes threads'> = {
    'src/core/org/reply-card.ts': 'writes threads',
    'src/core/org/reply-card-stop.ts': 'writes threads',
  }

  it('every reader of a reply\'s card lines is listed, and reads them through cardsNow', () => {
    const readers = [...tsFiles('src'), ...tsFiles('web/src')]
      .filter((f) => f !== 'src/lib/card-tag.ts' && read(f).includes('readCardTags('))
      .sort()
    expect(readers).toEqual(Object.keys(CARD_READERS).sort())
    for (const f of readers) expect(read(f), f).toContain('cardsNow(')
  })

  // The functions a thread id from outside reaches below the routes.
  const DOORS: Array<[file: string, fn: string]> = [
    ['src/core/org/threads-store.ts', 'fileThreadMessage'],
    ['src/core/org/thread-follow.ts', 'handOffThread'],
    ['src/core/org/thread-handoff.ts', 'sameIdLineBeforeSend'],
    ['src/core/org/thread-tree-merge.ts', 'mergeAcrossTree'],
    ['src/core/org/reply-card-decision.ts', 'cardsNowRead'],
    // The status question's lines and marks (its ids come from its own list, seconds old).
    ['src/core/sessions/status-threads.ts', 'applyThreadLines'],
  ]

  it.each(DOORS)('%s %s reads the id through threadIdNow', (file, fn) => {
    expect(bodyOf(file, fn)).toMatch(/threadIdNow\(|linesNow\(/)
  })

  it('both kinds of line are made one per thread by the one resolver', () => {
    expect(bodyOf('src/core/org/reply-card-decision.ts', 'cardsNowRead')).toContain('linesNow(')
    expect(bodyOf('src/core/org/reply-card-decision.ts', 'cardsNow')).toContain('cardsNowRead(')
    expect(bodyOf('src/core/sessions/status-threads.ts', 'applyThreadLines')).toContain('linesNow(')
  })

  // Every file that reads a thread id from a request or an op's arguments, and the door it hands
  // it to (a string the file must hold). A new file that takes one is listed here with its door.
  const TAKES_AN_ID: Record<string, string> = {
    'src/web/routes/org-threads-v1.ts': 'threadNowOf(req, ',
    'src/web/routes/messages-v1.ts': 'handOffThread(',
    'src/web/routes/task-v1.ts': 'handOffThread(',
    'src/web/routes/api-v1.ts': 'handOffThread(',
    // His chat message that names a thread is filed through fileThreadMessage (session send path).
    'src/web/routes/session-chat.ts': 'threadId',
    'src/web/routes/session-send-v1.ts': 'threadId',
    // The ops call the thread routes above.
    'src/ops/org-threads.ts': '/threads/${encodeURIComponent(threadId)}',
  }

  it('every route or op file that takes a thread id is listed with the door it goes through', () => {
    const takes = /str\(b, 'thread'\)|str\(b\.thread\)|str\('thread'\)|body\??\.threadId|data\.threadId|\bthreadArg\b|'merge_into'/
    const found = [...tsFiles('src/web'), ...tsFiles('src/ops')]
      // A Board's own threads are another object (board-v1.ts).
      .filter((f) => f !== 'src/web/routes/board-v1.ts' && takes.test(read(f)))
      .sort()
    expect(found).toEqual(Object.keys(TAKES_AN_ID).sort())
    for (const [f, door] of Object.entries(TAKES_AN_ID)) expect(read(f), f).toContain(door)
  })
})
