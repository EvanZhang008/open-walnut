/**
 * A drawing's walkthroughs (src/core/drawings/narration.ts, narration-align.ts): the take a client
 * sends is checked and trimmed, each sentence is matched to the elements it was about, and the AI
 * reads a coarse overview (one line per part) and, when it asks, one part in detail.
 *
 * The example is the design's: a system sketch where the person says "this table is the core
 * table" (in Chinese, as test data) while resting the pointer on `orders` and selecting it.
 */
import { describe, expect, it } from 'vitest'
import { cleanTake, narrationPathFor, parseNarrationFile, sceneLabels, type NarrationTake } from '../../../src/core/drawings/narration.js'
import { alignTake, clock, narrationDetail, narrationOverview, OVERVIEW_PARTS_MAX, partsOf } from '../../../src/core/drawings/narration-align.js'
import { DrawingInputError } from '../../../src/core/drawings/scene.js'

// "First draw a gateway, every request comes in here" / "this table is the core table, every order is written here first"
// / "the key is id, user is who ordered" / "this is only a cache, losing it is fine" / "order_items follows orders"
const SAID = {
  gateway: '\u5148\u753b\u4e00\u4e2a\u7f51\u5173\uff0c\u6240\u6709\u8bf7\u6c42\u4ece\u8fd9\u91cc\u8fdb\u6765',
  core: '\u8fd9\u5f20\u8868\u662f\u6838\u5fc3\u8868\uff0c\u6240\u6709\u8ba2\u5355\u90fd\u5148\u5199\u5230\u8fd9\u91cc',
  key: '\u4e3b\u952e\u662f id\uff0cuser \u662f\u4e0b\u5355\u7684\u4eba',
  cache: '\u8fd9\u4e2a\u53ea\u662f\u7f13\u5b58\uff0c\u4e22\u4e86\u4e5f\u6ca1\u5173\u7cfb',
  items: 'order_items \u8ddf\u7740 orders \u8d70',
}
const GATEWAY = 'API \u7f51\u5173'
const REDIS = 'Redis \u7f13\u5b58'

function exampleTake(): NarrationTake {
  return cleanTake({
    id: 'take-1', startedAt: '2026-11-20T00:12:03.000Z', durationMs: 72_000,
    speech: [
      { t0: 4_100, t1: 7_000, text: SAID.gateway, recordingId: 'rec-1' },
      { t0: 38_600, t1: 41_200, text: SAID.core },
      { t0: 47_000, t1: 52_000, text: SAID.key },
      { t0: 55_000, t1: 59_000, text: SAID.cache },
      { t0: 62_000, t1: 66_000, text: SAID.items },
    ],
    events: [
      { t: 2_100, kind: 'add', ids: ['gw'], labels: [GATEWAY] },
      { t: 20_100, kind: 'add', ids: ['orders'], labels: ['orders'] },
      { t: 27_000, kind: 'add', ids: ['items'], labels: ['order_items'] },
      { t: 33_200, kind: 'add', ids: ['redis'], labels: [REDIS] },
      { t: 38_200, kind: 'point', ids: ['orders'], labels: ['orders'], untilT: 51_000 },
      { t: 39_000, kind: 'select', ids: ['orders'], labels: ['orders'] },
      { t: 53_000, kind: 'select', ids: [], labels: [] },
      { t: 54_800, kind: 'point', ids: ['redis'], labels: [REDIS], untilT: 59_500 },
    ],
  })
}

const LABELS = new Map([['gw', GATEWAY], ['orders', 'orders'], ['items', 'order_items'], ['redis', REDIS]])

describe('cleanTake', () => {
  it('keeps a well-formed take, sorted by time', () => {
    const take = cleanTake({ id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 10_000,
      speech: [{ t0: 5_000, t1: 6_000, text: ' b ' }, { t0: 1_000, t1: 2_000, text: 'a' }],
      events: [{ t: 3_000, kind: 'edit', ids: ['x'], labels: ['X'] }, { t: 1_000, kind: 'add', ids: ['x'] }] })
    expect(take.speech.map((s) => s.text)).toEqual(['a', 'b'])
    expect(take.events.map((e) => e.kind)).toEqual(['add', 'edit'])
    expect(take.events[0].labels).toEqual([''])
    expect(take.startedAt).toBe('2026-11-20T00:00:00.000Z')
  })

  it('refuses what is not a take, each with a reason', () => {
    const ok = { id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 1000, speech: [], events: [] }
    const bad: Array<[unknown, RegExp]> = [
      [null, /object/],
      [{ ...ok, id: '../x' }, /take id/],
      [{ ...ok, startedAt: 'yesterday' }, /startedAt/],
      [{ ...ok, durationMs: -1 }, /durationMs/],
      [{ ...ok, speech: 'hi' }, /speech/],
      [{ ...ok, speech: [{ t0: 'a', t1: 1 }] }, /sentence start/],
      [{ ...ok, events: [{ t: 1, kind: 'dance', ids: [] }] }, /event kind/],
      [{ ...ok, events: [{ t: 1, kind: 'add', ids: [42] }] }, /element id/],
      [{ ...ok, speech: Array.from({ length: 3_001 }, () => ({ t0: 0, t1: 1, text: '' })) }, /at most 3000/],
    ]
    for (const [raw, why] of bad) {
      expect(() => cleanTake(raw), JSON.stringify(raw)?.slice(0, 60)).toThrow(DrawingInputError)
      expect(() => cleanTake(raw)).toThrow(why)
    }
  })

  it('clamps times past the end and trims long text', () => {
    const take = cleanTake({ id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 1_000,
      speech: [{ t0: 900, t1: 999_999, text: 'x'.repeat(5_000) }], events: [] })
    expect(take.speech[0].t1).toBe(61_000)
    expect(take.speech[0].text).toHaveLength(2_000)
  })
})

