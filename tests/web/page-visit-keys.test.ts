/**
 * Every page and Settings pane the web app can show has a page-use key
 * (web/src/api/page-visits.ts), so a new one is counted without anyone remembering to,
 * and Settings > Page Use lists it under Never opened until it is opened.
 *
 * The core apps and panes are read from their source files, the way the repo's other
 * ratchets enumerate members, so a new entry joins this check by itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { pageKeyForPath, settingsVisitKey } from '../../web/src/api/page-visits.js'
import { knownPlaces } from '../../web/src/components/settings/sections/page-use-model.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** `{ id: 'notes', title: 'Notes', path: '/notes', … }` entries of CORE_APPS. */
function coreApps(): Array<{ id: string; title: string; path: string }> {
  const src = read('web/src/apps/core-apps.tsx')
  return [...src.matchAll(/id: '([^']+)', title: '([^']+)', path: '([^']+)'/g)].map((m) => ({ id: m[1]!, title: m[2]!, path: m[3]! }))
}

/** `owner: 'walnut', id: 'x', label: 'X', …, navHidden: true?` entries of the Settings registry. */
function corePanes(): Array<{ id: string; label: string; navHidden: boolean }> {
  const src = read('web/src/components/settings/core-settings-registry.tsx')
  return [...src.matchAll(/owner: 'walnut', id: '([^']+)', label: '([^']+)'[^\n]*/g)]
    .map((m) => ({ id: m[1]!, label: m[2]!, navHidden: /navHidden: true/.test(m[0]) }))
}

describe('every page and Settings pane has a visit key', () => {
  it('maps routes to keys', () => {
    expect(pageKeyForPath('/')).toBe('page:home')
    expect(pageKeyForPath('/org')).toBe('page:org')
    expect(pageKeyForPath('/tasks/abc-123')).toBe('page:task')
    expect(pageKeyForPath('/apps/walnut-time~main/x')).toBe('app:walnut-time~main')
    expect(pageKeyForPath('/settings')).toBeNull()
    expect(settingsVisitKey('mail:rules')).toBe('settings:mail~rules')
  })

  it('a new core app or Settings pane is counted without anyone remembering to', () => {
    const apps = coreApps()
    const panes = corePanes()
    expect(apps.length).toBeGreaterThan(5)
    expect(panes.length).toBeGreaterThan(15)
    for (const app of apps) {
      if (app.path === '/settings') continue
      expect(pageKeyForPath(app.path), app.id).not.toBeNull()
    }
    for (const pane of panes) expect(settingsVisitKey(pane.id), pane.id).not.toBeNull()
  })
})

describe('the Page Use list of places', () => {
  it('names every core app and visible pane once, and leaves hidden panes out', () => {
    const panes = corePanes()
    const keys = knownPlaces(coreApps(), panes).map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of ['page:home', 'page:org', 'page:memory', 'settings:sessions', 'settings:page-use']) expect(keys).toContain(k)
    for (const pane of panes.filter((p) => p.navHidden)) expect(keys).not.toContain(`settings:${pane.id}`)
    expect(keys).not.toContain('page:settings')
    expect(keys).not.toContain('page:skills')
  })
})
