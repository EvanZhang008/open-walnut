/**
 * The new SSH hosts typed and not saved yet outlive the pane (web/src/components/settings/
 * sections/ssh-draft-store.ts; 2026-11-04 review: a hostname typed with no alias was dropped
 * without a word when the person opened another pane and came back). Kept: a new row someone
 * typed in, and one refused for an alias another host has (it is not that host). Not kept: an
 * untouched row, one config.yaml has under its alias with its hostname (saved), one cancelled.
 */
import { describe, expect, it } from 'vitest'
import { draftsToKeep, readSshDrafts, SSH_DRAFTS_KEY, writeSshDrafts } from '../../web/src/components/settings/sections/ssh-draft-store'
import { emptyHost, type HostEntry } from '../../web/src/components/settings/sections/remote-hosts-model'

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, m }
}

const draft = (over: Partial<HostEntry>): HostEntry => ({ ...emptyHost(), ...over })

describe('SSH drafts across leaving the pane', () => {
  it('keeps a typed draft, and gives it back as a new row with its fields', () => {
    const s = memory()
    const typed = draft({ hostname: 'build7.example.com', alias: 'build7', aliasAuto: true, user: 'sam' })
    writeSshDrafts([typed, draft({})], new Map(), s)
    const back = readSshDrafts(new Map(), s)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ hostname: 'build7.example.com', alias: 'build7', user: 'sam', aliasAuto: true })
    expect(back[0].savedAlias).toBeUndefined()
    // A fresh key: never the key of a row on screen.
    expect(back[0]._key).not.toBe(typed._key)
  })

  it('a hostname with no alias is kept too (the half-filled draft that was dropped)', () => {
    const s = memory()
    writeSshDrafts([draft({ hostname: 'half.example.com' })], new Map(), s)
    expect(readSshDrafts(new Map(), s).map((h) => h.hostname)).toEqual(['half.example.com'])
  })

  it('a draft that saved, or was cancelled, is no longer kept', () => {
    const s = memory()
    const typed = draft({ hostname: 'build7.example.com', alias: 'build7' })
    writeSshDrafts([typed], new Map(), s)
    // Saved: config.yaml has build7 with this hostname.
    writeSshDrafts([typed], new Map([['build7', 'build7.example.com']]), s)
    expect(s.m.has(SSH_DRAFTS_KEY)).toBe(false)
    writeSshDrafts([typed], new Map(), s)
    // Cancelled: the row is gone from the list.
    writeSshDrafts([], new Map(), s)
    expect(readSshDrafts(new Map(), s)).toEqual([])
    // Saved meanwhile in another tab: read back, it is left out.
    writeSshDrafts([typed], new Map(), s)
    expect(readSshDrafts(new Map([['build7', 'build7.example.com']]), s)).toEqual([])
  })

  it('a draft refused for an alias another host has is kept: it is not that host', () => {
    const saved = new Map([['devbox', 'devbox.example.com']])
    const dup = draft({ hostname: 'other.example.com', alias: 'devbox' })
    expect(draftsToKeep([dup], saved)).toHaveLength(1)
  })

  it('a broken or blocked store keeps nothing and breaks nothing', () => {
    const s = memory()
    s.setItem(SSH_DRAFTS_KEY, '{not json')
    expect(readSshDrafts(new Map(), s)).toEqual([])
    s.setItem(SSH_DRAFTS_KEY, JSON.stringify([{ hostname: 3 }, null, 'x']))
    expect(readSshDrafts(new Map(), s)).toEqual([])
    const full = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
    expect(() => writeSshDrafts([draft({ hostname: 'h' })], new Map(), full)).not.toThrow()
    expect(readSshDrafts(new Map(), null)).toEqual([])
  })
})
