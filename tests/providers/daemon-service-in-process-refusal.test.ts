/**
 * `walnut service install` and the handover it asks for refuse while a Walnut server runs the
 * session daemon inside its own process for the dir (review S7, 2026-11-21).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// `walnut service install` refuses while a server runs the daemon in its own process (review S7,
// 2026-11-21): that owner holds the lock with no door (wsPort null) and writes no daemon.pid.
describe('refuseInProcessOwner', () => {
  it('refuses an owner with no door and no daemon.pid, and lets every other case go on', async () => {
    const { refuseInProcessOwner } = await import('../../src/providers/daemon-service-cli.js')
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-lock-'))
    try {
      const owner = (wsPort: number | null) => async () => ({ uid: 1, dir: runtimeDir, pid: 4242, instanceId: 'd-x', wsPort })
      await expect(refuseInProcessOwner(runtimeDir, owner(null))).rejects.toThrow(/inside its own process/)
      await expect(refuseInProcessOwner(runtimeDir, owner(5555))).resolves.toBeUndefined()
      await expect(refuseInProcessOwner(runtimeDir, async () => null)).resolves.toBeUndefined()
      // A program still starting (lock taken, door not yet published) has its daemon.pid: not refused.
      fs.writeFileSync(path.join(runtimeDir, 'daemon.pid'), '4242')
      await expect(refuseInProcessOwner(runtimeDir, owner(null))).resolves.toBeUndefined()
    } finally { fs.rmSync(runtimeDir, { recursive: true, force: true }) }
  })
})
