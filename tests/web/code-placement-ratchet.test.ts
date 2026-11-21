/**
 * Every QR code and sign-in code in Settings > Phones & Cloud lives on the tab of the way it uses
 * (2026-11-21, the user, paraphrased: a code for the tunnel goes on the tunnel's tab, a QR for
 * the Walnut app through the cloud companion goes on the companion's tab, so people know).
 * Before, a Wi-Fi phone QR and a Wi-Fi browser code sat on All devices, which names no way, and the user could not tell which path a code used (2026-11-18: "this concept is
 * very confusing").
 *
 * The rule, enumerated from the source so a new way or a new code entry fails here until it is
 * placed: each way's tab pairs the Walnut app only through that way's own address, All devices
 * pairs nothing on the Mac, every anchor of a code entry opens its way's tab, and the browser
 * sign-in rows render only on their way's tab.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DEVICES_TAB, WAY_PANES, wayPaneForRow } from '../../web/src/components/settings/settings-way-panes'
import { pairTargetForScope, type DeviceScope } from '../../web/src/components/settings/sections/cloud/device-scope'
import type { PairTargetKind } from '../../web/src/components/settings/sections/cloud/usePairDevice'

const web = (p: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src', p), 'utf8')

/** The address each way's app QR carries; null for a way that signs in browsers only. */
const WAY_TARGET: Record<keyof typeof WAY_PANES, PairTargetKind | null> = {
  cloud: 'cloud',
  tailscale: 'tailnet',
  browser: null,
  wifi: 'lan',
}

const OFFERED: readonly PairTargetKind[][] = [[], ['lan'], ['lan', 'cloud'], ['lan', 'tailnet'], ['lan', 'tailnet', 'cloud']]

describe('codes live on the tab of the way they use', () => {
  it('every way is placed: a new way fails here until its QR target is named', () => {
    expect(Object.keys(WAY_PANES).sort()).toEqual(Object.keys(WAY_TARGET).sort())
  })

  it("each way's tab pairs the Walnut app only through its own address", () => {
    for (const way of Object.keys(WAY_PANES) as (keyof typeof WAY_PANES)[]) {
      for (const offered of OFFERED) {
        expect(pairTargetForScope(way as DeviceScope, offered), `${way} with ${offered.join(',') || 'nothing'} offered`).toBe(WAY_TARGET[way])
      }
    }
  })

  it('All devices names no way, so on the Mac it pairs nothing', () => {
    for (const offered of OFFERED) expect(pairTargetForScope('all', offered)).toBeNull()
  })

  it("every code entry's anchor opens its way's tab", () => {
    for (const way of Object.keys(WAY_TARGET) as (keyof typeof WAY_PANES)[]) {
      if (WAY_TARGET[way] === null) continue
      expect(wayPaneForRow(`way-pair-${way}`), `way-pair-${way}`).toBe(WAY_PANES[way])
    }
    expect(wayPaneForRow('devices-wifi-browser')).toBe(WAY_PANES.wifi)
    expect(wayPaneForRow('devices-wifi-sign-in')).toBe(WAY_PANES.wifi)
    expect(wayPaneForRow('browser-access-code')).toBe(WAY_PANES.browser)
    // All devices keeps only the companion console's own pairing.
    expect(wayPaneForRow('way-pair-all')).toBe(DEVICES_TAB)
  })

  it('the browser sign-in rows render only on their own way', () => {
    // The Wi-Fi browser code: only DeviceList draws it, and only for the Same Wi-Fi scope.
    const users = ['components/settings/sections/cloud/DeviceList.tsx']
    const list = web(users[0])
    expect(list).toMatch(/const wifiSignIn = scope === 'wifi' &&/)
    expect(list.match(/<WifiSignInRow\b/g)).toHaveLength(1)
    // The tunnel's sign-in link: only the tunnel's tab mounts BrowserAccessGroup.
    const way = web('components/settings/sections/DevicesWaySection.tsx')
    expect(way).toMatch(/way === 'browser' \? <BrowserAccessGroup[ />]/)
    // No other file draws either one.
    const all = walk(path.resolve(import.meta.dirname, '../../web/src'))
    const drawers = (tag: string) => all.filter((f) => new RegExp(`<${tag}\\b`).test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(path.resolve(import.meta.dirname, '../../web/src'), f))
    expect(drawers('WifiSignInRow')).toEqual(users)
    expect(drawers('BrowserAccessGroup')).toEqual(['components/settings/sections/DevicesWaySection.tsx'])
  })
})

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx$/.test(e.name) ? [p] : []
  })
}
