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
