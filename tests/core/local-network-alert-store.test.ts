/**
 * The local network letter wired the way the server wires it (startLocalNetworkAlert): the real
 * letter store, the real config's letter language, the episode file in WALNUT_HOME/local. One
 * letter for a confirmed block, none more after a restart, archived once the network is
 * reachable. Only the probe and the clock are injected: nothing here touches a network.
 *
 * WALNUT_HOME is an isolated tmpdir (createMockConstants).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../../src/constants.js'
import { listLetters, setArchived } from '../../src/core/human-inbox/store.js'
import { runningLocalNetworkAlert, startLocalNetworkAlert, CONFIRM_MS } from '../../src/core/hosts/local-network-alert.js'
import type { LocalNetworkVerdict } from '../../src/core/hosts/local-network-probe.js'

describe('local network letter, end to end through the store', () => {
  let stop: (() => void) | null = null
  afterEach(() => { stop?.(); stop = null })

  it('one letter for a confirmed block, none more after a restart, archived once reachable', async () => {
    let clock = Date.UTC(2026, 10, 3, 9, 0)
    let net: LocalNetworkVerdict = 'blocked'
    const deps = {
      probe: async () => ({ verdict: net, gateway: '192.168.1.1', attempts: [], linkKnown: net === 'blocked' ? true : null }),
      now: () => clock,
    }
    const mine = async () => (await listLetters()).letters.filter((l) => l.createdByOp?.startsWith('local-network-blocked:'))
    stop = await startLocalNetworkAlert({ platform: 'darwin', isolated: false, deps })
    const alert = runningLocalNetworkAlert()!
    expect(alert).not.toBeNull()

    await alert.check()
    expect(await mine()).toHaveLength(0)
    const statePath = path.join(WALNUT_HOME, 'local', 'local-network-alert.json')
    expect(fs.existsSync(statePath)).toBe(true)

    clock += CONFIRM_MS
    await alert.check()
    let live = await mine()
    expect(live).toHaveLength(1)
    expect(live[0].subject).toBe('macOS is blocking Walnut from your local network')
    expect(live[0].type).toBe('review')
    expect(live[0].sender.sessionId).toBe('external')
    const id = live[0].id

    // The server restarts while macOS still blocks it.
    stop(); stop = null
    stop = await startLocalNetworkAlert({ platform: 'darwin', isolated: false, deps })
    clock += 5 * 60_000
    await runningLocalNetworkAlert()!.check()
    await runningLocalNetworkAlert()!.check()
    live = await mine()
    expect(live.map((l) => l.id)).toEqual([id])

    // The user turned Walnut on in System Settings: the letter leaves the live feed.
    net = 'reachable'
    await runningLocalNetworkAlert()!.check()
    expect(await mine()).toHaveLength(0)
    const shelf = (await listLetters({ archived: true })).letters.filter((l) => l.id === id)
    expect(shelf).toHaveLength(1)
    expect(shelf[0].archived).toBe(true)
    expect(fs.existsSync(statePath)).toBe(false)
  })

  it('a crash between the send and saving its id sends nothing twice; a letter the user archived closes quietly', async () => {
    let clock = Date.UTC(2026, 10, 3, 12, 0)
    let net: LocalNetworkVerdict = 'blocked'
    const deps = {
      probe: async () => ({ verdict: net, gateway: '192.168.1.1', attempts: [], linkKnown: net === 'blocked' ? true : null }),
      now: () => clock,
    }
    const statePath = path.join(WALNUT_HOME, 'local', 'local-network-alert.json')
    stop = await startLocalNetworkAlert({ platform: 'darwin', isolated: false, deps })
    await runningLocalNetworkAlert()!.check()
    clock += CONFIRM_MS
    await runningLocalNetworkAlert()!.check()
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    const { opKey, letterId } = state.episode
    expect((await listLetters()).letters.filter((l) => l.createdByOp === opKey).map((l) => l.id)).toEqual([letterId])

    // The process died after the store wrote the letter and before the id reached the episode file.
    stop(); stop = null
    delete state.episode.letterId
    fs.writeFileSync(statePath, JSON.stringify(state))
    stop = await startLocalNetworkAlert({ platform: 'darwin', isolated: false, deps })
    await runningLocalNetworkAlert()!.check()
    expect((await listLetters()).letters.filter((l) => l.createdByOp === opKey).map((l) => l.id)).toEqual([letterId])
    expect((await runningLocalNetworkAlert()!.episode())?.letterId).toBe(letterId)

    // The user archived it by hand before the network came back: closing leaves it as it is.
    await setArchived(letterId, true)
    net = 'reachable'
    await runningLocalNetworkAlert()!.check()
    expect(await runningLocalNetworkAlert()!.episode()).toBeNull()
    expect((await listLetters({ archived: true })).letters.filter((l) => l.createdByOp === opKey)).toHaveLength(1)
  })
})
