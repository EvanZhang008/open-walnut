/**
 * The replica cluster (tests/helpers/replica-cluster.ts) on the path a public install now takes by
 * default: the Mac's session daemon runs inside the Mac server's own process (experiment
 * in_process_daemon, on by default since 2026-11-24). Every other cluster spec pins the Mac's daemon
 * as a program of its own (macEnvOf), so this one keeps the default covered end to end:
 *
 *   - the Mac boots with no daemon program: its daemon dir's lock is held by the Mac server's own
 *     pid (in process), with no daemon.pid, and the host's replica is set up and copied to as usual;
 *   - the Mac sleeps and wakes as one process (SIGSTOP/SIGCONT of the server alone): the replica
 *     answers while it is away and hands back to it when it is back.
 *
 * Twin: the standalone daemon twin on the host (bun), as the other cluster specs' default.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUN, startReplicaCluster, type ReplicaCluster } from '../helpers/replica-cluster.js'
import { readDaemonInstanceOwner } from '../../src/providers/daemon-instance-lock.js'

describe.skipIf(!BUN)('the replica cluster with the Mac\'s daemon in its own process (the public default)', () => {
  let c: ReplicaCluster
  let token = ''

  beforeAll(async () => {
    c = await startReplicaCluster({ twin: 'standalone', macEnv: { WALNUT_IN_PROCESS_DAEMON: '1' } })
    process.stdout.write(`replica-cluster-in-process-e2e: cluster at ${c.base}\n`)
    token = await c.pairDevice('marina-phone')
  }, 900_000)

  afterAll(async () => { await c?.stop() }, 120_000)

  it('the Mac runs no daemon program: its own process holds the daemon dir', async () => {
    expect(c.macDaemonPid).toBeNull()
    // The Mac's daemon dir in the cluster's layout (replica-cluster.ts dirs: macDaemon).
    const macDaemon = path.join(c.base, 'md')
    const owner = await readDaemonInstanceOwner({ runtimeDir: macDaemon, uid: os.userInfo().uid })
    expect(owner).toMatchObject({ pid: c.macPid, inProcess: true, home: c.macData })
    expect(fs.existsSync(path.join(macDaemon, 'daemon.pid'))).toBe(false)
  })

  it('the Mac sleeps and wakes as one process; the replica answers meanwhile and hands back', async () => {
    c.sleepMac()
    await c.waitAway(token)
    const away = await c.replica('GET', '/api/v1/instance', { token })
    expect(away.status).toBe(200)
    c.wakeMac()
    await c.waitBack(token)
    const back = await c.mac('GET', '/api/v1/instance')
    expect(back.status).toBe(200)
  }, 600_000)
})
