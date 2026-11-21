/**
 * "Walnut on this host" says when its switch only follows the default (the experiment
 * follower_on_every_host turns a never-set host on: GET /api/host-servers answers
 * `settings.chosenBy: 'default'`). The words come from hostServerSwitchWords
 * (host-servers-status.ts) and sit beside the switch in HostServerPart (HostServersGroup.tsx);
 * a host the person set, a host that is off and an older server's answer show none.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { HostServerEntry } from '../../web/src/components/settings/sections/host-servers-status'

const ctx = vi.hoisted(() => ({ hosts: [] as unknown[] }))
vi.mock('../../web/src/components/settings/sections/host-settings-data', () => ({
  useHostSettings: () => ({
    servers: {
      data: { hosts: ctx.hosts, providers: [], followerByDefault: true },
      busy: null, errors: {}, optionErrors: {}, setOptionError: () => {},
      call: async () => true, write: async () => true, drafts: {}, setDrafts: () => {},
    },
  }),
}))

const SECTIONS = '../../web/src/components/settings/sections'
const { hostServerSwitchWords } = await import(`${SECTIONS}/host-servers-status`)
const { HostServerPart } = await import(`${SECTIONS}/HostServersGroup`)

const entry = (hostKey: string, settings: Partial<HostServerEntry['settings']>): HostServerEntry => ({
  hostKey, label: hostKey,
  settings: { enabled: true, expose: { enabled: false, provider: null, options: {} }, program: 'host-server', ...settings },
  view: { hostKey, enabled: settings.enabled ?? true, phase: 'running', since: 0 },
})

describe('hostServerSwitchWords', () => {
  it('a host on only by default says so; the person\'s on, an off host and an older server say nothing', () => {
    expect(hostServerSwitchWords(entry('devbox', { chosenBy: 'default' }))).toBe('On (default)')
    expect(hostServerSwitchWords(entry('devbox', { chosenBy: 'user' }))).toBeNull()
    expect(hostServerSwitchWords(entry('devbox', { enabled: false, chosenBy: 'default' }))).toBeNull()
    expect(hostServerSwitchWords(entry('devbox', {}))).toBeNull()
  })
})

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
  el = doc.createElement('div')
  doc.body.appendChild(el)
  root = createRoot(el)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})

describe('HostServerPart: the switch of a host on by default', () => {
  it('reads on and says it follows the default, beside the switch; a host the person turned on does not', async () => {
    ctx.hosts = [entry('devbox', { chosenBy: 'default' }), entry('buildbox', { chosenBy: 'user' })]
    await act(async () => {
      root!.render(createElement('div', null,
        createElement(HostServerPart, { hostKey: 'devbox' }),
        createElement(HostServerPart, { hostKey: 'buildbox' })))
    })
    const words = el.querySelector('[data-testid="host-server-by-default-devbox"]')
    expect(words?.textContent).toBe('On (default)')
    // It sits with the switch, in the row's control.
    expect(words?.parentElement?.querySelector('[data-testid="host-server-enabled-devbox"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="host-server-by-default-buildbox"]')).toBeNull()
    expect(el.querySelector('[data-testid="host-server-enabled-buildbox"]')).not.toBeNull()
  })
})
