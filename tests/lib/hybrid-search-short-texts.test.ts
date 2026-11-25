/**
 * SearchIndex.embedShortTexts (a caller's own short texts, Walnut's related threads) uses only
 * workers that already run, never one started for it: each worker is a full model copy (about
 * 2 GB), and the backfill releases its passage worker after a pass (review 2026-11-25: a send path
 * forked one on nearly every message that opened a thread). The fake worker
 * (fixtures/fake-embed-worker.cjs) answers at once.
 */
import { describe, expect, it } from 'vitest'
import { createSearchIndex } from '../../src/lib/hybrid-search/index.js'

const FAKE_WORKER = new URL('./fixtures/fake-embed-worker.cjs', import.meta.url).pathname
const KINDS = { task: { weight: 1.0 } }

describe('embedShortTexts uses running workers only', () => {
  it('with no worker running it starts none: no query vector, passages refused', async () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS, embedder: { modelId: 'fake/unit-x', dims: 4, workerPath: FAKE_WORKER } })
    try {
      expect(index.embedShortTexts.running()).toEqual({ query: false, passage: false })
      expect(await index.embedShortTexts.query('orchard fence', 2_000)).toBeNull()
      await expect(index.embedShortTexts.passages(['orchard fence'])).rejects.toThrow(/no passage worker running/)
      // Nothing was forked by those calls.
      expect(index.embedShortTexts.running()).toEqual({ query: false, passage: false })
    } finally {
      await index.stopEmbedder()
      index.close()
    }
  })

  it('a running query worker answers, and a running passage worker embeds', async () => {
    const index = createSearchIndex({ dbPath: ':memory:', kinds: KINDS, embedder: { modelId: 'fake/unit-x', dims: 4, workerPath: FAKE_WORKER } })
    try {
      expect(await index.warmQueryWorker(15_000)).toBe(true)
      expect(index.embedShortTexts.running()).toEqual({ query: true, passage: false })
      expect((await index.embedShortTexts.query('orchard fence', 5_000))?.length).toBe(4)
      await expect(index.embedShortTexts.passages(['orchard fence'])).rejects.toThrow()
      // A backfill pass starts the passage worker; while it runs, short passages ride it.
      index.upsert({ kind: 'task', ref: 't1', title: 'Orchard fence posts', updatedAt: 1 })
      await index.backfillVectors()
      expect(index.embedShortTexts.running().passage).toBe(true)
      const vecs = await index.embedShortTexts.passages(['orchard fence', 'spring seeds'])
      expect(vecs.map((v) => v.length)).toEqual([4, 4])
    } finally {
      await index.stopEmbedder()
      index.close()
    }
  })
})