describe('the file', () => {
  it('sits beside its scene', () => {
    expect(narrationPathFor('Projects/A/Shop.excalidraw')).toBe('Projects/A/Shop.narration.json')
    expect(narrationPathFor('inbox/x.EXCALIDRAW')).toBe('inbox/x.narration.json')
  })

  it('reads what this version wrote, skips a take it cannot read, and refuses what is not ours', () => {
    const file = parseNarrationFile(JSON.stringify({ version: 1, scene: 'a.excalidraw', takes: [exampleTake(), { id: 42 }] }))
    expect(file?.takes).toHaveLength(1)
    expect(parseNarrationFile('{nope')).toBeNull()
    expect(parseNarrationFile(JSON.stringify({ takes: [] }))).toBeNull()
  })

  it('labels a shape by the text inside it, and a frame by its name', () => {
    const labels = sceneLabels([
      { id: 'box', type: 'rectangle' },
      { id: 'box-t', type: 'text', text: 'orders\nid, user', containerId: 'box' },
      { id: 'free', type: 'text', text: '  ', originalText: 'note' },
      { id: 'fr', type: 'frame', name: 'Storage' },
      { id: 'gone', type: 'text', text: 'old', isDeleted: true },
    ])
    expect(Object.fromEntries(labels)).toEqual({ box: 'orders', free: 'note', fr: 'Storage' })
  })
})

describe('aligning sentences with elements', () => {
  it('matches "this table is the core table" to the table the pointer rested on and was selected', () => {
    const [, core, key, cache, items] = alignTake(exampleTake(), LABELS)
    expect(core.about[0].id).toBe('orders')
    expect(core.about[0].why).toEqual(['pointer on it from 0:38.2', 'selected from 0:39.0'])
    expect(key.about[0].id).toBe('orders')
    expect(cache.about[0].id).toBe('redis')
    // Named in the words: both tables, each standing alone ("orders" is not inside "order_items").
    expect(items.about.map((m) => m.id).sort()).toEqual(['items', 'orders'])
    expect(items.about.every((m) => m.why.includes('named in the words'))).toBe(true)
  })

  it('takes a shape drawn just before the sentence as what "this" means', () => {
    const [gateway] = alignTake(exampleTake(), LABELS)
    expect(gateway.about).toEqual([expect.objectContaining({ id: 'gw', label: GATEWAY, score: 1, why: ['drawn at 0:02.1'] })])
  })

  it('gives the sentence to the element the pointer moved to, not the one it just left', () => {
    const take = cleanTake({ id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 30_000,
      speech: [{ t0: 10_000, t1: 14_000, text: 'this one is only a cache' }],
      events: [
        { t: 2_000, kind: 'point', ids: ['orders'], untilT: 9_000 },
        { t: 2_500, kind: 'select', ids: ['orders'] },
        { t: 10_500, kind: 'select', ids: [] },
        { t: 9_100, kind: 'point', ids: ['redis'], untilT: 15_000 },
      ] })
    const [s] = alignTake(take, new Map())
    expect(s.about.map((m) => m.id)).toEqual(['redis', 'orders'])
  })

  it('the pointer on the cache beats the table still selected from before', () => {
    const take = cleanTake({ id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 12_000,
      speech: [{ t0: 300, t1: 2_500, text: 'core table' }, { t0: 6_600, t1: 8_900, text: 'only a cache' }],
      events: [
        { t: 800, kind: 'point', ids: ['orders'], untilT: 5_700 },
        { t: 1_000, kind: 'select', ids: ['orders'] },
        { t: 6_000, kind: 'point', ids: ['redis'], untilT: 11_400 },
      ] })
    const [core, cache] = alignTake(take, new Map())
    expect(core.about[0].id).toBe('orders')
    expect(cache.about.map((m) => m.id)).toEqual(['redis', 'orders'])
  })

  it('does not take a short word for a name, a selection left from long ago, or tenths past 59.9', () => {
    const take = cleanTake({ id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 90_000,
      speech: [{ t0: 60_000, t1: 62_000, text: 'is it ok to keep the DB here' }],
      events: [{ t: 1_000, kind: 'select', ids: ['old'] }] })
    const labels = new Map([['is', 'is'], ['ok', 'Ok'], ['db', 'DB'], ['old', 'old one']])
    expect(alignTake(take, labels)[0].about.map((m) => m.id)).toEqual(['db'])
    expect(clock(59_960, true)).toBe('1:00.0')
    expect(clock(61_040, true)).toBe('1:01.0')
    expect(clock(59_999)).toBe('0:59')
  })

  it('ignores a large selection and an element the pointer left long before', () => {
    const take = cleanTake({ id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 30_000,
      speech: [{ t0: 20_000, t1: 22_000, text: 'hello' }],
      events: [
        { t: 1_000, kind: 'point', ids: ['a'], untilT: 2_000 },
        { t: 19_000, kind: 'select', ids: ['a', 'b', 'c', 'd', 'e', 'f'] },
      ] })
    expect(alignTake(take, new Map())[0].about).toEqual([])
  })

  it('uses the label an event carried for an element since removed', () => {
    const take = cleanTake({ id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 10_000,
      speech: [{ t0: 2_000, t1: 3_000, text: 'drop the queue' }],
      events: [{ t: 1_000, kind: 'point', ids: ['q'], labels: ['queue'], untilT: 2_500 }] })
    const [s] = alignTake(take, new Map())
    // The pointer covered 60% of the sentence (with its lead), and the words named it.
    expect(s.about[0]).toMatchObject({ id: 'q', label: 'queue', score: 5.2 })
  })
})

