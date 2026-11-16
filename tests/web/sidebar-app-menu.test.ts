/**
 * The sidebar's right-click menu on an app (web/src/components/layout/sidebar-app-menu.ts): every
 * app with a page of its own, of every kind and in either group (its own row or the Open group),
 * offers "Open in new window" first; Home (the console itself) and a phone never do.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildSidebarAppMenu, type SidebarAppMenuActions } from '../../web/src/components/layout/sidebar-app-menu.js'
import type { AppKind, RegisteredApp } from '../../web/src/apps/registry.js'
import type { ContextMenuItem } from '../../web/src/utils/context-menu.js'

// The built-in apps, read from their source without loading every page it imports.
const CORE_SRC = fs.readFileSync(path.resolve(__dirname, '../../web/src/apps/core-app-list.ts'), 'utf8')
const CORE_APPS = [...CORE_SRC.slice(CORE_SRC.indexOf('export const CORE_APPS')).matchAll(/id: '([^']+)', title: '([^']+)', path: '([^']+)'/g)]
  .map((m) => ({ id: m[1]!, title: m[2]!, path: m[3]! }))

function app(kind: AppKind, id: string, p: string, extra: Partial<RegisteredApp> = {}): RegisteredApp {
  const key = kind === 'core' ? `core:${id}` : kind === 'webview' ? `webview:${id}` : `walnut-drawing:${id}`
  return {
    key, id, owner: kind === 'core' ? 'core' : 'walnut-drawing', kind, title: id, path: p, routeId: id,
    badge: null, order: 0, fullBleed: true, placement: 'sidebar', persistent: false, lockVisibility: false,
    generation: 1, ...extra,
  }
}

const actions = (): SidebarAppMenuActions => ({
  openWindow: vi.fn(), keepOnSidebar: vi.fn(), closeOpen: vi.fn(), move: vi.fn(),
  resetOrder: vi.fn(), unpin: vi.fn(), hide: vi.fn(), manage: vi.fn(),
})

/** The rows the menu shows, in order: `when: false` rows and the section label left out. */
const shown = (items: ContextMenuItem[]) => items.filter((i) => i.when !== false && !i.section)

const native = app('native', 'main', '/apps/walnut-drawing~main')
const webview = app('webview', 'board', '/apps/board')
const core = CORE_APPS.map((c) => app('core', c.id, c.path, { lockVisibility: c.id === 'home' || c.id === 'apps' || c.id === 'settings' }))

describe('Open in new window', () => {
  it('reads the built-in apps from the source (the scanner sees them)', () => {
    expect(core.map((c) => c.id)).toEqual(expect.arrayContaining(['home', 'notes', 'calendar', 'tasks', 'settings', 'apps']))
  })

  const withPage = [...core.filter((c) => c.path !== '/'), native, webview]

  it.each(withPage.map((a) => [a.key, a] as const))('is the first row for %s on its own sidebar row', (_key, a) => {
    const sidebar = [core[0]!, a, webview === a ? native : webview]
    const act = actions()
    const items = buildSidebarAppMenu(a, { sidebar, open: [], phone: false }, act)
    expect(items[0]).toMatchObject({ section: true, label: a.title })
    const first = shown(items)[0]!
    expect(first).toMatchObject({ key: 'open-window', label: 'Open in new window' })
    first.onSelect!()
    expect(act.openWindow).toHaveBeenCalledWith(a)
  })

  it.each(withPage.map((a) => [a.key, a] as const))('is the first row for %s in the Open group', (_key, a) => {
    const items = buildSidebarAppMenu(a, { sidebar: [core[0]!], open: [a], phone: false }, actions())
    expect(shown(items).map((i) => i.key)).toEqual(['open-window', undefined, 'keep', 'close', undefined, 'manage'])
  })

  it('is not offered for Home, nor on a phone', () => {
    const home = core.find((c) => c.path === '/')!
    expect(buildSidebarAppMenu(home, { sidebar: [home, native], open: [], phone: false }, actions()).some((i) => i.key === 'open-window')).toBe(false)
    expect(buildSidebarAppMenu(native, { sidebar: [home, native], open: [], phone: true }, actions()).some((i) => i.key === 'open-window')).toBe(false)
  })

  it('leaves the rest of the menu as it was', () => {
    const items = buildSidebarAppMenu(native, { sidebar: [core[0]!, native, webview], open: [], phone: false }, actions())
    expect(shown(items).map((i) => i.key ?? '-')).toEqual(['open-window', '-', 'up', 'down', 'reset-order', '-', 'unpin', 'hide', '-', 'manage'])
  })

  it('the sidebar builds its app menu from this one builder, and opens the app window', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../web/src/components/layout/Sidebar.tsx'), 'utf8')
    expect(src).toMatch(/buildSidebarAppMenu\(/)
    expect(src).toMatch(/openWindow: \(item\) => \{ openAppWindow\(item\.key\); \}/)
    expect(src).not.toMatch(/key: 'keep', label:/)
  })
})
