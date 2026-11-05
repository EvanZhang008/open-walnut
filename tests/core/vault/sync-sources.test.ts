/**
 * Sync sources (src/core/vault/sources/index.ts): the vault core knows only this list, and a source
 * counts as added only when the person added it (or turned its daily sync on before the list existed).
 */
import { describe, expect, it } from 'vitest'
import { SYNC_SOURCES, sourceAdded } from '../../../src/core/vault/sources/index.js'

describe('sync sources', () => {
  it('Bitwarden is listed as a source', () => {
    expect(SYNC_SOURCES.map((s) => s.id)).toEqual(['bitwarden'])
  })

  it('counts as added only by the person', () => {
    expect(sourceAdded(undefined, 'bitwarden')).toBe(false)
    expect(sourceAdded({}, 'bitwarden')).toBe(false)
    expect(sourceAdded({ sources: ['bitwarden'] }, 'bitwarden')).toBe(true)
    expect(sourceAdded({ sources: [] }, 'bitwarden')).toBe(false)
    // A config written before the list: the daily switch on means the person added it.
    expect(sourceAdded({ bitwarden_daily: true }, 'bitwarden')).toBe(true)
    expect(sourceAdded({ bitwarden_daily: false }, 'bitwarden')).toBe(false)
    expect(sourceAdded({ sources: 'bitwarden' }, 'bitwarden')).toBe(false)
    // A config from before the list: a past sync counts as added; once the list exists it decides.
    expect(sourceAdded({}, 'bitwarden', true)).toBe(true)
    expect(sourceAdded({ sources: [], bitwarden_daily: true }, 'bitwarden', true)).toBe(false)
  })
})
