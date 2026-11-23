/**
 * Two host aliases of ONE daemon drain its one journal as one (daemon-connection.ts
 * handoverConnection): each link names the same journal (journalKey: the daemon's process) and
 * tells the ledger its names are one (noteSameJournal), while it still acts as itself (hostKey:
 * the sessions, stops and callers its rows name). The drain side is
 * tests/core/offline-handover-same-journal.test.ts.
 *
 * 2026-11-23, a real companion-lead window: `newdev` and `clouddev`, two rows of one machine,
 * drained its journal each under its own name, twice at once; a record both saw before its ack
 * would have been applied twice (a held message sent twice).
 *
 * Real layer: real DaemonConnections over real WebSockets to MockDaemon, in the real pool, with a
 * temp Walnut home; the drain itself is a spy that records what it was asked to drain.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-offline-drain-same-daemon'))

const drains = vi.hoisted(() => [] as Array<{ hostKey: string; journalKey?: string }>)
vi.mock('../../src/core/offline-handover.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/offline-handover.js')>()
  return {
    ...real,
    runOfflineHandover: vi.fn(async (conn: { hostKey: string; journalKey?: string }) => {
      drains.push({ hostKey: conn.hostKey, journalKey: conn.journalKey })
      return { rounds: 0, records: 0, imported: 0, settled: 0, replayed: 0, skipped: 0, failed: 0 }
    }),
  }
})

import { MockDaemon } from '../helpers/mock-daemon.js'
import { DaemonConnection, sameDaemonHosts, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { updateConfig, getConfig } from '../../src/core/config-manager.js'
import { linkTarget } from '../../src/core/hosts/link.js'
import { HOST_PROFILES_DIR } from '../../src/core/hosts/host-profile.js'
import { __setSshResolverForTest, _resetSameDaemonRecordForTest } from '../../src/core/hosts/same-daemon-record.js'
import { journalNamesOf, _setLedgerFileForTesting } from '../../src/core/offline-merge/ledger.js'

const NET_KEY = 'c'.repeat(64)

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('two aliases of one daemon drain its journal under one name', () => {
  let daemon: MockDaemon
  let lab: MockDaemon | null = null
  const conns: Array<{ host: string; conn: DaemonConnection }> = []

  beforeEach(async () => {
    drains.length = 0
    _setLedgerFileForTesting(null)
    await fs.rm(HOST_PROFILES_DIR, { recursive: true, force: true })
    _resetSameDaemonRecordForTest()
    __setSshResolverForTest(async (name) => ({ hostname: name, port: 22, user: 'me' }))
    await updateConfig({
      hosts: {
        studio: { hostname: 'studio.example' },
        'studio-net': { hostname: 'studio.walnut-net.invalid', transport: 'net', endpoint: NET_KEY },
        lab: { hostname: 'lab.example' },
      },
    } as never)
    daemon = new MockDaemon()
    await daemon.start()
  })

  afterEach(async () => {
    for (const { host, conn } of conns.splice(0)) {
      try { conn.disconnect() } catch { /* best effort */ }
      setPooledConnectionForTest(host, null)
    }
    __setSshResolverForTest(null)
    await daemon.stop()
    if (lab) await lab.stop()
    lab = null
  })

  async function connect(host: string, to: MockDaemon = daemon): Promise<DaemonConnection> {
    const conn = new DaemonConnection(host, linkTarget(host, await getConfig()))
    conns.push({ host, conn })
    setPooledConnectionForTest(host, conn)
    await conn.connectDirect(`ws://127.0.0.1:${to.port}`)
    return conn
  }

  /** Have this link drain again, as a daemon's offline-journal nudge does. */
  function nudge(conn: DaemonConnection): void {
    const c = conn as unknown as { offlineDrainDue: boolean; pushHostSlice(): void }
    c.offlineDrainDue = true
    c.pushHostSlice()
  }

  for (const first of ['studio', 'studio-net'] as const) {
    it(`each link drains the one journal and acts as itself (${first} connects first)`, async () => {
      const second = first === 'studio' ? 'studio-net' : 'studio'
      const a = await connect(first)
      await waitFor(() => drains.length >= 1)
      const b = await connect(second)
      expect(await sameDaemonHosts(second)).toEqual(['studio', 'studio-net'])
      drains.length = 0
      nudge(b)
      await waitFor(() => drains.length >= 1)
      nudge(a)
      await waitFor(() => new Set(drains.map((d) => d.hostKey)).size === 2)
      // One journal, the daemon's process, from both links.
      expect(new Set(drains.map((d) => d.journalKey)).size).toBe(1)
      expect(drains[0].journalKey).toBe(`instance:${daemon.instanceId}`)
      // Each link still acts as itself.
      expect([...new Set(drains.map((d) => d.hostKey))].sort()).toEqual(['studio', 'studio-net'])
      // The ledger counts a row either name recorded.
      expect([...journalNamesOf('studio')].sort()).toEqual(['studio', 'studio-net'])
      expect([...journalNamesOf('studio-net')].sort()).toEqual(['studio', 'studio-net'])
    })
  }

  it('a daemon reached by one name only drains under that name', async () => {
    lab = new MockDaemon()
    await lab.start()
    await connect('lab', lab)
    await waitFor(() => drains.length >= 1)
    expect(drains).toEqual([{ hostKey: 'lab', journalKey: `instance:${lab.instanceId}` }])
    expect(journalNamesOf('lab')).toEqual(['lab'])
  })
})
