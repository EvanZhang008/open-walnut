/**
 * Add host shows what ssh resolves for the name it dials (`ssh -G`, core/hosts/ssh-resolve.ts;
 * 2026-11-10 review: Add host "demo-devbox-c" showed port 22 while ~/.ssh/config said 3461).
 */
import { describe, expect, it } from 'vitest'
import { isResolvableName, parseSshG, resolveSshName } from '../../../src/core/hosts/ssh-resolve.js'

const G = (host: string, port: number, user: string) => `user ${user}\nhostname ${host}\nport ${port}\naddressfamily any\n`

describe('parseSshG', () => {
  it('reads hostname, port and user, and says when the config changed them', () => {
    expect(parseSshG('demo-devbox-c', G('127.0.0.1', 3461, 'dev'), 'me')).toEqual({ name: 'demo-devbox-c', hostname: '127.0.0.1', port: 3461, user: 'dev', fromConfig: true })
    expect(parseSshG('plain.example.test', G('plain.example.test', 22, 'me'), 'me')?.fromConfig).toBe(false)
    expect(parseSshG('x', 'garbage', 'me')).toBeNull()
  })
})

describe('isResolvableName: never an option or a user@', () => {
  for (const bad of ['-oProxyCommand=touch /tmp/x', '-G', 'a b', 'me@box', '', '../x', 'a;b'])
    it(`refuses ${JSON.stringify(bad)}`, () => expect(isResolvableName(bad)).toBe(false))
  for (const ok of ['demo-devbox-c', 'box.example.test', '127.0.0.1', '::1', 'build_7'])
    it(`takes ${ok}`, () => expect(isResolvableName(ok)).toBe(true))
})

describe('resolveSshName', () => {
  it('runs `ssh -G <name>` only, and answers null when ssh refuses', async () => {
    const asked: string[][] = []
    const r = await resolveSshName('demo-devbox-c', { localUser: 'me', run: async (args) => { asked.push(args); return { code: 0, stdout: G('127.0.0.1', 3461, 'dev') } } })
    expect(asked).toEqual([['-G', 'demo-devbox-c']])
    expect(r?.port).toBe(3461)
    expect(await resolveSshName('x', { run: async () => ({ code: 255, stdout: '' }) })).toBeNull()
    expect(await resolveSshName('-oX', { run: async () => { throw new Error('must not run') } })).toBeNull()
  })
})
