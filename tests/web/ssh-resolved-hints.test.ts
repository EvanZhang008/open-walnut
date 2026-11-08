/**
 * Add host's empty Port and User fields show what ssh resolves (web half of
 * src/core/hosts/ssh-resolve.ts; 2026-11-10 review: port 22 shown while ~/.ssh/config said 3461).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/api/hosts', () => ({ resolveSshName: async () => null }))
const { sshNameOf, sshResolvedHints } = await import('../../web/src/components/settings/sections/useSshResolved')

describe('the row shows it in the empty fields, never writes it', () => {
  const r = { name: 'demo-devbox-c', hostname: '127.0.0.1', port: 3461, user: 'dev', fromConfig: true }
  it('the reported case: Port placeholder 3461, User placeholder dev, one line saying where from', () => {
    expect(sshResolvedHints(r, { port: undefined, user: '' })).toEqual({
      portPlaceholder: '3461', userPlaceholder: 'dev', line: 'From ~/.ssh/config: dev@127.0.0.1, port 3461.',
    })
  })
  it('fields the person filled: no line; no answer: the plain default', () => {
    expect(sshResolvedHints(r, { port: 2222, user: 'sam' }).line).toBeUndefined()
    expect(sshResolvedHints(null, { port: undefined, user: '' })).toEqual({ portPlaceholder: '22' })
  })
  it('a found host resolves by its alias, a typed one by its hostname; a user@host:port is not a name', () => {
    expect(sshNameOf({ discovered: true, alias: 'demo-devbox-c', hostname: '127.0.0.1' })).toBe('demo-devbox-c')
    expect(sshNameOf({ discovered: false, alias: 'c', hostname: 'demo-devbox-c' })).toBe('demo-devbox-c')
    expect(sshNameOf({ discovered: false, alias: 'c', hostname: 'sam@box:2222' })).toBe('')
  })
})
