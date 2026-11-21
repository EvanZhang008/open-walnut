/**
 * "Walnut on this host" says when its switch only follows the default (the experiment
 * follower_on_every_host turns a never-set host on: GET /api/host-servers answers
 * `settings.byDefault: true`, never for the host carrying this Walnut's tunnel). The words come from hostServerSwitchWords
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
const { hostServerSwitchWords, HOST_SERVER_BY_DEFAULT_TITLE } = await import(`${SECTIONS}/host-servers-status`)
const { HostServerPart } = await import(`${SECTIONS}/HostServersGroup`)

const entry = (hostKey: string, settings: Partial<HostServerEntry['settings']>): HostServerEntry => ({
  hostKey, label: hostKey,
  settings: { enabled: true, expose: { enabled: false, provider: null, options: {} }, program: 'host-server', ...settings },
  view: { hostKey, enabled: settings.enabled ?? true, phase: 'running', since: 0 },
})

describe('hostServerSwitchWords', () => {
  it('a host on only by the experiment\'s default says so', () => {
    expect(hostServerSwitchWords(entry('devbox', { chosenBy: 'default', byDefault: true }))).toBe('On (default)')
  })
  it('the person\'s own on says nothing', () => {
    expect(hostServerSwitchWords(entry('devbox', { chosenBy: 'user' }))).toBeNull()
  })
  it('an off host says nothing', () => {
    expect(hostServerSwitchWords(entry('devbox', { enabled: false, chosenBy: 'default' }))).toBeNull()
  })
  it('the host on for carrying this Walnut\'s tunnel, the experiment off, says nothing', () => {
    // Never set (chosenBy default), on only because the tunnel runs there: the server sends no byDefault.
    expect(hostServerSwitchWords(entry('devbox', { chosenBy: 'default', carriesTunnel: true }))).toBeNull()
  })
  it('the host carrying the tunnel says nothing even if a server also sent byDefault', () => {
    expect(hostServerSwitchWords(entry('devbox', { chosenBy: 'default', byDefault: true, carriesTunnel: true }))).toBeNull()
  })
  it('an older server (no byDefault) says nothing', () => {
    expect(hostServerSwitchWords(entry('devbox', { chosenBy: 'default' }))).toBeNull()
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
    ctx.hosts = [entry('devbox', { chosenBy: 'default', byDefault: true }), entry('buildbox', { chosenBy: 'user' }), entry('tunnelbox', { chosenBy: 'default', carriesTunnel: true })]
    await act(async () => {
      root!.render(createElement('div', null,
        createElement(HostServerPart, { hostKey: 'devbox' }),
        createElement(HostServerPart, { hostKey: 'buildbox' }),
        createElement(HostServerPart, { hostKey: 'tunnelbox' })))
    })
    const words = el.querySelector('[data-testid="host-server-by-default-devbox"]')
    expect(words?.textContent).toBe('On (default)')
    expect(words?.getAttribute('title')).toBe(HOST_SERVER_BY_DEFAULT_TITLE)
    // It sits with the switch, in the row's control.
    expect(words?.parentElement?.querySelector('[data-testid="host-server-enabled-devbox"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="host-server-by-default-buildbox"]')).toBeNull()
    expect(el.querySelector('[data-testid="host-server-enabled-buildbox"]')).not.toBeNull()
    // On for carrying this Walnut's tunnel, not by default: no words, no tooltip.
    expect(el.querySelector('[data-testid="host-server-by-default-tunnelbox"]')).toBeNull()
  })
})
