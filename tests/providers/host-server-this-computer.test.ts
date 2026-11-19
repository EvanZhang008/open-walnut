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

  beforeEach(async () => {
    await fs.rm(HOST_PROFILES_DIR, { recursive: true, force: true })
    _resetSameDaemonRecordForTest()
    __setSshResolverForTest(async (name) => ({ hostname: name, port: 22, user: 'me' }))
    // `selfbox` is a row whose name says nothing: only the daemon's word tells it is this computer.
    await updateConfig({ hosts: { selfbox: { hostname: 'selfbox.example' }, lab: { hostname: 'lab.example' } } } as never)
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
    const self = await connect('selfbox', mine)
    const lab = await connect('lab', elsewhere)
    expect(await self.hostServerHandle().reachesThisComputer()).toBe(true)
    expect(await lab.hostServerHandle().reachesThisComputer()).toBe(false)
    // This computer's own link is not "a host that is this computer".
    expect(await local.hostServerHandle().reachesThisComputer()).toBe(false)
  })

  it('says nothing while this computer\'s own daemon is not linked', async () => {
    const self = await connect('selfbox', mine)
    expect(await self.hostServerHandle().reachesThisComputer()).toBe(false)
  })
})
