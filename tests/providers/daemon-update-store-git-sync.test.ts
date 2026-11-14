/**
 * The daemon update state files (src/providers/daemon-update-store.ts: the build day-off and the
 * kept stop record) are machine-local and never reach git-sync. 2026-11-04 review: they lived at
 * the data home's root, so every sync carried them to the cloud companion, where the same key
 * (both daemon dirs are /tmp/open-walnut) held a good build for a day, and two writers made merge
 * conflicts that lost holds.
 *
 * MACHINE SAFETY: WALNUT_HOME is this file's temp data home (createMockConstants); the only git
 * repo is the one initSync makes there, with no remote.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { createMockConstants } from '../helpers/mock-constants.js'
import { removeTempTree } from '../helpers/temp-home.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-update-store-sync-test'))

import { commitIfDirty, initSync, resetSyncGuardForTest } from '../../src/integrations/git-sync.js'
import { updateStoreFile } from '../../src/providers/daemon-update-store.js'
import { WALNUT_HOME } from '../../src/constants.js'

const run = (cmd: string) => execSync(cmd, { cwd: WALNUT_HOME, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

beforeEach(async () => {
  await removeTempTree(WALNUT_HOME)
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  resetSyncGuardForTest()
  initSync()
  run('git config user.email t@t && git config user.name t')
})
afterEach(async () => { await removeTempTree(WALNUT_HOME) })

describe('the daemon update state files and git-sync', () => {
  it('live in the machine-local part of the data home, and no sync commit holds them or their write temps', async () => {
    // machine-id: the stores' key for this machine (2026-11-04 review 4), never another machine's.
    const files = ['daemon-build-backoff.json', 'daemon-update-pending.json', 'daemon-update-unread.json', 'machine-id'].flatMap((name) => {
      const file = updateStoreFile(name)
      return [file, `${file}.tmp-4242`]
    })
    for (const file of files) {
      expect(path.relative(WALNUT_HOME, file).split(path.sep)[0]).toBe('local')
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, '{"mac|local:/tmp/open-walnut":{"expected":"b1","at":1,"reason":""}}\n')
    }
    await fsp.writeFile(path.join(WALNUT_HOME, 'note.md'), 'synced\n')
    await commitIfDirty()
    const tracked = run('git ls-tree -r --name-only HEAD').split('\n')
    expect(tracked).toContain('note.md')
    for (const file of files) {
      const rel = path.relative(WALNUT_HOME, file)
      expect(tracked).not.toContain(rel)
      expect(run(`git check-ignore ${rel}`)).toBe(rel)
    }
    expect(fs.existsSync(path.join(WALNUT_HOME, 'daemon-build-backoff.json'))).toBe(false)
  })
})
