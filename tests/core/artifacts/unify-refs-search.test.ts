/**
 * The move re-points the search index's note docs (src/core/artifacts/unify/refs.ts rewriteSearch)
 * by one pass and the table's own key. 2026-11-20: an UPDATE ... WHERE ref=? per moved file had no
 * index to use (UNIQUE(kind, ref)), scanned the whole table each time, and held the server's thread
 * for 110 s on 13,000 notes. 20,000 docs and 10,000 moves must take well under a few seconds.
 */
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-unify-refs-search'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { openSearchDb } from '../../../src/lib/hybrid-search/db.js'
import { searchV2IndexPath } from '../../../src/core/search/wiring.js'
import { rewriteNoteRefs } from '../../../src/core/artifacts/unify/refs.js'

describe('rewriteSearch', () => {
  it('moves only the docs of moved notes, fast on a big index', async () => {
    const notes = path.join(WALNUT_HOME, 'notes'); const tree = path.join(WALNUT_HOME, 'artifacts')
    const { db } = openSearchDb({ dbPath: searchV2IndexPath() } as Parameters<typeof openSearchDb>[0]) as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): { ref: string } | undefined }; transaction(f: () => void): () => void; close(): void } }
    const ins = db.prepare('INSERT INTO doc (kind, ref, title, summary, note, meta, updated_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    db.transaction(() => {
      for (let i = 0; i < 20_000; i++) ins.run('note', path.join(notes, `cove/n${i}.md`), `n${i}`, '', '', '', i, `h${i}`)
      ins.run('task', path.join(notes, 'cove/n1.md'), 'a task doc with the same ref', '', '', '', 1, 't')
      ins.run('note', path.join(WALNUT_HOME, 'elsewhere/x.md'), 'x', '', '', '', 1, 'x')
    })()
    db.close()
    const pairs: Array<[string, string]> = Array.from({ length: 10_000 }, (_, i) => [`cove/n${i}.md`, `projects/Cove/notes/n${i}.md`])
    const t0 = Date.now()
    const report = await rewriteNoteRefs({ pairs, fromRoot: notes, toRoot: tree, remap: (r) => r, config: (l) => l })
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(report.search).toBe(10_001)
    const { db: after } = openSearchDb({ dbPath: searchV2IndexPath() } as Parameters<typeof openSearchDb>[0]) as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown }; close(): void } }
    const ref = (title: string) => (after.prepare('SELECT ref FROM doc WHERE title=?').get(title) as { ref: string }).ref
    expect(ref('n5')).toBe(path.join(tree, 'projects/Cove/notes/n5.md'))
    expect(ref('n15000')).toBe(path.join(notes, 'cove/n15000.md'))
    expect(ref('x')).toBe(path.join(WALNUT_HOME, 'elsewhere/x.md'))
    after.close()
  }, 60_000)
})
