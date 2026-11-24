/**
 * The shared "which machine does this host:port URL point at" rules. The server
 * (service preview) and the console (click classifier) both import this one
 * module, so these cases are the contract for both sides.
 */
import { describe, expect, it } from 'vitest'
import { hostnamesMatch, isLoopbackHostname, isLoopbackUrl, parseServiceUrl } from '../../src/core/service-url.js'
import { resolveServiceTarget } from '../../src/core/session-service-preview.js'

describe('isLoopbackHostname', () => {
  it.each(['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '::1', '[::1]', '::', '[::]', '[::ffff:7f00:1]', '::ffff:127.0.0.1', '[::ffff:7f12:3]'])(
    '%s is loopback', (h) => expect(isLoopbackHostname(h)).toBe(true),
  )
  it.each(['example.com', 'localhost.example.com', '10.0.0.1', '128.0.0.1', '127.0.0', 'mylocalhost', '', '[::ffff:a00:1]', '::ffff:10.0.0.1'])(
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

  it("a link host's own session wins its machine's name over an SSH row naming the same machine", () => {
    // One machine, two rows: an SSH row by its name and a host-network row whose daemon reports that name.
    const twin = {
      'twin-ssh': { hostname: 'box.example.test' },
      'twin-net': { hostname: 'twin-net.walnut-net.invalid', transport: 'net' as const },
    }
    const names = { 'twin-net': ['box.example.test'] }
    const at = (sessionHost?: string) => ({ sessionHost, hosts: twin as never, localNames: ['my-mac.local'], machineNames: names })
    expect(resolveServiceTarget(url('http://box.example.test:5173/'), at('twin-net')))
      .toEqual({ host: 'twin-net', targets: ['localhost'], reason: 'configured-host' })
    // A short form can be two machines: the configured row keeps it.
    expect(resolveServiceTarget(url('http://box:5173/'), at('twin-net'))?.host).toBe('twin-ssh')
    // From anywhere else the SSH row still answers, by the name only.
    expect(resolveServiceTarget(url('http://box.example.test:5173/'), at(undefined)))
      .toEqual({ host: 'twin-ssh', targets: ['box.example.test'], reason: 'configured-host' })
    expect(resolveServiceTarget(url('http://box.example.test:5173/'), at('twin-ssh'))?.host).toBe('twin-ssh')
    // A name this machine has is never taken by a daemon's word.
    const mine = { 'twin-net': ['my-mac.local'] }
    expect(resolveServiceTarget(url('http://my-mac.local:5173/'), { ...at('twin-net'), machineNames: mine })?.host).toBe('__local__')
  })

  describe('a link host (no SSH): its loopback for its own session, or a URL naming the machine exactly', () => {
    // A host network row's hostname is a placeholder that never resolves; the cloud box's is the companion's domain.
    const links = {
      ...hosts,
      'joined-box': { hostname: 'joined-box.walnut-net.invalid', transport: 'net' as const },
      __cloudbox__: { hostname: 'box.example.test', cloud_box: true },
    }
    const machineNames = { 'joined-box': ['joined-box-7.lan.example.test'], __cloudbox__: ['ip-10-0-0-5'], studio: ['dev-box-real.corp.example.com'] }
    const ctx = (sessionHost?: string, names: Record<string, string[]> = machineNames, h: Record<string, object> = links) =>
      ({ sessionHost, hosts: h as never, localNames: ['my-mac.local'], machineNames: names })
    const loopback = (host: string) => ({ host, targets: ['localhost'], reason: 'configured-host' })

    it('from its own session: the name its daemon says, its short form, the alias and the row hostname all reach its loopback', () => {
      for (const u of ['http://joined-box-7.lan.example.test:5173/', 'http://joined-box-7:5173/', 'http://joined-box:5173/', 'http://joined-box.walnut-net.invalid:5173/']) {
        expect(resolveServiceTarget(url(u), ctx('joined-box')), u).toEqual(loopback('joined-box'))
      }
    })

    it('from a session elsewhere: only the alias or the exact machine name; a looser match is refused', () => {
      expect(resolveServiceTarget(url('http://joined-box-7.lan.example.test:5173/'), ctx('studio'))).toEqual(loopback('joined-box'))
      expect(resolveServiceTarget(url('http://joined-box:5173/'), ctx('studio'))).toEqual(loopback('joined-box'))
      // A short form of the machine name, and the row's placeholder hostname, are not exact.
      expect(resolveServiceTarget(url('http://joined-box-7:5173/'), ctx('studio'))).toBeNull()
      expect(resolveServiceTarget(url('http://joined-box.walnut-net.invalid:5173/'), ctx('studio'))).toBeNull()
      expect(resolveServiceTarget(url('http://joined-box-7.lan.example.test:5173/'), ctx(undefined))).toEqual(loopback('joined-box'))
    })

    it('the cloud box by its own name reaches its loopback; the companion\'s public domain never does', () => {
      expect(resolveServiceTarget(url('http://ip-10-0-0-5:3000/'), ctx('__cloudbox__'))).toEqual(loopback('__cloudbox__'))
      for (const session of ['__cloudbox__', 'studio', undefined]) {
        expect(resolveServiceTarget(url('https://box.example.test:8443/'), ctx(session)), String(session)).toBeNull()
      }
      // Not even when its daemon reports that domain as its own name.
      expect(resolveServiceTarget(url('https://box.example.test:8443/'), ctx('studio', { __cloudbox__: ['box.example.test'] }))).toBeNull()
    })

    it('configured names win over every machine name: a daemon naming another host or this machine captures nothing', () => {
      // The joined box's daemon says the studio's name, a short form of it, or this Mac's name.
      for (const claim of ['dev-box.corp.example.com', 'dev-box', 'my-mac.local', 'my-mac']) {
        const names = { 'joined-box': [claim] }
        // Exactly its own full name, from its own session, is its own machine (pass 0); every looser claim is not.
        const fullOwn = claim === 'dev-box.corp.example.com'
        expect(resolveServiceTarget(url('http://dev-box.corp.example.com:8080/'), ctx('joined-box', names))?.host, claim).toBe(fullOwn ? 'joined-box' : 'studio')
        expect(resolveServiceTarget(url('http://dev-box.corp.example.com:8080/'), ctx('studio', names))?.host, claim).toBe('studio')
        expect(resolveServiceTarget(url('http://dev-box.corp.example.com:8080/'), ctx(undefined, names))?.host, claim).toBe('studio')
        expect(resolveServiceTarget(url('http://dev-box:8080/'), ctx('joined-box', names))?.host, claim).toBe('studio')
        expect(resolveServiceTarget(url('http://my-mac.local:8080/'), ctx('joined-box', names))?.host, claim).toBe('__local__')
      }
      // A name the daemon claims that another link entry is configured with is that entry's.
      const two = { ...links, 'joined-two': { hostname: 'joined-two.walnut-net.invalid', transport: 'net' as const } }
      expect(resolveServiceTarget(url('http://joined-two:5173/'), ctx('studio', { 'joined-box': ['joined-two'] }, two))).toEqual(loopback('joined-two'))
    })

    it('an SSH host never matches by its daemon\'s word: machine names count only for link hosts', () => {
      expect(resolveServiceTarget(url('http://dev-box-real.corp.example.com:8080/'), ctx('studio'))).toBeNull()
      // Its configured name keeps the SSH rule (loopback first on its own host).
      expect(resolveServiceTarget(url('http://dev-box.corp.example.com:8080/'), ctx('studio')))
        .toEqual({ host: 'studio', targets: ['localhost', 'dev-box.corp.example.com'], reason: 'configured-host' })
    })

    it('a full name that only starts with the machine\'s short name is not that machine', () => {
      expect(resolveServiceTarget(url('http://ip-10-0-0-5.attacker.test:3000/'), ctx('__cloudbox__'))).toBeNull()
      // Without its daemon's word (a link that is down), the real name is unknown: refused, as before.
      expect(resolveServiceTarget(url('http://joined-box-7.lan.example.test:5173/'), ctx('joined-box', {}))).toBeNull()
    })
  })
})

describe('isLoopbackUrl', () => {
  it('reads the host of a whole URL, an IPv4-mapped loopback included', () => {
    for (const u of ['http://127.0.0.1:8402/v1', 'http://[::1]:9/v1', 'http://[::ffff:127.0.0.1]:9/v1', 'http://localhost/']) expect([u, isLoopbackUrl(u)]).toEqual([u, true])
    for (const u of ['https://llm.example.com/v1', 'http://[::ffff:10.0.0.1]/', 'not a url', 42]) expect([u, isLoopbackUrl(u)]).toEqual([u, false])
  })
})
