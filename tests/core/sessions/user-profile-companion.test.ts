/**
 * On the cloud companion, USER.md is the Mac's copy (companion-memory.ts), not the box's
 * disk, which git sync no longer writes: the session context reads the copy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-user-profile-companion'))
const role = vi.hoisted(() => ({ kind: 'companion' as 'companion' | null, throws: false, doc: null as null | { content: string; contentHash: string; updatedAt: string } }))
vi.mock('../../../src/core/server-role.js', async (orig) => ({ ...(await orig<object>()), followerKind: () => role.kind }))
vi.mock('../../../src/core/companion-memory.js', async (orig) => ({ ...(await orig<object>()), companionMemoryDoc: () => { if (role.throws) throw new Error('copy unreadable'); return role.doc } }))
import { WALNUT_HOME, USER_FILE } from '../../../src/constants.js'
import { refreshUserProfile } from '../../../src/core/sessions/user-profile-context.js'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(USER_FILE), { recursive: true })
  // A stale file git sync once wrote on the box.
  await fs.writeFile(USER_FILE, '## Old\n\nA rule the user removed long ago.\n')
})

describe('the companion', () => {
  it('reads the Mac\'s copy of USER.md, never its own disk', async () => {
    role.kind = 'companion'
    role.doc = { content: '## Standing rules\n\n- Reply in short sentences.\n', contentHash: 'h1', updatedAt: '2026-10-28T08:00:00.000Z' }
    const p = await refreshUserProfile()
    expect(p.text).toBe('## Standing rules\n\n- Reply in short sentences.')
    expect(p.savedAt).toBe('2026-10-28T08:00:00.000Z')
    // A save on the copy is read at once.
    role.doc = { content: '## Standing rules\n\n- Reply in full sentences.\n', contentHash: 'h2', updatedAt: '2026-10-28T09:00:00.000Z' }
    expect((await refreshUserProfile()).text).toContain('full sentences')
    // A copy that cannot be read keeps the last one, never the stale disk.
    role.throws = true
    expect((await refreshUserProfile()).text).toContain('full sentences')
    role.throws = false
    // No copy held: nothing, not the stale disk.
    role.doc = null
    expect(await refreshUserProfile()).toEqual({ text: '', savedAt: '', exists: false })
    // The Mac itself reads its disk.
    role.kind = null
    expect((await refreshUserProfile()).text).toContain('A rule the user removed long ago.')
  })
})
