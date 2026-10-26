/**
 * The search status never reads the vector table.
 *
 * getSearchIndexStatus() serves GET /api/search-index/status (polled by every
 * open window's notification pane) and used to call stats(), whose
 * COUNT(*) over doc_vec reads every vector page: 115 MB on a real index, 2.8 s
 * cold, and 3.3 s / 6.0 s event-loop stalls in production (2026-10-23/24). The
 * same count ran at every server start to ask "is the index empty". Both now
 * read the doc table's kind index alone.
 */
import { afterEach, describe, expect, it } from 'vitest'

describe('search status reads no vector pages', () => {
  afterEach(async () => {
    const { resetSearchV2IndexForTests } = await import('../../src/core/search/wiring.js')
    resetSearchV2IndexForTests()
  })

  it('status, the backfill flag and the emptiness check prepare no doc_vec statement', async () => {
    const wiring = await import('../../src/core/search/wiring.js')
    wiring.resetSearchV2IndexForTests()
    const index = wiring.getSearchV2Index()
    // The test home is shared by the files of one run, so counts are relative.
    const before = index.docCounts()
    index.upsert({ kind: 'task', ref: `status-scan-${Date.now()}`, title: 'first task', updatedAt: 1 })
    index.upsert({ kind: 'note', ref: `/status-scan-${Date.now()}.md`, title: 'a note', updatedAt: 2 })

    const sql: string[] = []
    const prepare = index.db.prepare.bind(index.db)
    index.db.prepare = ((source: string) => { sql.push(source); return prepare(source) }) as typeof index.db.prepare
    try {
      const status = wiring.getSearchIndexStatus()
      expect(status.docs).toBe(before.docs + 2)
      expect(status.byKind.task).toBe((before.byKind.task ?? 0) + 1)
      expect(status.byKind.note).toBe((before.byKind.note ?? 0) + 1)
      expect(wiring.searchIndexBackfillRunning()).toBe(false)
      expect(index.hasDocs()).toBe(true)
    } finally {
      index.db.prepare = prepare
    }
    expect(sql.length).toBeGreaterThan(0)
    expect(sql.filter((s) => /doc_vec/.test(s))).toEqual([])
  })
})
