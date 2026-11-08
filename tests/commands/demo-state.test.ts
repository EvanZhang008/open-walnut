/**
 * The Demo launcher's state file and control channel (src/commands/demo.ts).
 * A state file that does not prove a Demo identity (token, generation, pid, port,
 * status) is refused, so `walnut demo reset` never clears data on a guess; and the
 * control answer must echo the same token, generation and pid, so a stranger
 * listening on the port cannot pose as the Demo. fetch is mocked: nothing listens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const account = vi.hoisted(() => ({ homedir: '' }))
vi.mock('../../src/lib/account.js', () => ({
  accountInfo: () => ({ username: 'demo-user', homedir: account.homedir, shell: '/bin/sh', uid: 501, gid: 20 }),
}))

import { demoControl, readDemoState, writeDemoState, type DemoState } from '../../src/commands/demo.js'
import { demoPaths } from '../../src/commands/demo-home.js'

let base: string
let file: string

const valid = (): DemoState => ({
  v: 1, generation: '0f0e0d0c-0b0a-4908-8706-050403020100', token: '11111111-1111-1111-1111-111111111111',
  controlPort: 41234, pid: 4242, status: 'ready',
})

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-state-')))
  account.homedir = path.join(base, 'account')
  file = path.join(base, 'state.json')
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('readDemoState', () => {
  it('returns null when there is no state file', async () => {
    expect(await readDemoState(file)).toBeNull()
  })

  it('reads back what writeDemoState wrote, mode 0600, no temp file left', async () => {
    const root = path.join(base, 'open-walnut-demo')
    fs.mkdirSync(root)
    const paths = demoPaths(root, valid().generation)
    await writeDemoState(paths, valid())
    expect(await readDemoState(paths.state)).toEqual(valid())
    expect(fs.statSync(paths.state).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(root)).toEqual(['state.json'])
  })

  it('keeps the recorded process start identity and refuses an invalid one', async () => {
    fs.writeFileSync(file, JSON.stringify({ ...valid(), startTime: 'proc:123456' }))
    expect((await readDemoState(file))?.startTime).toBe('proc:123456')
    for (const startTime of ['', 123, {}, 'unknown']) {
      fs.writeFileSync(file, JSON.stringify({ ...valid(), startTime }))
      await expect(readDemoState(file)).rejects.toThrow(/invalid/)
    }
  })

  it('accepts a starting state with no control port yet', async () => {
    fs.writeFileSync(file, JSON.stringify({ ...valid(), controlPort: 0, status: 'starting' }))
    expect((await readDemoState(file))?.status).toBe('starting')
  })

  const invalid: Array<[string, Record<string, unknown>]> = [
    ['version', { v: 2 }],
    ['generation with a slash', { generation: '../etc' }],
    ['empty generation', { generation: '' }],
    ['short token', { token: 'abc' }],
    ['token with non-hex', { token: 'zzzzzzzz-1111-1111-1111-111111111111' }],
    ['token wrong type', { token: 42 }],
    ['pid 1', { pid: 1 }],
    ['pid 0', { pid: 0 }],
    ['negative pid', { pid: -5 }],
    ['fractional pid', { pid: 12.5 }],
    ['string pid', { pid: '4242' }],
    ['negative port', { controlPort: -1 }],
    ['port over 65535', { controlPort: 70000 }],
    ['fractional port', { controlPort: 80.5 }],
    ['port 0 while ready', { controlPort: 0, status: 'ready' }],
    ['port 0 while stopped', { controlPort: 0, status: 'stopped' }],
    ['unknown status', { status: 'running' }],
    ['missing status', { status: undefined }],
  ]
  for (const [name, patch] of invalid) {
    it(`refuses ${name}`, async () => {
      fs.writeFileSync(file, JSON.stringify({ ...valid(), ...patch }))
      await expect(readDemoState(file)).rejects.toThrow(/Demo state is invalid/)
    })
  }

  it('refuses a file that is not JSON', async () => {
    fs.writeFileSync(file, '{not json')
    await expect(readDemoState(file)).rejects.toThrow()
  })
})

describe('demoControl', () => {
  function answer(body: unknown, status = 200) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('asks status with GET on loopback, sending the token and refusing redirects', async () => {
    const state = valid()
    const fetchMock = answer({ ...state, status: 'ready' })
    await expect(demoControl(state, 'status')).resolves.toEqual(state)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`http://127.0.0.1:${state.controlPort}/status`)
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['x-walnut-demo-token']).toBe(state.token)
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('asks stop with POST and returns the stopped state', async () => {
    const state = valid()
    const fetchMock = answer({ ...state, status: 'stopped' })
    await expect(demoControl(state, 'stop')).resolves.toMatchObject({ status: 'stopped' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`http://127.0.0.1:${state.controlPort}/stop`)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['x-walnut-demo-token']).toBe(state.token)
  })

  it('refuses an answer with another token', async () => {
    answer({ ...valid(), token: 'ffffffff-1111-1111-1111-111111111111' })
    await expect(demoControl(valid(), 'status')).rejects.toThrow(/did not prove its Demo identity/)
  })

  it('refuses an answer with another generation', async () => {
    answer({ ...valid(), generation: 'other-generation' })
    await expect(demoControl(valid(), 'stop')).rejects.toThrow(/did not prove its Demo identity/)
  })

  it('refuses an answer with another pid', async () => {
    answer({ ...valid(), pid: 9999 })
    await expect(demoControl(valid(), 'status')).rejects.toThrow(/did not prove its Demo identity/)
  })

  it('refuses an HTTP error even when the body echoes the identity', async () => {
    answer({ ...valid(), status: 'failed', error: 'Demo session did not confirm its stop; data was kept' }, 409)
    await expect(demoControl(valid(), 'stop')).rejects.toThrow(/did not confirm its stop/)
    answer(valid(), 500)
    await expect(demoControl(valid(), 'status')).rejects.toThrow()
  })

  it('refuses a 403 with an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    await expect(demoControl(valid(), 'status')).rejects.toThrow()
  })

  it('refuses when nothing answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(demoControl(valid(), 'status')).rejects.toThrow(/fetch failed/)
  })
})
