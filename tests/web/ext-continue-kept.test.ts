/**
 * The Continue rows the side panel and the popup keep for their next open
 * (web/src/popout/ext-continue-kept.ts): shown while the board loads, so the view never trades the
 * extension's drawing of those rows for a "Loading your asks…" line (review R2-6).
 */
import { describe, expect, it } from 'vitest'
import { KEPT_ASKS_MAX, KEPT_ASKS_MAX_AGE_MS, keepAsks, keptAsks } from '../../web/src/popout/ext-continue-kept'

const mem = () => {
  const data = new Map<string, string>()
  return { data, s: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } } }
}
const row = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, title, task: { id, title, project: 'Ask Walnut', walnut_agent: true, ...extra } as never })

describe('the Continue rows kept for the next open', () => {
  it('keeps each row as drawn (title, its session), by agent, cut to what a surface shows', () => {
    const { s } = mem()
    const rows = Array.from({ length: KEPT_ASKS_MAX + 3 }, (_, i) => row(`t${i}`, `Ask ${i}`, i === 0 ? { session_id: 'sess-0', last_session_update: '2026-11-06T10:00:00.000Z' } : {}))
    keepAsks('general', rows, s, 1000)
    const kept = keptAsks('general', s, 2000)
    expect(kept).toHaveLength(KEPT_ASKS_MAX)
    expect(kept[0]).toMatchObject({ id: 't0', title: 'Ask 0', sessionId: 'sess-0', needs: false })
    expect(keptAsks('mentor', s, 2000)).toEqual([])
  })

  it('a week old, or unreadable, is nothing to show', () => {
    const { data, s } = mem()
    keepAsks('general', [row('t1', 'One')], s, 0)
    expect(keptAsks('general', s, KEPT_ASKS_MAX_AGE_MS + 1)).toEqual([])
    data.set('walnut.ext-panel.continue', '{nope')
    expect(keptAsks('general', s, 1)).toEqual([])
  })
})