describe('the overview (coarse) and the detail (fine)', () => {
  it('folds a run of sentences about one element into one part', () => {
    const parts = partsOf(alignTake(exampleTake(), LABELS))
    expect(parts.map((p) => [clock(p.t0), clock(p.t1), p.about[0]?.id ?? null, p.sentences.length])).toEqual([
      ['0:04', '0:07', 'gw', 1],
      ['0:38', '0:52', 'orders', 2],
      ['0:55', '0:59', 'redis', 1],
      ['1:02', '1:06', 'items', 1],
    ])
  })

  it('gives the AI one line per part, not a line per second', () => {
    const text = narrationOverview([exampleTake()], LABELS)
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^Walkthroughs \(1\).*walnut_drawing_narration \{path, take, part\}/)
    expect(lines[1]).toBe('take 1 \u00b7 2026-11-20 00:12 UTC \u00b7 1:12 \u00b7 5 sentences in 4 parts')
    expect(lines[3]).toBe(`  part 2  0:38-0:52  orders (orders): "${SAID.core} ${SAID.key}" (2 sentences)`)
    expect(lines).toHaveLength(6)
    expect(lines[5]).toBe(`  part 4  1:02-1:06  order_items (items), orders (orders): "${SAID.items}"`)
    // The parts carry no step-by-step evidence: that is the detail's.
    expect(lines.slice(1).join('\n')).not.toMatch(/pointer|selected/)
  })

  it('lists each sentence and every step of one part when asked', () => {
    const detail = narrationDetail([exampleTake()], LABELS, { take: 1, part: 2 })!
    expect(detail.split('\n')).toEqual([
      'take 1, part 2 (0:38-0:52)',
      `0:38.6-0:41.2 "${SAID.core}"`,
      '    about: orders (orders): pointer on it from 0:38.2; selected from 0:39.0',
      `0:47.0-0:52.0 "${SAID.key}"`,
      '    about: orders (orders): pointer on it from 0:38.2; selected from 0:39.0',
      'events',
      '  0:38.2 pointer on orders (orders) until 0:51.0',
      '  0:39.0 selected orders (orders)',
    ])
    expect(narrationDetail([exampleTake()], LABELS, { take: 1, part: 9 })).toBeNull()
    expect(narrationDetail([exampleTake()], LABELS, { take: 2 })).toBeNull()
    expect(narrationDetail([exampleTake()], LABELS, { from: 54, to: 60 })).toContain('pointer on Redis')
  })

  it('numbers takes by when they were recorded, and keeps a long take to OVERVIEW_PARTS_MAX lines', () => {
    const later = { ...exampleTake(), id: 'take-2', startedAt: '2026-11-21T00:00:00.000Z' }
    expect(narrationOverview([later, exampleTake()], LABELS)).toMatch(/take 1 \u00b7 2026-11-20[\s\S]*take 2 \u00b7 2026-11-21/)
    const long = cleanTake({ id: 'long', startedAt: '2026-11-20T00:00:00Z', durationMs: 3_600_000,
      speech: Array.from({ length: 60 }, (_, i) => ({ t0: i * 30_000, t1: i * 30_000 + 2_000, text: `s${i}` })), events: [] })
    const lines = narrationOverview([long], new Map()).split('\n')
    expect(lines.filter((l) => l.startsWith('  part '))).toHaveLength(OVERVIEW_PARTS_MAX)
    expect(lines.at(-1)).toMatch(/20 more parts/)
  })

  it('says when a sentence could not be transcribed', () => {
    const take = cleanTake({ id: 't', startedAt: '2026-11-20T00:00:00Z', durationMs: 5_000, speech: [{ t0: 0, t1: 1_000, text: '', failed: true }], events: [] })
    expect(narrationOverview([take], new Map())).toContain('(not transcribed)')
    expect(narrationOverview([], new Map())).toBe('')
  })
})
