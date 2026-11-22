/**
 * A host row that is really this computer gets no follower of its own by default
 * (core/host-server/manager.ts): the host-server handle says so from the daemon's own word, the
 * instance id its hello gives (sameDaemonHosts, daemon-connection.ts), never from a name or an
 * address. Real DaemonConnections over real WebSockets to MockDaemon, in the real pool.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-server-this-computer'))

import { MockDaemon } from '../helpers/mock-daemon.js'
import { DaemonConnection, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { updateConfig, getConfig } from '../../src/core/config-manager.js'
import { linkTarget } from '../../src/core/hosts/link.js'
import { HOST_PROFILES_DIR } from '../../src/core/hosts/host-profile.js'
import { __setSshResolverForTest, _resetSameDaemonRecordForTest } from '../../src/core/hosts/same-daemon-record.js'

describe('a host row that is this computer', () => {
  let mine: MockDaemon
  let elsewhere: MockDaemon
  const conns: Array<{ host: string; conn: DaemonConnection }> = []
  // Row names of this test only. A link's connect writes the pair it confirms into the host
  // profiles in the background (sameDaemonHosts, same-daemon-record.ts); a write of the test
  // before that lands after this one's reset would name its rows, never these (2026-11-22: under a
  // full run's load it named `selfbox`, and the next test read this computer as recorded).
  let run = 0
  let SELF = ''
  let LAB = ''

  beforeEach(async () => {
    run++
    SELF = `selfbox-${run}`
    LAB = `lab-${run}`
    await fs.rm(HOST_PROFILES_DIR, { recursive: true, force: true })
    _resetSameDaemonRecordForTest()
    __setSshResolverForTest(async (name) => ({ hostname: name, port: 22, user: 'me' }))
    // The `selfbox-<n>` row's name says nothing: only the daemon's word tells it is this computer.
    await updateConfig({ hosts: { [SELF]: { hostname: 'selfbox.example' }, [LAB]: { hostname: 'lab.example' } } } as never)
    mine = new MockDaemon()
    elsewhere = new MockDaemon()
    await mine.start()
    await elsewhere.start()
  })

  afterEach(async () => {
    for (const { host, conn } of conns.splice(0)) {
      try { conn.disconnect() } catch { /* best effort */ }
      setPooledConnectionForTest(host, null)
    }
    __setSshResolverForTest(null)
    await mine.stop()
    await elsewhere.stop()
  })

  async function connect(host: string, to: MockDaemon): Promise<DaemonConnection> {
    const conn = new DaemonConnection(host, linkTarget(host, await getConfig()))
    conns.push({ host, conn })
    setPooledConnectionForTest(host, conn)
    await conn.connectDirect(`ws://127.0.0.1:${to.port}`)
    return conn
  }

  it('is told by its link reaching this computer\'s own daemon process; another machine is not', async () => {
    const local = await connect('__local__', mine)
    const self = await connect(SELF, mine)
    const lab = await connect(LAB, elsewhere)
    expect(await self.hostServerHandle().reachesThisComputer()).toBe(true)
    expect(await lab.hostServerHandle().reachesThisComputer()).toBe(false)
    // This computer's own link is not "a host that is this computer".
    expect(await local.hostServerHandle().reachesThisComputer()).toBe(false)
  })

  it('is unknown (null) while this computer\'s own daemon is not linked yet, as at a start', async () => {
    const self = await connect(SELF, mine)
    const lab = await connect(LAB, elsewhere)
    expect(await self.hostServerHandle().reachesThisComputer()).toBeNull()
    expect(await lab.hostServerHandle().reachesThisComputer()).toBeNull()
    // Once it is linked, each is told.
    await connect('__local__', mine)
    expect(await self.hostServerHandle().reachesThisComputer()).toBe(true)
    expect(await lab.hostServerHandle().reachesThisComputer()).toBe(false)
  })
})
