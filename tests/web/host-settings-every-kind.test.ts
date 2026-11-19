/**
 * Settings > Hosts gives every kind of host the same features, whatever the connection
 * (the user, 2026-11-18: "make sure all feature is availble. no matter the connection ntype"):
 *
 *   profile   "What Walnut knows" (GET/PATCH /api/v1/hosts/:host/profile takes any host) is
 *             in the Details of an SSH host, a host-network machine, This Mac and the cloud box
 *   connect   the Overview's offline row offers Connect for every host Walnut dials, the cloud
 *             box included (a person's Retry there: core/hosts/host-connect-action.ts)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const asked = vi.hoisted(() => ({ profiles: [] as string[] }))
const SECTIONS = '../../web/src/components/settings/sections'
vi.mock('@/hooks/useHostStatus', () => ({ useHostStatus: () => undefined }))
vi.mock('@/hooks/useServerRole', () => ({ useIsReplicaServer: () => false }))
vi.mock('../../web/src/components/settings/sections/HostFleetVitals', () => ({ FleetFacts: () => null, FleetProblems: () => null, FleetVitals: () => null }))
vi.mock('../../web/src/components/settings/sections/RemoteHostStatus', () => ({ RemoteHostDetail: () => null }))
vi.mock('../../web/src/components/settings/sections/HostThisPart', () => ({ HostThisPart: () => null }))
vi.mock('../../web/src/components/settings/sections/HostProfileDisclosure', () => ({
  useHostProfile: (alias: string) => { asked.profiles.push(alias); return { profile: null } },
  profileSystemLine: () => ({ text: 'Linux' }),
  HostProfileDisclosure: () => null,
}))

const { HostDetails } = await import(`${SECTIONS}/HostDetails`)

let doc: Document
let el: HTMLElement
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  asked.profiles = []
  el = doc.createElement('div')
  doc.body.appendChild(el)
  root = createRoot(el)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})

describe('"What Walnut knows" on every kind of host row', () => {
  it.each([
    ['ssh', 'devbox', 'devbox'],
    ['net', 'studio', 'studio'],
    ['fleet', '__cloudbox__', '__cloudbox__'],
    ['local', '__local__', '__local__'],
  ])('%s: its Details read the host\'s profile and show the part', async (kind, alias, profileOf) => {
    await act(async () => {
      root!.render(createElement(HostDetails, { alias, name: alias, now: 1, linked: kind !== 'fleet', kind, rowProblem: null, onClose: () => {} }))
    })
    expect(el.querySelector(`[data-testid="host-profile-heading-${alias}"]`)?.textContent).toBe('What Walnut knows')
    expect(asked.profiles).toContain(profileOf)
  })

  it('no host row opts out of it: HostDetails takes no profile switch, and every row renders it', () => {
    const src = (f: string) => readFileSync(join(__dirname, SECTIONS, f), 'utf8')
    expect(src('HostDetails.tsx')).not.toMatch(/profile\?:\s*boolean/)
    for (const row of ['RemoteHostSshRow.tsx', 'NetMachineRow.tsx', 'FleetHostRow.tsx']) expect(src(row), row).toMatch(/<HostDetails\b/)
  })
})

describe('Connect on the Overview\'s offline row', () => {
  it('every host Walnut dials offers it, the cloud box included; never this machine or a host that is not Linux', async () => {
    const { offlineRowConnects } = await import(`${SECTIONS}/HostFleetCard`)
    expect(offlineRowConnects('ssh-tunnel', false)).toBe(true)
    expect(offlineRowConnects('host-network', false)).toBe(true)
    expect(offlineRowConnects('bridge', false)).toBe(true)
    expect(offlineRowConnects('local', false)).toBe(false)
    expect(offlineRowConnects('ssh-tunnel', true)).toBe(false)
  })
})
