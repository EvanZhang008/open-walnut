/** Tunnel providers (src/core/expose/registry.ts): the built-in command one and plugin definitions. */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  DEFAULT_URL_PATTERN, _resetExposeProvidersForTesting, commandProvider, getExposeProvider, listExposeProviders,
  onExposeProvidersChanged, registerExposeProvider,
} from '../../src/core/expose/registry.js'

const DEF = { id: 'corp-tunnel', title: 'Company tunnel', command: 'tunnel', args: ['{port}'], urlPattern: 'https://\\S+' }

beforeEach(() => _resetExposeProvidersForTesting())

describe('tunnel providers', () => {
  it('a plugin registers a definition; its dispose removes it; each change is announced', () => {
    let changes = 0
    onExposeProvidersChanged(() => { changes++ })
    const reg = registerExposeProvider('corp-plugin', DEF)
    expect(getExposeProvider('corp-tunnel')).toMatchObject({ title: 'Company tunnel' })
    expect(listExposeProviders()).toEqual([{ id: 'corp-tunnel', title: 'Company tunnel', owner: 'corp-plugin', options: [] }])
    reg.dispose()
    expect(getExposeProvider('corp-tunnel')).toBeNull()
    expect(changes).toBe(2)
  })

  it('another plugin cannot take an id; the same plugin replaces its own', () => {
    registerExposeProvider('a', DEF)
    expect(() => registerExposeProvider('b', DEF)).toThrow(/already registered by a/)
    registerExposeProvider('a', { ...DEF, title: 'Renamed' })
    expect(getExposeProvider('corp-tunnel')?.title).toBe('Renamed')
  })

  it('refuses a bad definition', () => {
    expect(() => registerExposeProvider('a', { ...DEF, id: 'Bad Id' })).toThrow(/must be lowercase/)
    expect(() => registerExposeProvider('a', { ...DEF, id: 'command' })).toThrow(/built-in/)
    expect(() => registerExposeProvider('a', { ...DEF, urlPattern: '(' })).toThrow(/not a valid pattern/)
    expect(() => registerExposeProvider('a', { ...DEF, readyPattern: '[' })).toThrow(/not a valid pattern/)
    expect(() => registerExposeProvider('a', { ...DEF, options: [{ key: 'port', label: 'Port' }] })).toThrow(/not "port"/)
    expect(() => registerExposeProvider('a', { ...DEF, command: ' ' })).toThrow(/needs a command/)
  })

  it('the built-in command provider exists once config names a command', () => {
    expect(commandProvider(undefined)).toBeNull()
    expect(commandProvider({ command: '  ' })).toBeNull()
    const def = commandProvider({ command: 'cloudflared', args: ['tunnel', '--url', 'http://127.0.0.1:{port}'] })
    expect(def).toMatchObject({ id: 'command', command: 'cloudflared', urlPattern: DEFAULT_URL_PATTERN })
    expect(listExposeProviders({ command: 'cloudflared' }).map((p) => p.id)).toEqual(['command'])
    expect(getExposeProvider('command', { command: 'x', url_pattern: 'https://y' })?.urlPattern).toBe('https://y')
  })
})
