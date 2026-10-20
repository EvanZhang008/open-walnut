/**
 * Importing the sync reconciler writes nothing into WALNUT_HOME; its dir is made
 * on the first save.
 *
 * The module builds its singleton at import, and the constructor used to make
 * `sync/`. A host replica's boot gives its data dir owner-only modes only when it
 * finds that dir empty (src/replica/boot-guard.ts claimReplicaDir), so a dir
 * written into at import was left 0755 under a 022 umask (CI run 39381410474,
 * tests/replica/leader-door.test.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('sync-reconciler-no-import-writes'))

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js'
import { SyncReconciler, syncReconciler } from '../../src/core/sync-reconciler.js'

describe('sync reconciler and the data dir', () => {
  it('leaves the data dir empty at import and on construction', () => {
    expect(syncReconciler).toBeInstanceOf(SyncReconciler)
    new SyncReconciler()
    expect(fs.readdirSync(WALNUT_HOME)).toEqual([])
  })

  it('makes its dir when it first saves a state', () => {
    const r = new SyncReconciler() as unknown as { saveState(id: string, s: Record<string, unknown>): void }
    r.saveState('acme-sync', { lastFullPullCount: 0 })
    expect(fs.readdirSync(SYNC_DIR)).toEqual(['reconcile-acme-sync.json'])
    fs.rmSync(WALNUT_HOME, { recursive: true, force: true })
  })
})
