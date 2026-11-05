/**
 * One spec at a time drives the fixture server's approvals (`/api/v1/approvals`).
 *
 * The list of waiting approvals is one list the whole server shares: the corner shows the first
 * one, and a spec that clears what is waiting before and after each test (so no other file's card
 * takes its corner) denies whatever another file is waiting on at that moment. 2026-11-05, the push
 * gate: notice-full-text's afterEach denied approvals.spec's Face ID request 0.8 s after it was
 * made, on the next worker, and the card it waited for never showed. Every spec that makes,
 * answers or clears approvals calls `holdApprovalsLock()` once at its top level, before its own
 * hooks; tests/web/approvals-lock-guard.test.ts fails on one that does not.
 */
import { test, type APIRequestContext } from '@playwright/test'
import { specLock } from './spec-lock'

const lock = specLock('approvals')

/** Deny every approval waiting on the fixture server. Only ever called while the lock is held. */
async function denyAllWaiting(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/v1/approvals')
  if (!res.ok()) return
  const { approvals } = await res.json() as { approvals: { id: string }[] }
  for (const a of approvals) await request.post(`/api/v1/approvals/${a.id}/answer`, { data: { decision: 'deny' } })
}

/**
 * Hold the fixture's approvals for this file (serial) or for each test (any other file). With
 * `clear`, each test starts and ends with none waiting (a request another file or an earlier run
 * left would take the corner), and the clearing runs inside the lock, never beside another file.
 */
export function holdApprovalsLock(scope: 'file' | 'test', opts: { clear?: boolean } = {}): void {
  if (scope === 'file') {
    lock.hold('file')
    if (opts.clear) {
      test.beforeEach(async ({ request }) => { await denyAllWaiting(request) })
      test.afterEach(async ({ request }) => { await denyAllWaiting(request) })
    }
    return
  }
  test.beforeEach(async ({ request }) => {
    await lock.acquire()
    if (opts.clear) await denyAllWaiting(request)
  })
  test.afterEach(async ({ request }) => {
    try { if (opts.clear) await denyAllWaiting(request) } finally { lock.release() }
  })
}
