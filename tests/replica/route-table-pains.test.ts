/**
 * A reflecting node's pain registry and guard run live in the leader's node memory folder, which no
 * host replica copies (src/replica/route-table.ts). Read on a replica while the Mac is away they
 * answered "missing" with no entries, a 200 that looks real (2026-11-24: the daily guard run read
 * it and wrote an empty run over the last real one). Every GET the pains router mounts, read from
 * its source so a new one is covered too, must need the leader.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify } from '../../src/replica/route-table.js'

const SOURCE = path.resolve(__dirname, '../../src/web/routes/org-pains-v1.ts')

describe('the pain registry reads need the leader on a replica', () => {
  const routes = [...fs.readFileSync(SOURCE, 'utf-8').matchAll(/orgPainsV1Router\.get\('([^']+)'/g)].map((m) => m[1]!)

  it('reads every GET route of the pains router from its source', () => {
    expect(routes).toEqual(expect.arrayContaining(['/org/nodes/:id/pains', '/org/nodes/:id/pains-tests']))
  })

  it('each one answers needs_leader while away, never the empty copy', () => {
    for (const r of routes) {
      const p = `/api/v1${r.replace(':id', 'mvm0aaaa-0001')}`
      expect([p, classify('GET', p)]).toMatchObject([p, { cls: 'leader', away: 'needs-leader', why: 'pains_need_leader' }])
    }
  })
})
