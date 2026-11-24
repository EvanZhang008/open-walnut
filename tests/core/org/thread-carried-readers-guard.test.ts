/**
 * Guard: every view that lists a node's threads of tasks below it also lists the results it carries
 * (2026-11-24, the threads inspection, item 4: a result on a task below never reached the lead where
 * he had asked; src/core/org/thread-subject-pairs.ts, thread-popup.ts carriedRows). The lead's own
 * card waits behind such a result in every read (threads-store.ts nodeView), so a view that listed
 * the threads below without the carried ones would show neither: his result would vanish there.
 *
 * Fails when a new reader of the threads below (poppedThreadsFor, or poppedIndex's byViewer) appears
 * in src/ without carriedRows beside it, or when a reader of the node's own threads for his counts
 * stops reading them through nodeView.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = path.resolve(__dirname, '../../../src')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Code only: comments name these functions too. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const READS_BELOW = /\bpoppedThreadsFor\(|\.byViewer\.get\(/

describe('every reader of the threads below a node lists the results it carries', () => {
  const files = sources(SRC).filter((f) => !f.endsWith(path.join('core', 'org', 'thread-popup.ts')))
  const readers = files.filter((f) => READS_BELOW.test(code(fs.readFileSync(f, 'utf8'))))

  it('finds the readers (the route and the status counts at least)', () => {
    const names = readers.map((f) => path.relative(SRC, f)).sort()
    expect(names).toEqual(expect.arrayContaining([path.join('core', 'user-status-sync.ts'), path.join('web', 'routes', 'org-threads-v1.ts')]))
  })

  it('each lists carriedRows beside them, from nodeView of the same node', () => {
    for (const f of readers) {
      const text = code(fs.readFileSync(f, 'utf8'))
      expect(text, `${path.relative(SRC, f)} lists threads below without the results it carries (carriedRows)`).toMatch(/\bcarriedRows\(/)
      expect(text, `${path.relative(SRC, f)} reads the node's own threads without nodeView (its carried results)`).toMatch(/\bnodeView\b/)
    }
  })
})
