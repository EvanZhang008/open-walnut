/**
 * The shared "which machine does this host:port URL point at" rules. The server
 * (service preview) and the console (click classifier) both import this one
 * module, so these cases are the contract for both sides.
 */
import { describe, expect, it } from 'vitest'
import { hostnamesMatch, isLoopbackHostname, parseServiceUrl } from '../../src/core/service-url.js'
import { resolveServiceTarget } from '../../src/core/session-service-preview.js'

describe('isLoopbackHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '[::1]', '::', '[::]'])(
    '%s is loopback', (h) => expect(isLoopbackHostname(h)).toBe(true),
  )
  it.each(['example.com', 'localhost.example.com', '10.0.0.1', '128.0.0.1', '127.0.0', 'mylocalhost', ''])(
    '%s is not', (h) => expect(isLoopbackHostname(h)).toBe(false),
  )
})

describe('hostnamesMatch', () => {
  it('exact, case-insensitive', () => {
    expect(hostnamesMatch('Dev-Box.corp.example.com', 'dev-box.corp.example.com')).toBe(true)
  })
  it('a URL using the bare short name matches the known FQDN', () => {
    expect(hostnamesMatch('dev-box', 'dev-box.corp.example.com')).toBe(true)
  })
  it('a URL FQDN never matches a bare known name (os.hostname() and ssh aliases are often bare)', () => {
    expect(hostnamesMatch('dev-box.corp.example.com', 'dev-box')).toBe(false)
    expect(hostnamesMatch('a1b2c3d4e5f6.attacker.test', 'a1b2c3d4e5f6')).toBe(false)
    expect(hostnamesMatch('studio.attacker.test', 'studio')).toBe(false)
  })
  it('two different FQDNs sharing a first label do not match', () => {
    expect(hostnamesMatch('web.a.example.com', 'web.b.example.com')).toBe(false)
  })
  it('a short name that is only a prefix does not match', () => {
    expect(hostnamesMatch('dev', 'dev-box.corp.example.com')).toBe(false)
  })
  it('empty never matches', () => {
    expect(hostnamesMatch('', 'x')).toBe(false)
  })
})

describe('parseServiceUrl', () => {
  it.each([
    ['http://localhost:8080/x?y=1#z', 'http://localhost:8080/x?y=1#z'],
    ['localhost:8377', 'http://localhost:8377/'],
    ['  127.0.0.1:8000/api  ', 'http://127.0.0.1:8000/api'],
    ['8080', 'http://localhost:8080/'],
    [':8080/app', 'http://localhost:8080/app'],
    ['https://dev-box.example.com:8443/', 'https://dev-box.example.com:8443/'],
    ['dev-box.example.com:8080', 'http://dev-box.example.com:8080/'],
  ])('%s -> %s', (raw, want) => expect(parseServiceUrl(raw)?.toString()).toBe(want))

  it.each(['', '   ', 'ftp://host/x', 'file:///etc/passwd', 'javascript:alert(1)', 'http://', 'x'.repeat(5000), 'not a url at all', 'http://a b:8080/', 'http://a%20b:8080/', 'http://-x:1/'])(
    'rejects %s', (raw) => {
      const u = parseServiceUrl(raw)
      // `javascript:alert(1)` has no `//`, so it becomes http://javascript:alert(1) which
      // is not a valid URL (non-numeric port) and parses to null.
      expect(u).toBeNull()
    },
  )
})

describe('resolveServiceTarget', () => {
  const hosts = {
    studio: { hostname: 'dev-box.corp.example.com' },
    other: { hostname: 'build-box.corp.example.com' },
    off: { hostname: 'old-box.corp.example.com', enabled: false },
  }
  const url = (s: string) => new URL(s)

  it('loopback goes to the session host, loopback target on that host', () => {
    expect(resolveServiceTarget(url('http://localhost:8080/'), { sessionHost: 'studio', hosts, localNames: [] }))
      .toEqual({ host: 'studio', targets: ['localhost'], reason: 'loopback' })
    expect(resolveServiceTarget(url('http://127.0.0.1:8080/'), { sessionHost: 'studio', hosts, localNames: [] }))
      .toEqual({ host: 'studio', targets: ['127.0.0.1'], reason: 'loopback' })
    expect(resolveServiceTarget(url('http://0.0.0.0:8080/'), { sessionHost: 'studio', hosts, localNames: [] })?.targets)
      .toEqual(['localhost'])
  })

  it('loopback in a local session stays local', () => {
    expect(resolveServiceTarget(url('http://localhost:8080/'), { sessionHost: undefined, hosts, localNames: [] })?.host).toBe('__local__')
    expect(resolveServiceTarget(url('http://localhost:8080/'), { sessionHost: '__local__', hosts, localNames: [] })?.host).toBe('__local__')
  })

  it('ANOTHER configured host: only its name, never its loopback', () => {
    const t = resolveServiceTarget(url('http://build-box.corp.example.com:8377/'), { sessionHost: 'studio', hosts, localNames: [] })
    expect(t).toEqual({ host: 'other', targets: ['build-box.corp.example.com'], reason: 'configured-host' })
  })

  it("the session's OWN host by name: loopback first, then the name", () => {
    const t = resolveServiceTarget(url('http://dev-box.corp.example.com:8377/'), { sessionHost: 'studio', hosts, localNames: [] })
    expect(t).toEqual({ host: 'studio', targets: ['localhost', 'dev-box.corp.example.com'], reason: 'configured-host' })
  })

  it('a bare this-machine name is not fooled by an FQDN that starts with it', () => {
    expect(resolveServiceTarget(url('http://a1b2c3d4e5f6.attacker.test/'), { hosts, localNames: ['a1b2c3d4e5f6'] })).toBeNull()
    expect(resolveServiceTarget(url('http://a1b2c3d4e5f6:3000/'), { hosts, localNames: ['a1b2c3d4e5f6'] })?.host).toBe('__local__')
  })

  it('short name and alias both resolve', () => {
    expect(resolveServiceTarget(url('http://dev-box:8080/'), { hosts, localNames: [] })?.host).toBe('studio')
    expect(resolveServiceTarget(url('http://studio:8080/'), { hosts, localNames: [] })?.host).toBe('studio')
  })

  it('a disabled host is not a target', () => {
    expect(resolveServiceTarget(url('http://old-box.corp.example.com:8080/'), { hosts, localNames: [] })).toBeNull()
  })

  it('this machine by name is local', () => {
    expect(resolveServiceTarget(url('http://my-mac.local:3000/'), { sessionHost: 'studio', hosts, localNames: ['my-mac.local'] }))
      .toEqual({ host: '__local__', targets: ['my-mac.local'], reason: 'this-machine' })
  })

  it('the session host wins when two aliases name the same machine', () => {
    const dup = { a: { hostname: 'dev-box.corp.example.com' }, b: { hostname: 'dev-box.corp.example.com' } }
    expect(resolveServiceTarget(url('http://dev-box.corp.example.com:1/'), { sessionHost: 'b', hosts: dup, localNames: [] })?.host).toBe('b')
  })

  it('an unrelated host is refused', () => {
    expect(resolveServiceTarget(url('http://example.com:8080/'), { sessionHost: 'studio', hosts, localNames: [] })).toBeNull()
  })
})
