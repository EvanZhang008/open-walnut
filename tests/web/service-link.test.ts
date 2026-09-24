/**
 * Click-time classifier for links in a session's chat: which hrefs open in the
 * panel's Web view, and which keep the browser's own new-tab behavior.
 */
import { describe, expect, it, vi } from 'vitest'

const hostStore = vi.hoisted(() => ({
  hosts: [] as Array<{ host: string; hostname: string }>,
  hydrateHostStatus: vi.fn(async () => {}),
}))
vi.mock('@/hooks/useHostStatus', () => ({
  getAllHostStatus: () => hostStore.hosts,
  hydrateHostStatus: hostStore.hydrateHostStatus,
}))

import { classifyServiceHref, consoleCanEmbedServices, normalizeServiceInput, primeKnownServiceHosts } from '@/utils/service-link'

const CONSOLE = 'http://localhost:3456'
const ctx = (extra: Parameters<typeof classifyServiceHref>[1] = {}) => ({ consoleOrigin: CONSOLE, knownHosts: [], ...extra })

describe('classifyServiceHref', () => {
  it.each([
    'http://localhost:8377/',
    'http://127.0.0.1:8000/x?y=1',
    'http://0.0.0.0:5173',
    'http://[::1]:3000/',
    'https://localhost:8443/app',
    'http://localhost/',
  ])('loopback %s is a service', (href) => {
    expect(classifyServiceHref(href, ctx())).toBe(new URL(href).toString())
  })

  it('the console itself is not a service, under either loopback spelling', () => {
    expect(classifyServiceHref('http://localhost:3456/tasks/x', ctx())).toBeNull()
    expect(classifyServiceHref('http://127.0.0.1:3456/', ctx())).toBeNull()
    // Another port on the same loopback IS a service.
    expect(classifyServiceHref('http://127.0.0.1:3457/', ctx())).toBe('http://127.0.0.1:3457/')
  })

  it("the session's own host, by full name or short name, with a port", () => {
    const c = ctx({ sessionHost: 'studio', sessionHostname: 'dev-box.corp.example.test' })
    expect(classifyServiceHref('http://dev-box.corp.example.test:8080/', c)).toBe('http://dev-box.corp.example.test:8080/')
    expect(classifyServiceHref('http://dev-box:8377/', c)).toBe('http://dev-box:8377/')
    expect(classifyServiceHref('http://studio:8377/', c)).toBe('http://studio:8377/')
  })

  it('a named host without a port stays an ordinary link', () => {
    const c = ctx({ sessionHostname: 'dev-box.corp.example.test' })
    expect(classifyServiceHref('http://dev-box.corp.example.test/', c)).toBeNull()
  })

  it('any configured host from the shared host store counts', () => {
    hostStore.hosts = [{ host: 'builder', hostname: 'build-box.corp.example.test' }]
    expect(classifyServiceHref('http://build-box.corp.example.test:9000/', { consoleOrigin: CONSOLE })).toBe('http://build-box.corp.example.test:9000/')
    hostStore.hosts = []
  })

  it.each([
    'https://example.com/',
    'https://example.com:8443/',
    '/tasks/abc',
    '#',
    'mailto:a@b.c',
    'vscode://file/x',
    'ftp://localhost:21/',
    'localhost:8080',
  ])('%s is not a service', (href) => {
    expect(classifyServiceHref(href, ctx({ sessionHostname: 'dev-box.corp.example.test' }))).toBeNull()
  })
})

describe('consoleCanEmbedServices', () => {
  it('only a console served from loopback can load 127.0.0.1 tunnel ends', () => {
    expect(consoleCanEmbedServices({ hostname: 'localhost' })).toBe(true)
    expect(consoleCanEmbedServices({ hostname: '127.0.0.1' })).toBe(true)
    expect(consoleCanEmbedServices({ hostname: 'walnut.example.dev' })).toBe(false)
    expect(consoleCanEmbedServices({ hostname: '192.168.1.20' })).toBe(false)
  })
})

describe('normalizeServiceInput (address bar)', () => {
  it.each([
    ['8080', 'http://localhost:8080/'],
    [':8080/x', 'http://localhost:8080/x'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['dev-box:8377/', 'http://dev-box:8377/'],
    ['https://a.example.test:1/', 'https://a.example.test:1/'],
  ])('%s -> %s', (input, want) => expect(normalizeServiceInput(input)).toBe(want))

  it.each(['', '  ', 'ftp://x/', 'not a url at all'])('rejects %j', (input) => {
    expect(normalizeServiceInput(input)).toBeNull()
  })
})

describe('primeKnownServiceHosts', () => {
  it('rides the shared host-status store instead of its own request', () => {
    primeKnownServiceHosts()
    expect(hostStore.hydrateHostStatus).toHaveBeenCalled()
  })
})
