/**
 * The rows "Copies that held off" shows from GET /api/replicas/status
 * (web/src/components/settings/sections/replica-removal-status.ts): a row only
 * for a refusal three rounds in a row or an armed confirm, its sentence naming
 * the size of the removal, and the confirm naming exactly the refusal read.
 */
import { describe, expect, it } from 'vitest'
import { replicaRemovalRows, refusedText, type ReplicasStatusResponse } from '../../web/src/components/settings/sections/replica-removal-status.js'

const refusal = { error: 'manifest_removes_most_rows', at: 1, entries: 3, keys: 'abcdef012345', local: 100, removing: 97 }

function status(): ReplicasStatusResponse {
  return {
    ok: true,
    targets: [
      { id: 'companion', kind: 'companion', label: 'Cloud companion', kinds: [{ kind: 'tasks', refusals: 0, needsConfirm: false }] },
      {
        id: 'host:marina', kind: 'host', label: 'marina', kinds: [
          { kind: 'tasks', refusals: 3, needsConfirm: true, lastRefusal: refusal },
          { kind: 'registry', refusals: 0, needsConfirm: false },
          { kind: 'search', refusals: 0, needsConfirm: false },
        ],
      },
      { id: 'host:acme', kind: 'host', label: 'acme', kinds: [{ kind: 'tasks', refusals: 2, needsConfirm: false, lastRefusal: refusal }] },
    ],
  }
}

describe('the rows of copies that held off', () => {
  it('a copy that works, or one refused fewer than three times, has no row', () => {
    const rows = replicaRemovalRows(status())
    expect(rows.map((r) => r.id)).toEqual(['host:marina/tasks'])
  })

  it('a refusal says how many rows would go, and its confirm names the count and keys read', () => {
    const [row] = replicaRemovalRows(status())
    expect(row).toMatchObject({ state: 'refused', label: 'marina', confirm: { target: 'host:marina', kind: 'tasks', entries: 3, keys: 'abcdef012345' } })
    expect(row.text).toBe('This Mac has 3 tasks now, and the copy there would drop 97 of its 100. Walnut held off in case this Mac lost them. If you removed them on purpose, remove them there too.')
  })

  it('an older copy that does not say its size still gets the row', () => {
    expect(refusedText('tasks', { error: 'manifest_removes_most_rows', at: 1, entries: 3 })).toMatch(/^This Mac has 3 tasks now, far fewer than the copy there\./)
  })

  it('an armed confirm says the next copy takes it and when it lapses; no button', () => {
    const s = status()
    const expiresAt = new Date(2026, 9, 14, 9, 5).getTime()
    s.targets[1].kinds[0] = { kind: 'tasks', refusals: 3, needsConfirm: false, lastRefusal: refusal, confirmArmed: { entries: 3, keys: 'abcdef012345', at: 1, expiresAt } }
    const [row] = replicaRemovalRows(s)
    expect(row.state).toBe('armed')
    expect(row.confirm).toBeUndefined()
    expect(row.text).toBe('Confirmed: the next copy keeps only this Mac\'s 3 tasks there. The confirmation lapses if they change first, and at 09:05 at the latest.')
  })

  it('each section shows its own followers: hosts in Remote Hosts, the companion in Cloud', () => {
    const s = status()
    s.targets[0].kinds[0] = { kind: 'tasks', refusals: 3, needsConfirm: true, lastRefusal: refusal }
    expect(replicaRemovalRows(s, 'host').map((r) => r.id)).toEqual(['host:marina/tasks'])
    expect(replicaRemovalRows(s, 'companion').map((r) => r.id)).toEqual(['companion/tasks'])
    expect(replicaRemovalRows(null)).toEqual([])
  })

  it('a refusal with no key set (nothing to bind a confirm to) offers no confirm', () => {
    const s = status()
    s.targets[1].kinds[0] = { kind: 'tasks', refusals: 3, needsConfirm: true, lastRefusal: { ...refusal, keys: undefined } }
    expect(replicaRemovalRows(s)).toEqual([])
  })
})
