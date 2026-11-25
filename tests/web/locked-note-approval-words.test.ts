/**
 * Approving an agent's ask for a locked note (web/src/components/approvals/approvals-store.ts,
 * docs/reference/locked-notes.md): the master password sheet says what the yes allows, "read and
 * change" for an edit ask and "read" for a read ask, in the words of the card the server writes
 * (src/core/notes/locked-note-ask.ts); and when the sheet cannot open because another one is
 * open, the card says so instead of doing nothing (N8).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const h = vi.hoisted(() => ({
  sheetOpen: false,
  withMasterPassword: vi.fn(async (_sub: string, _work: () => Promise<unknown>) => null as unknown),
}))

vi.mock('@/components/passwords/with-passwords-unlock', () => ({ withMasterPassword: h.withMasterPassword }))
vi.mock('@/plugins/passwords-unlock-store', () => ({ getPasswordsUnlock: () => (h.sheetOpen ? { sequence: 1 } : null) }))
vi.mock('@/api/vault', () => ({ vaultCall: vi.fn() }))
vi.mock('@/api/approvals', () => ({ answerApproval: vi.fn(), listApprovals: vi.fn(), setApprovalsAskMe: vi.fn() }))
vi.mock('../../web/src/components/approvals/approval-notify', () => ({
  clearApprovalNotice: vi.fn(), keepApprovalNotices: vi.fn(), setApprovalOpener: vi.fn(), showApprovalNotice: vi.fn(),
}))
vi.mock('@/api/test-run', () => ({ testRunLabel: () => null }))
vi.mock('@/utils/mac-app', () => ({ inMacApp: () => false }))

const store = await import('../../web/src/components/approvals/approvals-store')
const { SHEET_BUSY_WORDS } = await import('../../web/src/components/passwords/unlock-sheet-busy')

const ask = (what: string) => ({
  id: 'ap-1', what, digest: 'd', mode: 'once', requester: { host: 'local' }, needsPasswords: true,
  createdAt: '2026-11-25T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', status: 'pending',
}) as never

beforeEach(() => {
  store.resetApprovalsForTest()
  h.sheetOpen = false
  h.withMasterPassword.mockClear()
})

describe('approving an ask for a locked note', () => {
  it('the sheet says "read and change" for an edit ask and "read" for a read ask', async () => {
    const edit = store.passwordsSubFor({ what: 'Let the task "Plan" read and change your locked note "Diary"' })
    // Who asks and which note (the card's own words), what a yes allows, for how long, where the text goes.
    expect(edit).toContain('Let the task "Plan" read and change your locked note "Diary". A yes lets the agent read and change it for 30 minutes')
    expect(edit).toContain("goes into that agent's conversation")
    const read = store.passwordsSubFor({ what: 'Let the task "Plan" read your locked note "Diary"' })
    expect(read).toContain('A yes lets the agent read it for 10 minutes')
    expect(read).not.toContain('change')
    // The server writes the card in those words (the asker's what), one per access, and keeps a
    // read open 10 minutes and an edit 30: a change there must change the sheet's line too.
    const server = fs.readFileSync(path.join(__dirname, '../../src/core/notes/locked-note-ask.ts'), 'utf8')
    expect(server).toContain('read and change your locked note')
    expect(server).toContain('read your locked note')
    expect(server).toContain('export const EDIT_MS = 30 * 60_000')
    expect(server).toContain('export const READ_MS = 10 * 60_000')

    await store.decideApproval(ask('Let the task "Plan" read and change your locked note "Diary"'), 'approve')
    expect(h.withMasterPassword.mock.calls[0]![0]).toContain('read and change your locked note')
    // The sheet approves: its own title and an Approve button, not "Passwords are locked" and Unlock.
    expect((h.withMasterPassword.mock.calls[0] as unknown[])[2]).toEqual({ title: 'Approve with your master password', action: 'Approve' })
  })

  it('a sheet that cannot open because another is open says so on the card; a cancel says nothing', async () => {
    await store.decideApproval(ask('Let the task "Plan" read your locked note "Diary"'), 'approve')
    expect(store.approvalsSnapshot().errors['ap-1']).toBeUndefined()

    h.sheetOpen = true
    await store.decideApproval(ask('Let the task "Plan" read your locked note "Diary"'), 'approve')
    expect(store.approvalsSnapshot().errors['ap-1']).toBe(SHEET_BUSY_WORDS)
  })
})
