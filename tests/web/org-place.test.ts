/** Where the Org page was (web/src/components/org/org-place.ts), pure part. */
import { describe, it, expect } from 'vitest'
import { placeParams } from '../../web/src/components/org/org-place.js'
import { syncable } from '../../web/src/utils/ui-prefs-sync.js'

describe('org place', () => {
  it('a bare /org takes on the pick, its tab and the task beside it', () => {
    expect(placeParams({ node: 'project:garden', tab: 'team', open: 'task:t-1', listTop: 80 })).toEqual({ node: 'project:garden', tab: 'team', open: 'task:t-1' })
    expect(placeParams({ node: 'main' })).toEqual({ node: 'main' })
    // A tab means nothing without its node; nothing saved, nothing to restore.
    expect(placeParams({ tab: 'team' })).toBeNull()
    expect(placeParams({})).toBeNull()
  })

  it('stays on this device: ui-prefs never mirrors it', () => {
    expect(syncable('walnut.org.place')).toBe(false)
  })
})
