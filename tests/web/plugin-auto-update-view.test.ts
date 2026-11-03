import { describe, expect, it } from 'vitest'
import { autoUpdateNote, supportsAutoUpdate, updatedLine } from '../../web/src/components/settings/plugin-auto-update-view'
import { successFeedback } from '../../web/src/components/settings/plugin-update-view'

const A = 'a'.repeat(40)
const B = 'b19f8307c018a546af0c891fe9cfbc8b68ebb57d'
const C = 'c'.repeat(40)
const now = Date.parse('2026-11-03T02:00:00Z')

describe('automatic update words', () => {
  it('names the commit and when it landed, and says when it was by itself', () => {
    const source = { autoUpdate: true, auto: { lastUpdate: { from: A, to: B, at: '2026-11-03T01:55:00Z', by: 'auto' as const } } }
    expect(updatedLine(source, now)).toBe('Updated to b19f830 5 min ago, by itself')
    expect(updatedLine({ ...source, auto: { lastUpdate: { ...source.auto.lastUpdate, by: 'manual' as const } } }, now)).toBe('Updated to b19f830 5 min ago')
    expect(updatedLine({ autoUpdate: true }, now)).toBeUndefined()
  })

  it('offers the switch only where the server knows it (an older server sends no autoUpdate)', () => {
    expect(supportsAutoUpdate({ autoUpdate: true })).toBe(true)
    expect(supportsAutoUpdate({ autoUpdate: false })).toBe(true)
    expect(supportsAutoUpdate({})).toBe(false)
    expect(supportsAutoUpdate(undefined)).toBe(false)
  })

  it('says why it did not update a clone with changes or commits of its own', () => {
    const dirty = autoUpdateNote({ autoUpdate: true, auto: { skipped: { reason: 'dirty', at: '2026-11-03T01:00:00Z', behind: 50, ahead: 0 } } })
    expect(dirty).toMatchObject({ tone: 'warn', title: 'Not updated automatically' })
    expect(dirty!.text).toBe('Its folder has changes of its own, and Walnut never overwrites them. It is 50 commits behind. Undo them, or turn automatic updates off while you work in it.')
    const diverged = autoUpdateNote({ autoUpdate: true, auto: { skipped: { reason: 'diverged', at: '2026-11-03T01:00:00Z', behind: 1, ahead: 2 } } })
    expect(diverged!.text).toBe('Its folder has 2 commits the source does not have, and Walnut never drops them. It is 1 commit behind. Push or remove them, or turn automatic updates off while you work in it.')
  })

  it('says what a rollback undid while it is the latest news, and nothing once a later update landed', () => {
    const rolledBack = { sha: C, to: B, at: '2026-11-03T01:00:00Z', error: 'Plugin update failed; previous versions restored: demo threw at activate', by: 'auto' as const }
    const note = autoUpdateNote({ autoUpdate: true, auto: { rolledBack, lastUpdate: { to: B, at: '2026-11-02T01:00:00Z', by: 'auto' } } })
    expect(note).toMatchObject({ tone: 'warn', title: 'Went back to b19f830' })
    expect(note!.text).toMatch(/^ccccccc did not load \(.+demo threw at activate\), so Walnut put back the version that ran\. It will not pull ccccccc again by itself/)
    expect(autoUpdateNote({ autoUpdate: true, auto: { rolledBack, lastUpdate: { to: C, at: '2026-11-03T01:30:00Z', by: 'auto' } } })).toBeNull()
  })

  it('has nothing to explain when the switch is off or nothing happened', () => {
    expect(autoUpdateNote({ autoUpdate: false, auto: { skipped: { reason: 'dirty', at: '2026-11-03T01:00:00Z' } } })).toBeNull()
    expect(autoUpdateNote({ autoUpdate: true })).toBeNull()
  })

  it('an Update press that rolled back says so instead of "Updated to"', () => {
    const feedback = successFeedback('git', {
      updated: true, fromSha: B, toSha: C, reloaded: [], failed: [{ id: 'demo', error: 'boom' }],
      rolledBack: { sha: C, to: B, error: 'boom' },
    }, () => 'Demo')
    expect(feedback).toEqual({ kind: 'error', text: 'Demo did not load at ccccccc · went back to b19f830, which still runs', detail: 'boom' })
  })
})
