/**
 * Locked-note edits that no open editor holds (web/src/components/notes/locked-note-saves.ts,
 * docs/reference/locked-notes.md): they are saved without the master password sheet and only
 * while the window has a Passwords unlock (W5), a panel's save on its way is written here first
 * and kept when it fails after the panel went (W4), one that merges is saved merged and one that
 * cannot waits for Show without being sent again (W1), a rename moves it and a delete drops it
 * (W3, W8), and a reload asks first while any waits (W5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const h = vi.hoisted(() => {
  class VaultApiError extends Error {
    constructor(public status: number, message: string, public code?: string) { super(message) }
  }
  const sessionListeners = new Set<() => void>()
  const held: Array<() => unknown> = []
  return {
    VaultApiError,
    session: null as string | null,
    sessionListeners,
    held,
    save: vi.fn(),
    read: vi.fn(),
  }
})

vi.mock('@/api/vault', () => ({
  VaultApiError: h.VaultApiError,
  isLockedError: (e: unknown) => e instanceof h.VaultApiError && e.status === 401,
  onVaultSessionChange: (fn: () => void) => { h.sessionListeners.add(fn); return () => h.sessionListeners.delete(fn) },
  vaultSession: () => h.session,
}))
vi.mock('@/api/locked-notes', () => ({ lockedNotesApi: { save: h.save, read: h.read } }))
vi.mock('@/utils/unsaved-work', () => ({ holdUnsavedWork: (read: () => unknown) => { h.held.push(read); return () => {} } }))

const saves = await import('../../web/src/components/notes/locked-note-saves')

const BASE = '# Week\n\nMonday: one.\n\nTuesday: two.\n'
const edit = (text: string, base = BASE, hash = 'h0') => ({ text, base, hash })
const unlock = () => { h.session = 'tok'; for (const fn of [...h.sessionListeners]) fn() }
const heldNow = () => h.held.map((read) => read()).filter(Boolean)
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  saves.resetLockedNoteSavesForTest()
  h.session = null
  h.save.mockReset()
  h.read.mockReset()
  h.save.mockImplementation(async () => ({ contentHash: 'h1', updatedAt: 'now', path: 'n.md' }))
})

describe('locked-note edits no editor holds', () => {
  it('never opens the master password sheet: saved only while the window has an unlock, and when one comes back', async () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/components/notes/locked-note-saves.ts'), 'utf8')
    expect(src).not.toMatch(/withPasswordsUnlock|askPasswordsUnlock|withMasterPassword/)

    saves.keepUnsavedEdit('n.md', edit(`${BASE}More.\n`))
    await settle()
    expect(h.save).not.toHaveBeenCalled()
    // A reload or a restart would lose it: they ask first.
    expect(heldNow()).toEqual([expect.objectContaining({ lostOn: 'both' })])

    unlock()
    await settle()
    expect(h.save).toHaveBeenCalledWith('n.md', `${BASE}More.\n`, 'h0')
    expect(saves.takeUnsavedEdit('n.md')).toBeNull()
    expect(heldNow()).toEqual([])
  })

  it('a panel save is written first: kept when it fails after the panel went, dropped when the panel still holds it', async () => {
    const owner = Symbol('panel')
    h.session = 'tok'
    // Still open: a failed save stays in the panel's editor, so nothing is kept here.
    const open = saves.holdSending('n.md', edit(`${BASE}A.\n`), owner)
    expect(saves.takeUnsavedEdit('n.md')).toBeNull() // the open panel's own save
    saves.settleSending(open, false)
    expect(saves.takeUnsavedEdit('n.md')).toBeNull()

    // The panel went while its save was on its way, and the save failed: kept and tried again.
    h.save.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const gone = saves.holdSending('n.md', edit(`${BASE}B.\n`), owner)
    saves.releaseSending(owner)
    saves.settleSending(gone, false)
    await settle()
    expect(h.save).toHaveBeenCalledTimes(1)
    expect(saves.takeUnsavedEdit('n.md')).toEqual(edit(`${BASE}B.\n`))

    // Saved: gone from here.
    const ok = saves.holdSending('n.md', edit(`${BASE}C.\n`), owner)
    saves.settleSending(ok, true)
    expect(saves.takeUnsavedEdit('n.md')).toBeNull()
  })

  it('merges with a newer save; one that cannot merge waits for Show and is not sent again', async () => {
    h.session = 'tok'
    const theirs = BASE.replace('Tuesday: two.', 'Tuesday: two, then tea.')
    h.save.mockRejectedValueOnce(new h.VaultApiError(409, 'changed', 'conflict'))
    h.read.mockResolvedValueOnce({ content: theirs, contentHash: 'h2', updatedAt: 'now', path: 'n.md' })
    saves.keepUnsavedEdit('n.md', edit(BASE.replace('Monday: one.', 'Monday: one, and a walk.')))
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(2))
    expect(h.save.mock.calls[1]).toEqual(['n.md', theirs.replace('Monday: one.', 'Monday: one, and a walk.'), 'h2'])
    await settle()
    expect(saves.takeUnsavedEdit('n.md')).toBeNull()

    // The same line changed on both sides: kept, flagged, and left alone until Show takes it.
    h.save.mockReset()
    h.save.mockRejectedValueOnce(new h.VaultApiError(409, 'changed', 'conflict'))
    h.read.mockResolvedValueOnce({ content: BASE.replace('Monday: one.', 'Monday: theirs.'), contentHash: 'h3', updatedAt: 'now', path: 'n.md' })
    const mine = edit(BASE.replace('Monday: one.', 'Monday: mine.'))
    saves.keepUnsavedEdit('n.md', mine)
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2))
    await settle()
    unlock()
    await settle()
    expect(h.save).toHaveBeenCalledTimes(1)
    expect(saves.takeUnsavedEdit('n.md')).toEqual(mine)
  })

  it('a rename moves the waiting edit and tells open panels; a delete drops it', () => {
    const changes: Array<{ from: boolean; to: string | null }> = []
    saves.onLockedNotePathChange((c) => changes.push({ from: c.match('F/a.md'), to: c.to }))
    saves.keepUnsavedEdit('F/a.md', edit(`${BASE}X.\n`))
    saves.moveUnsavedEdits('F/a.md', 'F/b.md')
    expect(saves.takeUnsavedEdit('F/a.md')).toBeNull()
    expect(changes).toEqual([{ from: true, to: 'F/b.md' }])

    saves.dropUnsavedEdits((p) => p.startsWith('F/'))
    expect(saves.takeUnsavedEdit('F/b.md')).toBeNull()
    expect(changes[1]).toEqual({ from: true, to: null })
    expect(heldNow()).toEqual([])
  })
})
