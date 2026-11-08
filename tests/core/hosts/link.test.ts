import { describe, it, expect } from 'vitest'
import { linkTarget, UnknownHostError } from '../../../src/core/hosts/link.js'

describe('linkTarget: the one place a host config becomes a transport target', () => {
  it('carries every field a dial needs, shell_setup included', () => {
    const hosts = { box: { hostname: 'box.example.com', user: 'dev', port: 2222, shell_setup: 'source ~/.nvm/nvm.sh', label: 'Box' } }
    expect(linkTarget('box', { hosts })).toEqual({ hostname: 'box.example.com', user: 'dev', port: 2222, shell_setup: 'source ~/.nvm/nvm.sh' })
  })

  it('leaves out what the host does not set', () => {
    expect(linkTarget('box', { hosts: { box: { hostname: 'box' } } })).toEqual({ hostname: 'box' })
  })

  it('reads the older `ssh` spelling, then falls back to the alias itself', () => {
    expect(linkTarget('old', { hosts: { old: { ssh: 'old.example.com' } as never } }).hostname).toBe('old.example.com')
    expect(linkTarget('alias', { hosts: { alias: { hostname: '' } } }).hostname).toBe('alias')
  })

  it('a host found in ~/.ssh/config carries its Host alias, with the real hostname, user and port', () => {
    const hosts = { devbox: { hostname: 'devbox.example.test', user: 'builder', port: 2200, discovered: true } }
    expect(linkTarget('devbox', { hosts })).toEqual({ hostname: 'devbox.example.test', sshAlias: 'devbox', user: 'builder', port: 2200 })
  })

  it('a found host whose hostname was edited keeps the alias and the edited hostname', () => {
    const hosts = { devbox: { hostname: 'devbox-new.example.test', discovered: true } }
    expect(linkTarget('devbox', { hosts })).toEqual({ hostname: 'devbox-new.example.test', sshAlias: 'devbox' })
  })

  it('a host the person added keeps the target it always had: no alias', () => {
    expect(linkTarget('box', { hosts: { box: { hostname: 'box.example.com', user: 'dev' } } })).toEqual({ hostname: 'box.example.com', user: 'dev' })
    expect(linkTarget('box', { hosts: { box: { hostname: 'box.example.com', discovered: false } } })).toEqual({ hostname: 'box.example.com' })
  })

  it('a host-network machine gets no alias, found or not', () => {
    const hosts = { mesh: { hostname: 'mesh', transport: 'net', endpoint: 'ABC', discovered: true } as never }
    expect(linkTarget('mesh', { hosts })).toEqual({ hostname: 'mesh', via: 'net', endpoint: 'abc' })
  })

  it('an alias that could read as an ssh option is never passed as one', () => {
    const hosts = { '-oProxyCommand=x': { hostname: 'h.example.test', discovered: true }, 'a b': { hostname: 'h2.example.test', discovered: true } }
    expect(linkTarget('-oProxyCommand=x', { hosts }).sshAlias).toBeUndefined()
    expect(linkTarget('a b', { hosts }).sshAlias).toBeUndefined()
  })

  it('the local host needs no config', () => {
    expect(linkTarget('__local__', {})).toEqual({ hostname: '__local__' })
    expect(linkTarget('local', {})).toEqual({ hostname: '__local__' })
  })

  it('an unknown host is refused, never dialled as a bare name', () => {
    expect(() => linkTarget('nope', { hosts: {} })).toThrow(UnknownHostError)
    expect(() => linkTarget('nope', {})).toThrow('Unknown host: nope')
    expect(() => linkTarget('__proto__', { hosts: {} })).toThrow(UnknownHostError)
  })
})
