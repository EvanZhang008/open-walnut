/**
 * Reads a real Walnut data home's saved records through the schemas that read them,
 * under the zod Walnut runs now, and fails on any record they no longer take:
 * - human-inbox/index.json: every letter's items, thread items and receipts
 *   (normalizeItems hides an item its schema refuses);
 * - secrets/feature-nodes.json: the paired feature nodes (FeatureNodeStore).
 *
 * Read only: each file is copied into a temp dir first, and nothing is printed but
 * counts. Run on a machine that has data:
 *   WALNUT_LIVE_TEST=1 WALNUT_LIVE_HOME=~/.open-walnut bun --bun vitest run \
 *     --config vitest.live.config.ts tests/core/human-inbox/persisted-items-real-data.live.test.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLiveTest } from '../../helpers/live.js'
import { normalizeItems } from '../../../src/core/human-inbox/item-schema.js'
import { FeatureNodeStore } from '../../../src/core/feature-nodes/node-store.js'

const HOME = process.env.WALNUT_LIVE_HOME || path.join(os.homedir(), '.open-walnut')
const INVALID = /^Invalid saved /

const dirs: string[] = []
// The copies hold real mail and pairing data: never left behind.
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function copied(rel: string): string | null {
  const from = path.join(HOME, rel)
  if (!fs.existsSync(from)) return null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-persisted-'))
  dirs.push(dir)
  const to = path.join(dir, path.basename(rel))
  fs.copyFileSync(from, to)
  fs.chmodSync(to, 0o600)
  return to
}

describe.skipIf(!isLiveTest())('saved records of a real data home read under the current zod', () => {
  it('every saved inbox item and receipt still reads', () => {
    const file = copied(path.join('human-inbox', 'index.json'))
    if (!file) return
    const { letters } = JSON.parse(fs.readFileSync(file, 'utf8')) as { letters: Array<Record<string, any>> }
    const lists = letters.flatMap((l) => [l.items, ...((l.thread ?? []) as Array<Record<string, unknown>>).map((e) => e?.items)]).filter(Array.isArray) as unknown[][]
    let items = 0
    const refused: string[] = []
    for (const raw of lists) {
      const read = normalizeItems(raw) ?? []
      read.forEach((item, i) => {
        items++
        const before = (raw[i] as Record<string, unknown>)?.unavailableReason
        if (item.unavailableReason && INVALID.test(item.unavailableReason) && before !== item.unavailableReason) refused.push(`${item.id}: ${item.unavailableReason}`)
      })
    }
    console.log(`[persisted] ${letters.length} letters, ${items} saved items read`)
    expect(refused).toEqual([])
  })

  it('the paired feature nodes still read', async () => {
    const file = copied(path.join('secrets', 'feature-nodes.json'))
    if (!file) return
    // lookup() loads the whole store through its schema and throws 'unavailable' when it no longer reads.
    await expect(new FeatureNodeStore(file).lookup('no-such-node', 'no-such-account')).resolves.toBeUndefined()
  })
})
