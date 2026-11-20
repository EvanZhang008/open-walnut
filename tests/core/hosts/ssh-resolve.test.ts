/**
 * Add host shows what ssh resolves for the name it dials (`ssh -G`, core/hosts/ssh-resolve.ts;
 * 2026-11-10 review: Add host "demo-devbox-c" showed port 22 while ~/.ssh/config said 3461).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

// Each `ssh -G` start held the Mac's loop thread 250 ms to 1 s (2026-11-19): the answer is kept
// while ~/.ssh/config is unchanged, and asked again once it changes.
describe('resolveSshName keeps its answer while ~/.ssh/config is unchanged', () => {
  it('runs ssh once for repeated asks, and again after the config changes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-resolve-keep-'))
    const bin = path.join(dir, 'bin')
    const home = path.join(dir, 'home')
    const runs = path.join(dir, 'runs')
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host keep-box\n  Port 3461\n')
    fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\necho x >> '${runs}'\nprintf 'user dev\\nhostname 127.0.0.1\\nport 3461\\n'\n`, { mode: 0o755 })
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH }
    process.env.HOME = home
    process.env.PATH = `${bin}:${saved.PATH}`
    const count = () => fs.readFileSync(runs, 'utf8').trim().split('\n').length
    try {
      expect((await resolveSshName('keep-box', { localUser: 'me' }))?.port).toBe(3461)
      expect((await resolveSshName('keep-box', { localUser: 'me' }))?.port).toBe(3461)
      expect(count()).toBe(1)
      fs.appendFileSync(path.join(home, '.ssh', 'config'), '  User dev\n')
      expect((await resolveSshName('keep-box', { localUser: 'me' }))?.port).toBe(3461)
      expect(count()).toBe(2)
    } finally {
      process.env.HOME = saved.HOME
      process.env.PATH = saved.PATH
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
