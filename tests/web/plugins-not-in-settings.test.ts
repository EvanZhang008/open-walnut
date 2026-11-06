/**
 * Guard: no plugin has a row, a group or a pane in Settings. Every plugin, its settings
 * panels and its sign-in live on its page in Apps (2026-11-05, the user: "plugin shodl be all
 * in apps, and app is not in seting"; Settings had a Plugins group with an Apps link and one
 * plugin's token and sign-in page as its own entry).
 *
 * The class is "a way a plugin puts something into the Settings page". Its members, read
 * from the source so a new one fails here until it is placed:
 *   - every method of the plugin web API's `WebUiService` (packages/plugin-api), each mapped
 *     to the surface it draws on; `settings` must draw on the plugin's Apps page;
 *   - every kind the web plugin UI registry keeps (web/src/plugins/registry.ts);
 *   - every slot target (none may be inside Settings);
 *   - the Settings shell files, which may not read any plugin registry or the App catalog;
 *   - the Settings registry, whose every entry is Walnut's own and in a non-plugin group.
 * The browser half (a real old-API plugin's panel shows in Apps, not Settings, and its old
 * link forwards) is in tests/e2e/browser/native-plugin.spec.ts and apps-page.spec.ts.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CORE_SETTINGS_CONTRIBUTIONS } from '../../web/src/components/settings/core-settings-registry'
import { NAV_GROUPS } from '../../web/src/components/settings/SettingsNav'
import { legacyPluginTarget, NAV_OWNER, resolvePane, RETIRED_PANES, ROW_TARGETS, settingsHashMovedTo } from '../../web/src/components/settings/settings-routing'
import * as legacyLinks from '../../web/src/components/settings/settings-legacy-links'
import { PLUGIN_SLOT_TARGETS } from '../../web/src/plugins/types'
import { panelHeading } from '../../web/src/components/apps-page/PluginSettingsPanels'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8')

/** Where each plugin web UI method draws. Settings is never one of them. */
const UI_METHOD_SURFACE: Readonly<Record<string, string>> = {
  app: 'the main side bar or the Apps page',
  page: "the plugin's own route",
  settings: "the plugin's page in Apps (components/apps-page/PluginSettingsPanels.tsx)",
  slot: 'a task, session or status item (PLUGIN_SLOT_TARGETS)',
  link: 'the right-click menu of a link',
  injectCss: 'a stylesheet, no surface',
  useView: 'state, no surface',
  useDraft: 'state, no surface',
}

function interfaceMethods(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`)
  expect(start, `${name} not found`).toBeGreaterThan(-1)
  const end = source.indexOf('\n}', start)
  const body = source.slice(start, end)
  return [...body.matchAll(/^ {2}(\w+)\??[<(]/gm)].map((m) => m[1]!)
}

describe('plugins are never in Settings', () => {
  it('every plugin web UI method is placed, and none draws in Settings', () => {
    const methods = interfaceMethods(read('packages/plugin-api/src/web.ts'), 'WebUiService')
    expect(methods.length).toBeGreaterThan(5)
    for (const method of methods) {
      expect(UI_METHOD_SURFACE[method], `walnut.ui.${method} is new: say where it draws (never Settings)`).toBeDefined()
      expect(UI_METHOD_SURFACE[method]).not.toMatch(/^Settings|the Settings page/)
    }
  })

  it('the web plugin UI registry keeps only known kinds, and its settings panels render in Apps', () => {
    const registry = read('web/src/plugins/registry.ts')
    const kinds = /type Kind = ([^\n]+)/.exec(registry)?.[1]?.match(/'(\w+)'/g)?.map((k) => k.slice(1, -1))
    expect(kinds).toEqual(['pages', 'settings', 'slots'])
    // The one reader of the settings panels is the Apps page's panel host.
    expect(read('web/src/components/apps-page/PluginSettingsPanels.tsx')).toContain('pluginUi.settings')
    expect(read('web/src/components/apps-page/PluginDetail.tsx')).toContain('<PluginSettingsPanels')
  })

  it('no slot target is inside Settings', () => {
    for (const target of PLUGIN_SLOT_TARGETS) expect(target).not.toMatch(/^settings/)
  })

  it('the Settings shell reads no plugin registry and no App catalog', () => {
    const shell = [
      'web/src/components/settings/SettingsNav.tsx',
      'web/src/pages/SettingsPage.tsx',
      'web/src/components/settings/settings-routing.ts',
      'web/src/components/settings/core-settings-registry.tsx',
      'web/src/components/settings/sections/PageUseSection.tsx',
    ]
    for (const file of shell) {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const banned of ['usePluginUi', 'pluginUi.', 'pluginUiRegistry.', 'registerSettings', 'useAppCatalog(', "group: 'plugins'", 'APPS_LINK_ROW']) {
        // PageUseSection lists Apps by their routes (a visit count), never as Settings rows.
        if (file.endsWith('PageUseSection.tsx') && banned === 'useAppCatalog(') continue
        expect(code.includes(banned), `${file} uses ${banned}`).toBe(false)
      }
    }
  })

  it("every Settings entry is Walnut's own, in a non-plugin group", () => {
    expect(NAV_GROUPS).toEqual(['manage', 'configure', 'diagnostics'])
    for (const entry of CORE_SETTINGS_CONTRIBUTIONS) {
      expect(entry.owner).toBe('walnut')
      expect(NAV_GROUPS).toContain(entry.group)
    }
  })

  it('an old Settings link to a plugin forwards to its page in Apps', () => {
    expect(legacyPluginTarget('#plugin-store')).toBe('/apps')
    expect(legacyPluginTarget('#slack-public-mcp:settings')).toBe('/apps?plugin=slack-public-mcp&panel=settings')
    expect(legacyPluginTarget(`#${encodeURIComponent('walnut-demo:demo')}`)).toBe('/apps?plugin=walnut-demo&panel=demo')
    expect(legacyPluginTarget('walnut.time:main')).toBe('/apps?plugin=walnut.time&panel=main')
    // Walnut's own hashes stay in Settings.
    for (const hash of ['', '#', '#general', '#sessions', '#focus-tiers', '#rh-host-olddev', '#devices-way-cloud', '#a:b:c', '#:x', '#x:']) {
      expect(legacyPluginTarget(hash), hash).toBeNull()
    }
    // A Walnut row whose id has the plugin key's shape stays in Settings (a host alias with a port).
    expect(settingsHashMovedTo(`#rh-host-${encodeURIComponent('box:2222')}`)).toBeNull()
    expect(settingsHashMovedTo('#walnut-demo:demo')).toBe('/apps?plugin=walnut-demo&panel=demo')
    expect(settingsHashMovedTo('#plugin-store')).toBe('/apps')
    expect(settingsHashMovedTo('#general')).toBeNull()
    // And a plugin key is no Settings pane any more.
    expect(resolvePane('#walnut-demo:demo', { silent: true })).toMatchObject({ paneId: 'general', known: false })
  })
})

