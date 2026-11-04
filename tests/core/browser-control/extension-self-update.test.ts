/**
 * The extension's own update (packages/browser-extension/src/self-update.ts): an unpacked copy
 * whose build is older than the one Walnut ships reloads itself once for that build; a store
 * copy, a copy Walnut cannot reach, a copy already current, or one that already reloaded for
 * that build does nothing. The browser API is a fake; Walnut's answer is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  local: {} as Record<string, unknown>,
  versionName: '0.6.25 build aaaaaa111111' as string | undefined,
  installType: 'development',
  reloads: 0,
}
;(globalThis as any).chrome = {
  runtime: { getManifest: () => ({ version: '0.6.25', name: 'Walnut', version_name: state.versionName }), reload: () => { state.reloads++ }, onStartup: { addListener() {} } },
  management: { getSelf: async () => ({ installType: state.installType }) },
  storage: { local: { get: async (k: string) => ({ [k]: state.local[k] }), set: async (o: Record<string, unknown>) => { Object.assign(state.local, o) } } },
  alarms: { create() {}, onAlarm: { addListener() {} } },
}

const api = vi.hoisted(() => ({ build: 'bbbbbb222222' as string | undefined, connected: true, fails: false }))
vi.mock('../../../packages/browser-extension/src/walnut-api', () => ({
  connection: async () => (api.connected ? { serverUrl: 'http://localhost:3456', token: 't', device: 'd' } : null),
  call: async () => { if (api.fails) throw new Error('unreachable'); return api.build ? { panel: 1, extension: { version: '0.6.25', build: api.build } } : { panel: 1 } },
}))

const { selfUpdate, buildOf } = await import('../../../packages/browser-extension/src/self-update')

beforeEach(() => {
  state.local = {}; state.versionName = '0.6.25 build aaaaaa111111'; state.installType = 'development'; state.reloads = 0
  api.build = 'bbbbbb222222'; api.connected = true; api.fails = false
})

describe('the extension updates itself from the folder Walnut keeps', () => {
  it('an unpacked copy with an older build reloads, once for that build', async () => {
    await selfUpdate(true)
    expect(state.reloads).toBe(1)
    expect(state.local.reloadedFor).toBe('bbbbbb222222')
    // Still old after the reload (a copy from a folder Walnut does not keep): no second reload.
    await selfUpdate(true)
    expect(state.reloads).toBe(1)
    // A newer build again: one more.
    api.build = 'cccccc333333'
    await selfUpdate(true)
    expect(state.reloads).toBe(2)
  })

  it.each([
    ['a store copy', () => { state.installType = 'normal' }],
    ['a copy already on Walnut\'s build', () => { api.build = 'aaaaaa111111' }],
    ['a copy built before builds were named', () => { state.versionName = undefined }],
    ['an older Walnut that names no build', () => { api.build = undefined }],
    ['a copy not connected to Walnut', () => { api.connected = false }],
    ['Walnut not answering', () => { api.fails = true }],
  ])('%s does nothing', async (_name, arrange) => {
    arrange()
    await selfUpdate(true)
    expect(state.reloads).toBe(0)
  })

  it('asks at most every ten minutes unless forced', async () => {
    await selfUpdate(true)
    api.build = 'dddddd444444'
    await selfUpdate()
    expect(state.reloads).toBe(1)
  })

  it('reads the build from version_name', () => {
    expect(buildOf('0.6.25 build 0123456789ab')).toBe('0123456789ab')
    expect(buildOf('0.6.25')).toBeNull()
  })
})
