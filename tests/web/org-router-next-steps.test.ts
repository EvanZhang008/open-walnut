/**
 * Round-two review fixes for a router's page: its settings read the area's accounts again when they
 * open (a Mail choice adds one on the server), many VPs get a finder, Mail's "Open router" lands on a
 * page that names the message and the next step, and an area id reads as words until its name loads.
 *
 * Render and source checks; the native driver (.put/router-native) walks the same paths in WebKit.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { Task } from '../../src/core/types.js'

const { RouterSettingsBody, linkFilterMatches, mailAccountNames, LINK_FILTER_FROM, ROUTER_SETTINGS_OPEN_EVENT } = await import('../../web/src/components/org/OrgRouterSettings')
const { routerFromMailOf, routerFromMailNext } = await import('../../web/src/components/org/OrgRouterFromMail')
const { areaIdWords, routerLine } = await import('../../web/src/components/org/org-channels-model')

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const noop = () => {}
const vp = (id: string, title: string): Task => ({ id, title, org_role: 'lead', phase: 'IN_PROGRESS' } as unknown as Task)

describe('router settings', () => {
  const leads = Array.from({ length: 12 }, (_, i) => vp(`vp-${i}`, `Pier ${i} VP`))
  const body = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RouterSettingsBody, {
    id: 'org-router-settings-r', draftKey: null, area: 'Work', value: { name: 'Work router', links: ['vp-3'], paused: false },
    leads, stale: [], busy: false, error: '', problem: '', dirty: false, justSaved: false, tasksLoading: false,
    onEdit: noop, onToggleLink: noop, onSave: noop, onDiscard: noop, onLinkFilter: noop, ...extra,
  } as Parameters<typeof RouterSettingsBody>[0]))

  it('read the areas again whenever they open, so an account Mail added shows', () => {
    const src = code(read('web/src/components/org/OrgRouterSettings.tsx'))
    expect(src).toMatch(/useEffect\(\(\) => \{ if \(expanded\) refreshRouterAreas\(\); \}, \[expanded, id\]\)/)
    expect(code(read('web/src/components/org/router-area-names.ts'))).toMatch(/export function refreshRouterAreas\(\): void \{\s*queueRead\(\);/)
  })

  it('name a mail account by its address, an unknown one or a Slack team by its id', () => {
    expect(mailAccountNames([{ accountId: 'dense:harbour', address: 'harbour@example.invalid', displayName: 'Harbour mail' }, { accountId: 'x', displayName: 'Only name' }, { accountId: 'y' }]))
      .toEqual({ 'dense:harbour': 'harbour@example.invalid', x: 'Only name' })
    const html = body({ sources: [{ kind: 'mail', account: 'dense:harbour' }, { kind: 'mail', account: 'other' }, { kind: 'slack', account: 'T0FIX' }], sourceNames: { 'dense:harbour': 'harbour@example.invalid', T0FIX: 'no' } })
    expect(html).toContain('data-account="dense:harbour">harbour@example.invalid')
    expect(html).toContain('data-account="other">other')
    expect(html).toContain('data-account="T0FIX">T0FIX')
  })

  it('show a VP finder past LINK_FILTER_FROM VPs, and keep linked VPs in sight whatever is typed', () => {
    expect(body()).toContain('data-testid="org-router-link-filter"')
    expect(body({ leads: leads.slice(0, LINK_FILTER_FROM) })).not.toContain('org-router-link-filter')
    expect(linkFilterMatches(leads, ['vp-3'], ' pier 1').map((l) => l.id)).toEqual(['vp-1', 'vp-3', 'vp-10', 'vp-11'])
    expect(linkFilterMatches(leads, [], '').length).toBe(12)
    const none = body({ linkFilter: 'zzz', value: { name: 'Work router', links: [], paused: false } })
    expect(none).toContain('No VP matches')
    expect(none).not.toContain('data-testid="org-router-link"')
  })
})

describe("Mail's Open router", () => {
  it('hands the router page the message, and only that router reads it', () => {
    const state = { fromMail: { node: 'router:r1', subject: ' Storm plan 4 ', state: 'Handoff not approved · Nothing was delivered' } }
    expect(routerFromMailOf(state, 'router:r1')).toEqual({ node: 'router:r1', subject: 'Storm plan 4', state: 'Handoff not approved · Nothing was delivered' })
    expect(routerFromMailOf(state, 'router:r2')).toBeNull()
    expect(routerFromMailOf(null, 'router:r1')).toBeNull()
    const line = code(read('web/src/apps/mail/MailRouteLine.tsx'))
    expect(line).toContain('state: { fromMail: { node, subject')
    expect(read('web/src/apps/mail/MailReaderHead.tsx')).toContain('subject={message.subject}')
  })

  it('names the next step: Paused off in its settings, else its chat', () => {
    expect(routerFromMailNext('Work router', true)).toBe('Work router is paused, so it reads nothing until you turn Paused off in its settings.')
    expect(routerFromMailNext('Work router', false)).toBe('Ask Work router about it in the chat below.')
    for (const rel of ['web/src/components/org/OrgRouterFromMail.tsx', 'web/src/components/org/OrgNodeStart.tsx']) {
      expect(code(read(rel)), rel).toContain('new CustomEvent(ROUTER_SETTINGS_OPEN_EVENT')
    }
    expect(code(read('web/src/components/org/OrgRouterSettings.tsx'))).toContain('window.addEventListener(ROUTER_SETTINGS_OPEN_EVENT, open)')
    expect(ROUTER_SETTINGS_OPEN_EVENT).toBe('org:router-settings-open')
  })

  it('shows the From Mail line above the settings, and Open settings only while they are folded', () => {
    const detail = code(read('web/src/components/org/OrgNodeDetail.tsx'))
    expect(detail.indexOf('<OrgRouterFromMail')).toBeGreaterThan(-1)
    expect(detail.indexOf('<OrgRouterFromMail')).toBeLessThan(detail.indexOf('<OrgRouterSettings key'))
    expect(code(read('web/src/components/org/OrgRouterFromMail.tsx'))).toContain('paused && !settingsOpen')
    expect(code(read('web/src/components/org/OrgNodeStart.tsx'))).toContain("contact.router_paused !== false && !settingsOpen")
    expect(code(read('web/src/components/org/OrgRouterSettings.tsx'))).toContain('setRouterSettingsOpen(id, expanded)')
  })

  it('puts the scope note and the step in one foot under the reader line', () => {
    expect(code(read('web/src/apps/mail/MailRouteLine.tsx'))).toContain('<div className="mail-route-foot" data-testid="mail-reader-route-foot">{assign}{next}</div>')
  })
})

describe('area names', () => {
  it('read an id as words until the areas list answers', () => {
    expect(areaIdWords('native_fixture')).toBe('Native fixture')
    expect(areaIdWords('work')).toBe('Work')
    expect(routerLine({ router_area_id: 'native_fixture', router_paused: true })).toBe('Native fixture · Paused · 0 VP links')
    expect(routerLine({ router_area_id: 'native_fixture' }, { native_fixture: 'Native Fixture' })).toContain('Native Fixture ·')
  })
})
