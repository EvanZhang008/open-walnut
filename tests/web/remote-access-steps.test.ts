/**
 * The "Reach Walnut from anywhere" card's three steps
 * (web/src/components/settings/sections/cloud/remote-access-steps.ts): every
 * state of the Mac, phone and pairing rows, and the poll interval.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveRemoteAccessSteps, hasPairedPhone, isPhonePeer, pollIntervalMs,
  type PairedDeviceLike, type TailscaleDetailResponse,
} from '../../web/src/components/settings/sections/cloud/remote-access-steps.js'

const base: TailscaleDetailResponse = { installed: false, running: false, peers: [], install: { brew: true, macOS: true, job: null } }
const status = (over: Partial<TailscaleDetailResponse> = {}): TailscaleDetailResponse => ({ ...base, ...over })
const running = (over: Partial<TailscaleDetailResponse> = {}) =>
  status({ installed: true, running: true, dnsName: 'studio-mac.tail1234.ts.net', address: '100.101.102.103', ...over })
const IPHONE = { hostName: 'pocket-phone', os: 'iOS', online: true }
const PHONE: PairedDeviceLike = { name: 'Work-phone', role: 'phone', info: { model: 'iPhone18,2', os: 'iOS 26.1' } }

describe('step 1: Tailscale on this Mac', () => {
  it('before the first answer: checking (muted); after a failed first read: unknown (muted)', () => {
    expect(deriveRemoteAccessSteps(null, []).mac).toMatchObject({ dot: 'pending', kind: 'checking', canBrew: false })
    expect(deriveRemoteAccessSteps(null, [], { failed: true }).mac).toMatchObject({ dot: 'pending', kind: 'unknown' })
  })

  it('not installed: your turn, Homebrew offered only when brew exists', () => {
    expect(deriveRemoteAccessSteps(status(), []).mac).toEqual({ dot: 'action', kind: 'not-installed', macOS: true, canBrew: true, logTail: [] })
    expect(deriveRemoteAccessSteps(status({ install: { brew: false, job: null } }), []).mac.canBrew).toBe(false)
  })

  it('off macOS: no Homebrew even when brew exists, and the card says "this computer" (macOS flag false); an older server without the flag reads as a Mac', () => {
    expect(deriveRemoteAccessSteps(status({ install: { brew: true, macOS: false, job: null } }), []).mac)
      .toEqual({ dot: 'action', kind: 'not-installed', macOS: false, canBrew: false, logTail: [] })
    expect(deriveRemoteAccessSteps(status({ installed: true, install: { brew: false, macOS: false, job: null } }), []).mac.macOS).toBe(false)
    expect(deriveRemoteAccessSteps(status({ install: { brew: true, job: null } }), []).mac).toMatchObject({ macOS: true, canBrew: true })
    expect(deriveRemoteAccessSteps(null, []).mac.macOS).toBe(true)
  })

  it('installing: the last three log lines, no buttons', () => {
    const job = { state: 'running' as const, startedAt: '2026-10-01T10:00:00Z', log: ['a', 'b', 'c', 'd', 'e'] }
    expect(deriveRemoteAccessSteps(status({ install: { brew: true, job } }), []).mac)
      .toEqual({ dot: 'action', kind: 'installing', macOS: true, canBrew: false, logTail: ['c', 'd', 'e'] })
  })

  it('a failed install keeps both buttons and its sentence; a finished one shows nothing extra', () => {
    const failed = { state: 'failed' as const, startedAt: '2026-10-01T10:00:00Z', log: ['x'], error: 'Homebrew could not install Tailscale.' }
    expect(deriveRemoteAccessSteps(status({ install: { brew: true, job: failed } }), []).mac)
      .toEqual({ dot: 'action', kind: 'not-installed', macOS: true, canBrew: true, logTail: [], installError: 'Homebrew could not install Tailscale.' })
    const done = { ...failed, state: 'done' as const, error: undefined }
    expect(deriveRemoteAccessSteps(status({ install: { brew: true, job: done } }), []).mac).not.toHaveProperty('installError')
  })

  it('installed, not running: your turn, with the sign-in link when the CLI printed one', () => {
    expect(deriveRemoteAccessSteps(status({ installed: true }), []).mac).toEqual({ dot: 'action', kind: 'not-running', macOS: true, canBrew: false, logTail: [] })
    expect(deriveRemoteAccessSteps(status({ installed: true, loginUrl: 'https://login.tailscale.com/a/1' }), []).mac.loginUrl)
      .toBe('https://login.tailscale.com/a/1')
    // An old failed job does not haunt an installed Mac.
    const failed = { state: 'failed' as const, startedAt: '2026-10-01T10:00:00Z', log: [], error: 'old' }
    expect(deriveRemoteAccessSteps(status({ installed: true, install: { brew: true, job: failed } }), []).mac).not.toHaveProperty('installError')
  })

  it('running: done, connected as the MagicDNS name, else the address', () => {
    expect(deriveRemoteAccessSteps(running(), []).mac).toMatchObject({ dot: 'done', kind: 'running', connectedAs: 'studio-mac.tail1234.ts.net' })
    expect(deriveRemoteAccessSteps(running({ dnsName: undefined }), []).mac.connectedAs).toBe('100.101.102.103')
    expect(deriveRemoteAccessSteps(running({ dnsName: undefined, address: undefined }), []).mac).not.toHaveProperty('connectedAs')
  })
})

describe('step 2: Tailscale on your phone', () => {
  it('muted until this Mac is on the tailnet (no peers are visible before), stores hidden', () => {
    for (const s of [null, status(), status({ installed: true })]) {
      expect(deriveRemoteAccessSteps(s, []).phone).toMatchObject({ dot: 'pending', showStores: false })
    }
  })

  it('Mac on the tailnet, no phone: your turn with the stores; a laptop peer does not count', () => {
    expect(deriveRemoteAccessSteps(running({ peers: [{ hostName: 'build-box', os: 'linux', online: true }] }), []).phone)
      .toEqual({ dot: 'action', showStores: true, detectable: true })
  })

  it('a phone that is signed in but offline is named, and the step stays open', () => {
    expect(deriveRemoteAccessSteps(running({ peers: [{ hostName: 'old-tablet', os: 'android', online: false }] }), []).phone)
      .toEqual({ dot: 'action', showStores: true, detectable: true, offlinePhone: 'old-tablet' })
  })

  it('an online iOS or Android peer: done, named', () => {
    expect(deriveRemoteAccessSteps(running({ peers: [IPHONE] }), []).phone).toEqual({ dot: 'done', showStores: false, detectable: true, onlinePhone: 'pocket-phone' })
    expect(deriveRemoteAccessSteps(running({ peers: [{ hostName: 'pixel', os: 'android', online: true }] }), []).phone.onlinePhone).toBe('pixel')
  })

  it('a Mac on another tailnet client (no Tailscale CLI, a 100.x address): step 1 done, the phone cannot be seen, so the poll slows', () => {
    const other = deriveRemoteAccessSteps(status({ running: true, address: '100.80.1.2' }), [])
    expect(other.mac).toMatchObject({ dot: 'done', connectedAs: '100.80.1.2' })
    expect(other.phone).toEqual({ dot: 'action', showStores: true, detectable: false })
    expect(pollIntervalMs(other)).toBe(60_000)
  })

  it('isPhonePeer: iOS, iPadOS, Android in any case; nothing else', () => {
    expect(['iOS', 'ios', 'iPadOS', 'android', 'Android'].map((os) => isPhonePeer({ hostName: 'x', os, online: true }))).toEqual([true, true, true, true, true])
    expect(['macOS', 'linux', 'windows', '', 'tvOS'].map((os) => isPhonePeer({ hostName: 'x', os, online: true }))).toEqual([false, false, false, false, false])
  })
})

describe('step 3: pair the phone', () => {
  it('already paired: done whatever the other steps say, and the row picks nothing', () => {
    for (const s of [null, status(), running()]) {
      expect(deriveRemoteAccessSteps(s, [PHONE]).pair).toEqual({ dot: 'done', paired: true, canChooseTailnet: false })
    }
  })

  it('not paired: muted until the Mac and the phone are on the tailnet, then your turn', () => {
    expect(deriveRemoteAccessSteps(status(), []).pair).toEqual({ dot: 'pending', paired: false, canChooseTailnet: false })
    // Mac on the tailnet, phone not yet: still muted, but the address can already be picked.
    expect(deriveRemoteAccessSteps(running(), []).pair).toEqual({ dot: 'pending', paired: false, canChooseTailnet: true })
    expect(deriveRemoteAccessSteps(running({ peers: [IPHONE] }), []).pair).toEqual({ dot: 'action', paired: false, canChooseTailnet: true })
    // The picker does not offer the tailnet address (yet): nothing to pick.
    expect(deriveRemoteAccessSteps(running({ peers: [IPHONE] }), [], { tailnetOffered: false }).pair.canChooseTailnet).toBe(false)
  })

  it('while the device list loads, nothing counts as paired', () => {
    expect(deriveRemoteAccessSteps(running({ peers: [IPHONE] }), null).pair).toMatchObject({ dot: 'action', paired: false })
  })

  it('hasPairedPhone: iOS or Android by self-report or platform, any real device with no platform, never this Mac or a simulator', () => {
    expect(hasPairedPhone([])).toBe(false)
    expect(hasPairedPhone([PHONE])).toBe(true)
    expect(hasPairedPhone([{ name: 'p', platform: 'ios' }])).toBe(true)
    expect(hasPairedPhone([{ name: 'p', info: { os: 'Android 15' } }])).toBe(true)
    expect(hasPairedPhone([{ name: 'Kitchen-tablet', role: 'phone' }])).toBe(true)
    expect(hasPairedPhone([{ name: 'p' }])).toBe(true)
    expect(hasPairedPhone([{ name: 'this-mac-sync', role: 'self' }, { name: 'dev-sim', role: 'simulator', info: { os: 'iOS 26.0' } }])).toBe(false)
    expect(hasPairedPhone([{ name: 'laptop', role: 'phone', platform: 'macos', info: { os: 'macOS 26' } }])).toBe(false)
  })
})

describe('all three and the poll', () => {
  it('allDone only when every row is green; 5s while the Mac or phone step is open, 60s once both are done', () => {
    const fresh = deriveRemoteAccessSteps(status(), [])
    expect(fresh.allDone).toBe(false)
    expect(pollIntervalMs(fresh)).toBe(5_000)
    expect(pollIntervalMs(deriveRemoteAccessSteps(status({ installed: true }), []))).toBe(5_000)
    expect(pollIntervalMs(deriveRemoteAccessSteps(running(), [PHONE]))).toBe(5_000)
    const both = deriveRemoteAccessSteps(running({ peers: [IPHONE] }), [])
    expect(both.allDone).toBe(false)
    expect(pollIntervalMs(both)).toBe(60_000)
    const done = deriveRemoteAccessSteps(running({ peers: [IPHONE] }), [PHONE])
    expect(done.allDone).toBe(true)
    expect(pollIntervalMs(done)).toBe(60_000)
  })
})
