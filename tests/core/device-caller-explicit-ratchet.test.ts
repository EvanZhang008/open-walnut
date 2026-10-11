/**
 * Every route names its caller (core/device-auth.ts). The operator's entry
 * points (createDevice, revokeDevice, revokePairing, setCompanionOwner) take no caller and
 * apply no rule: they are the `walnut device` CLI and the setup claim. A route
 * that reached one would hand any request the operator's power, which is what
 * an optional `by` defaulting to "this machine" did before (fail-open: a call
 * that forgot the argument was allowed everything).
 *
 * So: nothing under src/web calls them, and the callers' entry points cannot
 * be called without `by` (the @ts-expect-error lines fail the type-check if
 * the argument ever becomes optional again).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createDeviceAs, revokeDeviceAs, revokePairingAs, rotateDevice, apiKeyMaker } from '../../src/core/device-auth.js'

const ROOT = path.resolve(__dirname, '../..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(p))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('device changes from a route always name the caller', () => {
  it('nothing under src/web uses the operator\'s entry points', () => {
    const offenders: string[] = []
    for (const file of sources(path.join(ROOT, 'src/web'))) {
      // Code lines only: a comment line may name an entry point (push.ts says
      // which one every revoke runs through). A line that starts as a comment
      // holds no call; every other line is checked whole.
      const text = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')
      for (const name of ['createDevice', 'revokeDevice', 'revokePairing', 'setCompanionOwner']) {
        if (new RegExp(`\\b${name}\\b(?!As)`).test(text)) offenders.push(`${path.relative(ROOT, file)}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('the callers\' entry points require `by` (checked by the type-check)', () => {
    const never = (f: () => unknown) => typeof f
    // @ts-expect-error the caller is required
    expect(never(() => createDeviceAs('x', {}))).toBe('function')
    // @ts-expect-error the caller is required
    expect(never(() => rotateDevice('x', {}))).toBe('function')
    // @ts-expect-error the caller is required
    expect(never(() => revokeDeviceAs('x', {}))).toBe('function')
    // @ts-expect-error the caller is required
    expect(never(() => revokePairingAs('x', {}))).toBe('function')
    // @ts-expect-error the caller is required
    expect(never(() => apiKeyMaker())).toBe('function')
  })
})
