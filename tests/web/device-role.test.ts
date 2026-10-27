import { describe, expect, it } from 'vitest'
import { roleOf } from '../../src/web/routes/devices.js'

const at = '2026-10-27T00:00:00Z'
const none = new Set<string>()

describe('roleOf: what a credential is, for the console', () => {
  it('a simulator named sim2-... or reporting the Mac CPU as its model is a simulator', () => {
    expect(roleOf({ name: 'sim2-r23-verify', createdAt: at }, none)).toBe('simulator')
    expect(roleOf({ name: 'gate-a', createdAt: at, info: { model: 'arm64', os: 'iOS 26.0.1' } }, none)).toBe('simulator')
    expect(roleOf({ name: 'gate-b', createdAt: at, info: { model: 'x86_64' } }, none)).toBe('simulator')
    expect(roleOf({ name: 'sim-dogfood', createdAt: at }, none)).toBe('simulator')
  })

  it('a real phone, a name that only starts like sim, and a phone not heard from yet stay phones', () => {
    expect(roleOf({ name: 'iphone', createdAt: at, info: { model: 'iPhone18,2' } }, none)).toBe('phone')
    expect(roleOf({ name: 'simon-phone', createdAt: at }, none)).toBe('phone')
    expect(roleOf({ name: 'desk-phone', createdAt: at }, none)).toBe('phone')
  })

  it('browsers and Macs keep their roles', () => {
    expect(roleOf({ name: 'browser-afab06', createdAt: at }, none)).toBe('browser')
    expect(roleOf({ name: 'studio', createdAt: at, info: { model: 'Mac' } }, none)).toBe('mac')
  })
})
