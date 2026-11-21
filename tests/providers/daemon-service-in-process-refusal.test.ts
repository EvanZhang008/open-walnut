/**
 * `walnut service install` and the handover it asks for refuse while a Walnut server runs the
 * session daemon inside its own process for the dir (review S7, 2026-11-21). The runtime says so in
 * its lock banner (`inProcess`, review R2-N1): a daemon program still starting, its door not yet
 * published, is never taken for one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireDaemonInstanceLock, readDaemonInstanceOwner } from '../../src/providers/daemon-instance-lock.js'

describe('refuseInProcessOwner', () => {
  it('refuses only an owner whose banner says it runs inside a server', async () => {
    const { refuseInProcessOwner } = await import('../../src/providers/daemon-service-cli.js')
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-lock-'))
    try {
      const owner = (wsPort: number | null, inProcess?: true) => async () => ({ uid: 1, dir: runtimeDir, pid: 4242, instanceId: 'd-x', wsPort, ...(inProcess ? { inProcess } : {}) })
      await expect(refuseInProcessOwner(runtimeDir, owner(null, true))).rejects.toThrow(/inside its own process/)
      // A program still starting (lock taken, door not yet published) and a running program go on.
      await expect(refuseInProcessOwner(runtimeDir, owner(null))).resolves.toBeUndefined()
      await expect(refuseInProcessOwner(runtimeDir, owner(5555))).resolves.toBeUndefined()
      await expect(refuseInProcessOwner(runtimeDir, async () => null)).resolves.toBeUndefined()
    } finally { fs.rmSync(runtimeDir, { recursive: true, force: true }) }
  })

  it('the real lock carries the flag to a reader, and only when set', async () => {
    const { refuseInProcessOwner } = await import('../../src/providers/daemon-service-cli.js')
    const uid = os.userInfo().uid
    for (const inProcess of [true, false]) {
      const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-lock-'))
      const lock = await acquireDaemonInstanceLock({ runtimeDir, uid, pid: process.pid, instanceId: `d-${inProcess}`, inProcess })
      try {
        expect(lock.kind).toBe('owner')
        const read = await readDaemonInstanceOwner({ runtimeDir, uid })
        expect(read?.inProcess).toBe(inProcess ? true : undefined)
        const verdict = refuseInProcessOwner(runtimeDir)
        if (inProcess) await expect(verdict).rejects.toThrow(/inside its own process/)
        else await expect(verdict).resolves.toBeUndefined()
      } finally {
        if (lock.kind === 'owner') await lock.release()
        fs.rmSync(runtimeDir, { recursive: true, force: true })
      }
    }
  })
})