describe('no text sends anyone to Settings for a plugin', () => {
  // An error, a hint or an API doc that names "Settings, Plugins" points the user (or a plugin
  // author) to a place that no longer exists (2026-11-05: the AI budget errors and the MCP hint
  // still did). docs/plan keeps history and tests may describe the old bug, so neither is read.
  it('the product, its packages and its reference docs never name Settings, Plugins', () => {
    let out = ''
    try {
      out = execFileSync('git', ['grep', '-n', '-E', 'Settings(, | → | > )Plugins', '--', 'src', 'web/src', 'packages', 'docs/reference', 'examples'], { cwd: ROOT, encoding: 'utf8' }).trim()
    } catch (err) {
      // git grep exits 1 when nothing matches; anything else is a real failure.
      if ((err as { status?: number }).status !== 1) throw err
    }
    expect(out, 'these lines still send people to Settings for a plugin').toBe('')
  }, 20_000)
})

describe("Walnut's own Settings anchors are never taken for an old plugin link", () => {
  // The sidebar's memory (utils/last-location) and the Settings page judge a hash with the one
  // test, legacyPluginTarget; a Walnut row anchor whose free-form part has a colon
  // (`#rh-host-box:2222`) was read as a plugin key and dropped from the memory.
  it('every free-form row prefix resolvePane accepts is shared with the legacy-link test', () => {
    const src = read('web/src/components/settings/settings-routing.ts')
    const body = src.slice(src.indexOf('export function resolvePane'), src.indexOf('\n}\n', src.indexOf('export function resolvePane')))
    const names = [...body.matchAll(/id\.startsWith\((\w+)\)/g)].map((m) => m[1]!)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const value = (legacyLinks as Record<string, unknown>)[name]
      expect(typeof value, `${name} must be exported by settings-legacy-links.ts`).toBe('string')
      const sample = `${value as string}box:2222`
      expect(resolvePane(`#${encodeURIComponent(sample)}`, { silent: true }).known, sample).toBe(true)
      expect(legacyPluginTarget(`#${encodeURIComponent(sample)}`), sample).toBeNull()
    }
    // The other free-form branches: the Phones & Cloud ways and their rows.
    for (const sample of ['devices-way-panel-cloud', 'companion-keep-a:b', 'remote-access-x:1']) {
      expect(legacyPluginTarget(`#${sample}`), sample).toBeNull()
    }
  })

  it('no fixed Settings id reads as a plugin key', () => {
    for (const id of [...Object.keys(NAV_OWNER), ...Object.keys(ROW_TARGETS), ...Object.keys(RETIRED_PANES)]) {
      expect(legacyPluginTarget(`#${id}`), id).toBeNull()
    }
  })
})

describe("a plugin panel's heading on its Apps page", () => {
  it('is left out when the plugin name already says it', () => {
    expect(panelHeading('Plugin Demo', 'Walnut Plugin Demo')).toBeNull()
    expect(panelHeading('Slack MCP server (public)', 'Slack MCP server (public)')).toBeNull()
    expect(panelHeading('Slack', 'Slack MCP server')).toBeNull()
    expect(panelHeading('Settings', 'Acme')).toBeNull()
    expect(panelHeading('  ', 'Acme')).toBeNull()
  })
  it('is shown when it names a part of the plugin', () => {
    expect(panelHeading('Account', 'Time')).toBe('Account')
    expect(panelHeading('Sign-in', 'Slack MCP server (public)')).toBe('Sign-in')
  })
})
