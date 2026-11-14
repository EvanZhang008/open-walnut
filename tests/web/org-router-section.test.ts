/**
 * The Org list's Routers section (web/src/components/org/OrgRouterSection.tsx). A router is its own
 * Org node (Task.org_role 'router'): not a VP and not a task under one. Its rows come from the page
 * (buildChannels' `routers`), sit after the CEO and every VP, before the folded Archived (2026-11-10,
 * the person: "router should be placed below all VPs"), are options of their own group
 * in the list's listbox, and a click selects the node (the page opens its chat). The heading shows
 * even with no router ("Routers · 0").
 *
 * These are render and source checks; they do not stand in for a check on the real page.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { createElement, isValidElement, type ReactElement, type ReactNode } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import { buildChannels, type AlertProbe, type ChannelRow } from '../../web/src/components/org/org-channels-model.js'

const { OrgRouterSection, routersHeading } = await import('../../web/src/components/org/OrgRouterSection')

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
/** The source with its comments taken out, so a guard reads only code. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const NOW = Date.UTC(2026, 10, 6, 12, 0)
const at = (m: number) => new Date(NOW - m * 60_000).toISOString()

function routerRow(id: string, name: string, extra: Partial<ChannelRow> = {}): ChannelRow {
  return {
    key: `router:${id}`, kind: 'router', project: '', name, contactId: id, contactTitle: name, isLead: false,
    counts: { open: 1, running: 0, needsYou: 0, toRead: 0, waiting: 0 }, state: 'quiet', alerts: [], needs: 0,
    latest: 'support-area · Active · 2 VP links', latestAt: NOW - 5 * 60_000, lastAt: NOW - 5 * 60_000, unread: false,
    ...extra,
  } as ChannelRow
}

const render = (rows: readonly ChannelRow[], selectedKey: string | null = null) =>
  renderToStaticMarkup(createElement(OrgRouterSection, { rows, selectedKey, now: NOW, onSelect: () => {} }))

/** Every element in a tree of function components, each called with its props (none uses hooks). */
function elements(node: ReactNode): ReactElement[] {
  const out: ReactElement[] = []
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (!isValidElement(n)) return
    out.push(n)
    const props = n.props as { children?: ReactNode }
    if (typeof n.type === 'function') walk((n.type as (p: unknown) => ReactNode)(n.props))
    else walk(props.children)
  }
  walk(node)
  return out
}

describe('the Routers section renders router rows as options of their own group', () => {
  it('is a labelled group with the heading and one option per router', () => {
    const html = render([routerRow('r1', 'Support router'), routerRow('r2', 'Billing router', { state: 'parked', latest: 'billing · Paused · 0 VP links' })], 'router:r2')
    expect(html).toMatch(/<div[^>]*role="group"[^>]*aria-label="Routers"/)
    expect(html).toContain(routersHeading(2))
    expect(html).toContain('Routers · 2')
    const options = html.match(/<button[^>]*role="option"[^>]*>/g) ?? []
    expect(options).toHaveLength(2)
    for (const o of options) {
      expect(o).toContain('data-testid="org-channel-router"')
      expect(o).toContain('data-kind="router"')
      // Never the VP row's test id, so nothing counting VP rows counts a router.
      expect(o).not.toContain('data-testid="org-channel"')
    }
    expect(options[0]).toContain('aria-selected="false"')
    expect(options[1]).toContain('aria-selected="true"')
    expect(options[1]).toContain('data-key="router:r2"')
    expect(html).toContain('Billing router')
    expect(html).toContain('billing · Paused · 0 VP links')
    expect(html).toContain('support-area · Active · 2 VP links')
  })

  it('shows "Routers · 0" and no option when there is no router', () => {
    const html = render([])
    expect(html).toContain('Routers · 0')
    expect(html).not.toMatch(/role="option"/)
    expect(html).toMatch(/role="group"/)
  })

  it('a click selects the router node by its key', () => {
    const picked: string[] = []
    const tree = OrgRouterSection({ rows: [routerRow('r1', 'Support router'), routerRow('r2', 'Billing router')], selectedKey: null, now: NOW, onSelect: (k: string) => picked.push(k) })
    const buttons = elements(tree).filter((e) => e.type === 'button')
    expect(buttons).toHaveLength(2)
    ;(buttons[1].props as { onClick: () => void }).onClick()
    expect(picked).toEqual(['router:r2'])
  })

  it('draws only what the row says, never an incoming item\'s words', () => {
    // A row only carries its name and its line; a mail subject left on another field never shows.
    const row = { ...routerRow('r1', 'Support router'), latestTask: 'Private subject from a mail' } as ChannelRow
    expect(render([row])).not.toContain('Private subject from a mail')
  })
})

describe('the Routers section in the Org list', () => {
  const list = read('web/src/components/org/OrgChannelList.tsx')
  const listCode = code(list)
  const section = code(read('web/src/components/org/OrgRouterSection.tsx'))

  it('sits after the CEO and every VP row, before Archived, inside the listbox', () => {
    const listbox = listCode.indexOf('role="listbox"')
    const ceo = listCode.indexOf('<Row row={main}')
    const vps = listCode.indexOf('{shown.map((r) => (')
    const routers = listCode.indexOf('<OrgRouterSection')
    const archived = listCode.indexOf('<MovedSection moved=')
    expect(listbox).toBeGreaterThan(-1)
    expect(ceo).toBeGreaterThan(listbox)
    expect(vps).toBeGreaterThan(ceo)
    expect(routers).toBeGreaterThan(vps)
    expect(archived).toBeGreaterThan(routers)
    // Still inside the listbox: VPs, then Archived, then the listbox's own closing tag.
    expect(archived).toBeLessThan(listCode.indexOf('{total === 0'))
  })

  it('selects a router like a node: onSelect, never onOpenTask', () => {
    expect(listCode).toMatch(/<OrgRouterSection rows=\{routers\} selectedKey=\{selectedKey\} now=\{now\} onSelect=\{onSelect\} \/>/)
    expect(section).not.toMatch(/onOpenTask/)
  })

  it('walks Up and Down through the VPs before the routers, in drawn order', () => {
    expect(listCode).toMatch(/const keys = \[main\.key, \.\.\.shown\.map\(\(r\) => r\.key\), \.\.\.routers\.map\(\(r\) => r\.key\)\]/)
  })

  it('searches VPs and routers', () => {
    expect(listCode).toContain('placeholder="Search VPs and routers…"')
  })

  it('is not a VP row: router rows never go through the VP Row or its VP-only parts', () => {
    expect(section).not.toMatch(/\bvpName\b|\bled\b|threadsBadge|org-channel-led/)
    expect(section).toContain('data-testid="org-channel-router"')
    // The VP list only maps `shown` (the VP rows) into <Row>.
    expect(listCode).not.toMatch(/routers\.map\(\(r\) => \(?\s*<Row/)
  })

  it('fetches nothing, refreshes nothing, and offers no create action this round', () => {
    expect(section).not.toMatch(/\bapiGet\b|\bfetch\w*\(|useEffect|setInterval|setTimeout|\/api\//)
    expect(section).not.toMatch(/\bitems\b|\.account\b|\.message\b/)
    expect(section).not.toMatch(/Create|New router|Add router/i)
  })
})

describe('a router task is a router node, not a VP', () => {
  const noAlerts: AlertProbe = () => null
  const t = (id: string, project: string, extra: Partial<Task> = {}): Task => ({
    id, title: `${id} title`, project, phase: 'IN_PROGRESS', status: 'todo', priority: 'none',
    created_at: at(600), updated_at: at(10), ...extra,
  }) as Task

  it('lands in routers and in no VP row', () => {
    const tasks = [
      t('lead', 'Orchard', { org_role: 'lead', org_name: 'Fruit' }),
      t('router-1', '', { org_role: 'router', org_name: 'Support router', router_area_id: 'support', router_links: ['lead'] }),
    ]
    const channels = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(channels.routers.map((r) => r.key)).toEqual(['router:router-1'])
    expect(channels.routers[0].kind).toBe('router')
    expect(channels.rows.some((r) => r.key === 'router:router-1' || r.leadId === 'router-1')).toBe(false)
  })

  it('a completed router has no row', () => {
    const tasks = [t('router-2', '', { org_role: 'router', phase: 'COMPLETE', status: 'done' })]
    expect(buildChannels(buildOrgTree(tasks), tasks, noAlerts).routers).toEqual([])
  })
})

// ── The router's own settings (OrgRouterSettings) and the New router entry ──

const settingsMod = await import('../../web/src/components/org/OrgRouterSettings')
const {
  OrgRouterSettings, RouterSettingsBody, folderList, foldersSkipInbox, routerBaseline, routerPatch, routerFormProblem, routerLinkRows,
  staleLinkLabel, staleNote, routerSummary, ROUTER_READY_LINE, ROUTER_PAUSED_LINE, ROUTER_LINK_NOTE,
} = settingsMod
const model = await import('../../web/src/components/org/org-channels-model.js')
const names = await import('../../web/src/components/org/router-area-names')
const orgPage = read('web/src/pages/OrgPage.tsx')
const namesCode = code(read('web/src/components/org/router-area-names.ts'))

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `${id} title`, project: '', phase: 'IN_PROGRESS', status: 'todo', priority: 'none',
  created_at: at(600), updated_at: at(10), ...extra,
}) as Task

describe('a router\'s line and state words never claim collection runs', () => {
  it('says Paused or Ready, and counts links in the singular for one', () => {
    expect(model.routerStateWord(true)).toBe('Paused')
    expect(model.routerStateWord(false)).toBe('Ready for new items')
    expect(model.routerStateWord(false, true)).toBe('Ready')
    expect(model.vpLinkCount(0)).toBe('0 VP links')
    expect(model.vpLinkCount(1)).toBe('1 VP link')
    expect(model.vpLinkCount(3)).toBe('3 VP links')
    expect(model.routerLine({ router_area_id: 'support', router_paused: false, router_links: ['a', 'a'] })).toBe('Support · Ready · 1 VP link')
    expect(model.routerLine({})).toBe('Area not configured · Paused · 0 VP links')
  })

  it('buildChannels writes the router row with that line, never "Active"', () => {
    const tasks = [
      task('lead', { project: 'Orchard', org_role: 'lead', org_name: 'Fruit' }),
      task('router-1', { org_role: 'router', org_name: 'Support router', router_area_id: 'support', router_links: ['lead'], router_paused: false }),
    ]
    const [row] = buildChannels(buildOrgTree(tasks), tasks, () => null).routers
    expect(row.latest).toBe('Support · Ready · 1 VP link')
    expect(row.latest).not.toMatch(/Active|running|collecting/i)
  })

  it('the channel helpers take channels with no routers (an older caller or a hand-made fixture)', () => {
    const tasks = [task('lead', { project: 'Orchard', org_role: 'lead', org_name: 'Fruit' })]
    const full = buildChannels(buildOrgTree(tasks), tasks, () => null)
    const { routers: _drop, ...noRouters } = full
    expect(model.rowOf(noRouters, 'router:x')).toBeUndefined()
    expect(model.pickChannel(noRouters, 'router:x').key).toBe((full.rows[0] ?? full.main).key)
    expect(model.movedProjects(noRouters, tasks)).toEqual([])
  })
})

describe('router settings: what a save sends and what the form says', () => {
  const saved = { name: 'Support router', links: ['a', 'b'], paused: true }

  it('sends only the fields that changed; links compare as a set; the name is trimmed', () => {
    expect(routerPatch(saved, { ...saved })).toBeNull()
    expect(routerPatch(saved, { ...saved, links: ['b', 'a', 'a'] })).toBeNull()
    expect(routerPatch(saved, { ...saved, name: '  Support router  ' })).toBeNull()
    expect(routerPatch(saved, { ...saved, paused: false })).toEqual({ paused: false })
    expect(routerPatch(saved, { ...saved, links: [] })).toEqual({ links: [] })
    expect(routerPatch(saved, { ...saved, name: ' Billing ', links: ['a'] })).toEqual({ name: 'Billing', links: ['a'] })
  })

  it('refuses an empty or too long name before sending', () => {
    expect(routerFormProblem({ ...saved, name: '   ' })).toMatch(/name/)
    expect(routerFormProblem({ ...saved, name: 'x'.repeat(61) })).toMatch(/60/)
    expect(routerFormProblem(saved)).toBe('')
  })

  it('reads its baseline from the task: org_name first, Paused only when set', () => {
    expect(routerBaseline(task('r', { org_name: 'Named', router_links: ['a'], router_paused: true }))).toEqual({ name: 'Named', links: ['a'], paused: true, folders: '' })
    expect(routerBaseline(task('r'))).toEqual({ name: 'r title', links: [], paused: true, folders: '' })
    expect(routerBaseline(task('r'), ['inbox', 'Receipts']).folders).toBe('inbox, Receipts')
  })

  it('sends the watched folders only when they changed, as a clean list ([] goes back to the Inbox)', () => {
    const base = { name: 'n', links: [], paused: false, folders: 'inbox' }
    expect(routerPatch(base, { ...base, folders: ' inbox ,' })).toBeNull()
    expect(routerPatch(base, { ...base, folders: 'inbox, Receipts, Receipts' })).toEqual({ folders: ['inbox', 'Receipts'] })
    expect(routerPatch(base, { ...base, folders: '' })).toEqual({ folders: [] })
    expect(folderList(' a, ,b ,a')).toEqual(['a', 'b'])
  })

  it('warns when the watched folders leave the Inbox out (empty means the Inbox)', () => {
    expect(foldersSkipInbox('')).toBe(false)
    expect(foldersSkipInbox(' INBOX, Receipts')).toBe(false)
    expect(foldersSkipInbox('Receipts')).toBe(true)
  })

  it('names each link that is no longer an open VP for what it is now', () => {
    const tasks = [
      task('open', { org_role: 'lead', org_name: 'Fruit' }),
      task('closed', { org_role: 'lead', org_name: 'Old VP', phase: 'COMPLETE', status: 'done' }),
      task('demoted', { title: 'Plain task' }),
    ]
    const rows = routerLinkRows(['open', 'closed', 'demoted', 'gone', 'open'], tasks)
    expect(rows.map((r) => [r.id, r.state])).toEqual([['open', 'open'], ['closed', 'closed'], ['demoted', 'not-vp'], ['gone', 'missing']])
    expect(staleLinkLabel(rows[1]!)).toBe('Old VP (VP closed)')
    expect(staleLinkLabel(rows[2]!)).toBe('Plain task (no longer a VP)')
    expect(staleLinkLabel(rows[3]!)).toBe('A VP that was closed or removed')
    expect(staleNote(1)).toBe('One link no longer names an open VP. Uncheck to drop it.')
    expect(staleNote(2)).toBe('2 links no longer name an open VP. Uncheck to drop them.')
    expect(routerSummary('support', { name: 'n', links: ['open', 'closed'], paused: false }, 1)).toBe('support · Ready for new items · 2 VP links · 1 not an open VP')
    expect(routerSummary('', { name: 'n', links: [], paused: true }, 0)).toBe('Area not configured · Paused · 0 VP links')
  })

  it('says links are collaboration, not ownership or access, and an unpaused router is only ready', () => {
    expect(ROUTER_LINK_NOTE).toMatch(/no ownership/)
    expect(ROUTER_LINK_NOTE).toMatch(/no access/)
    // 2026-11-14: the router is the triage and hands each item straight to its owner.
    expect(ROUTER_READY_LINE).toMatch(/^Ready\./)
    expect(ROUTER_READY_LINE).toMatch(/hands it straight to the task or VP/)
  })
})

describe('router settings render', () => {
  const lead = task('lead', { org_role: 'lead', org_name: 'Fruit' })
  const closed = task('closed', { org_role: 'lead', org_name: 'Old VP', phase: 'COMPLETE', status: 'done' })
  const router = task('router-1', { org_role: 'router', org_name: 'Support router', router_area_id: 'support', router_links: ['lead', 'closed'], router_paused: true })
  const noop = () => {}
  const body = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RouterSettingsBody, {
    id: 'org-router-settings-router-1', draftKey: 'draft:org-router-settings:router-1', area: 'support',
    value: { name: 'Support router', links: ['lead', 'closed'], paused: true, folders: '' }, leads: [lead],
    stale: routerLinkRows(['closed'], [closed]), busy: false, error: '', problem: '', dirty: false, justSaved: false,
    tasksLoading: false, onEdit: noop, onToggleLink: noop, onSave: noop, onDiscard: noop, ...extra,
  } as Parameters<typeof RouterSettingsBody>[0]))

  it('says which accounts its area reads, or how one gets added', () => {
    const none = body()
    expect(none).toContain('data-testid="org-router-sources"')
    expect(none).toContain('No account yet. The Mail plugin adds each mailbox here.')
    expect(none).toContain('It reads every new mail of these accounts in the folders it watches.')
    expect(none).toContain('data-testid="org-router-folders"')
    const some = body({ sources: [{ kind: 'mail', account: 'desk@example.invalid' }, { kind: 'slack', account: 'T0FIXTURE' }] })
    expect(some).toContain('desk@example.invalid')
    expect(some).toContain('(Mail)')
    expect(some).toContain('T0FIXTURE')
    expect(some).toContain('(Slack)')
    expect(names.areaSourcesOf({ areas: [{ id: 'personal', sources: [{ kind: 'mail', account: 'a@example.invalid' }, { kind: 'mail' }, 'x'] }, { id: 'work' }] }))
      .toEqual({ personal: [{ kind: 'mail', account: 'a@example.invalid' }], work: [] })
  })

  it('folded, it shows one line: area, Paused, the links, and a link that is no longer an open VP', () => {
    const html = renderToStaticMarkup(createElement(OrgRouterSettings, { router, tasks: [lead, closed, router] }))
    expect(html).toContain('data-testid="org-router-settings"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Support · Paused · 2 VP links · 1 not an open VP')
    expect(html).not.toContain('data-testid="org-router-settings-body"')
  })

  it('open, it shows the area, the name, Paused, the open VPs and the stale link, each field a draft', () => {
    const html = body()
    expect(html).toContain('data-testid="org-router-area">support<')
    expect(html).toMatch(/<input(?=[^>]*value="Support router")(?=[^>]*data-draft-key="draft:org-router-settings:router-1")[^>]*>/)
    expect(html).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*data-testid="org-router-paused")[^>]*>/)
    expect(html).toContain(ROUTER_PAUSED_LINE)
    expect(html).toMatch(/data-task-id="lead" data-link-state="open"/)
    expect(html).toMatch(/data-task-id="closed" data-link-state="closed"/)
    expect(html).toContain('Old VP (VP closed)')
    expect(html).toContain(staleNote(1))
    expect(html).toContain(ROUTER_LINK_NOTE.replaceAll("'", '&#x27;'))
    // Nothing to save yet.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*data-testid="org-router-save"|<button[^>]*data-testid="org-router-save"[^>]*disabled=""/)
  })

  it('unpaused, it says Ready for new items, never that it collects', () => {
    const html = body({ value: { name: 'Support router', links: [], paused: false }, stale: [] })
    expect(html).toContain(ROUTER_READY_LINE)
    expect(html).not.toContain(staleNote(1))
    expect(html).not.toMatch(/running|collecting/i)
  })

  it('a refused save shows the error and keeps what was typed', () => {
    const html = body({ value: { name: 'Typed name', links: ['lead'], paused: false }, dirty: true, error: 'Link existing open VPs.' })
    expect(html).toMatch(/role="alert"[^>]*>Link existing open VPs\.</)
    expect(html).toContain('value="Typed name"')
  })

  it('with no VP it says a router works on its own', () => {
    expect(body({ leads: [], stale: [], value: { name: 'n', links: [], paused: true } })).toContain('No open VP yet. A router works on its own.')
  })
})

describe('router settings in the page (source guards)', () => {
  const settings = code(read('web/src/components/org/OrgRouterSettings.tsx'))
  const detail = code(read('web/src/components/org/OrgNodeDetail.tsx'))
  const list = code(read('web/src/components/org/OrgChannelList.tsx'))
  const setup = code(read('web/src/components/org/OrgRouterSetup.tsx'))

  it('saves through PATCH /api/v1/org/routers/:id and nothing else; area names come from the shared read', () => {
    expect(settings).toContain('apiPatch<')
    expect(settings).toContain('`/api/v1/org/routers/${encodeURIComponent(forId)}`')
    expect(settings).not.toMatch(/\bapiGet\b|\bapiPost\b|\bfetch\(/)
    expect(settings).toContain('useRouterAreaNames([area])')
  })

  it('names a router row\'s area by its name once the areas list is read, its id until then', () => {
    expect(model.routerLine({ router_area_id: 'personal', router_paused: true, router_links: [] }, { personal: 'Personal' })).toBe('Personal · Paused · 0 VP links')
    expect(model.routerLine({ router_area_id: 'work', router_paused: true }, { personal: 'Personal' })).toBe('Work · Paused · 0 VP links')
    expect(names.areaNamesOf({ areas: [{ id: 'personal', name: ' Personal ' }, { id: 'x', name: '' }, { id: 3, name: 'Bad' }, 'junk'] })).toEqual({ personal: 'Personal' })
    expect(names.areaNamesOf(null)).toEqual({})
    // The page hands the names to buildChannels; the section itself still reads nothing.
    expect(orgPage).toContain('buildChannels(tree, shownTasks, answeredProbe, areaNames)')
    expect(namesCode.match(/apiGet</g) ?? []).toHaveLength(1)
    expect(namesCode).toContain("'/api/v1/router/areas'")
  })

  it('is inline: no menu, popover or portal', () => {
    expect(settings).not.toMatch(/createPortal|useMenuPlacement|ContextMenu|popover/i)
  })

  it('keeps its edits as a draft per router and its fold as a kept view per router', () => {
    expect(settings).toMatch(/useDraftValue<RouterSettingsValue>\(draftKey\('org-router-settings', id\)/)
    expect(settings).toMatch(/usePageViewOf<boolean>\('org', 'router\.settings', id,/)
    expect(setup).toMatch(/useDraftValue\(SETUP_KEY/)
    expect(setup).toContain('data-draft-key=')
  })

  it('a save that answers after the page moved writes nothing onto the other router', () => {
    expect(settings).toContain('form.clear(sentKey, sentText)')
    const guard = settings.indexOf('if (mine !== seq.current || currentId.current !== forId) return;')
    expect(guard).toBeGreaterThan(-1)
    expect(settings.indexOf('setSaved(res.task)')).toBeGreaterThan(guard)
    expect(settings).toMatch(/res\.task\.id === forId/)
    // Busy and the error belong to the router they were for.
    expect(settings).toContain('const busy = pendingFor === id;')
    expect(settings).toContain("const error = failure?.id === id ? failure.text : '';")
  })

  it('only a router node draws it, keyed by the router, outside the chat\'s split', () => {
    expect(detail).toContain("const routerTask = isRouter && contact?.org_role === 'router' ? contact : undefined;")
    expect(detail).toMatch(/\{routerTask && <OrgRouterSettings key=\{routerTask\.id\}/)
    expect(detail.indexOf('<OrgRouterSettings')).toBeLessThan(detail.indexOf('className={`org-detail-split'))
    // No other file of the page puts router settings on a node (a VP never gets them).
    for (const f of ['OrgChannelList.tsx', 'OrgTaskRail.tsx', 'OrgChartSheet.tsx', 'OrgBrief.tsx', 'OrgThreads.tsx']) {
      expect(read(`web/src/components/org/${f}`)).not.toContain('OrgRouterSettings')
    }
  })

  it('a router has no side bar: no Tasks, Brief, Threads or Board', () => {
    expect(detail).toMatch(/const keepsBrief = !isRouter && \(/)
    expect(detail).toContain('const railHidden = isRouter || railKeptHidden;')
    expect(detail).toContain('{!isRouter && !railHidden && rail}')
    expect(detail).toContain('{!isRouter && railSide && !railHidden && (')
    expect(detail).toContain('{!isRouter && <button')
    expect(detail).toContain('useHasBoard(isRouter ? undefined : row.contactId)')
    expect(detail).toMatch(/isRouter \? \[\] : teamColumns\(row, tasks\)/)
    expect(settings).not.toMatch(/OrgTaskRail|OrgBrief|OrgThreads|useOrgThreads|teamColumns/)
  })

  it('New router sits outside the listbox, so Up and Down never stop on it', () => {
    const button = list.indexOf('data-testid="org-new-router"')
    const listbox = list.indexOf('role="listbox"')
    expect(button).toBeGreaterThan(-1)
    expect(button).toBeLessThan(listbox)
    expect(list.slice(listbox)).not.toContain('org-new-router')
  })
})

// ── New router: one router per area, an area that has one opens it ──

const { OrgRouterSetup, existingRouterFor, ROUTER_SETUP_AREAS } = await import('../../web/src/components/org/OrgRouterSetup')

describe('New router reuses the router an area already has', () => {
  const vpA = task('vp-a', { org_role: 'lead', org_name: 'Dock VP' })
  const vpB = task('vp-b', { org_role: 'lead', org_name: 'Ferry VP' })
  const personal = task('router-p', { org_role: 'router', org_name: 'Home router', router_area_id: 'personal' })
  const closedWork = task('router-w', { org_role: 'router', org_name: 'Old work router', router_area_id: 'work', phase: 'COMPLETE', status: 'done' })
  const setup = (tasks: Task[]) => renderToStaticMarkup(createElement(OrgRouterSetup, { tasks, onDone: () => {}, onCancel: () => {} }))

  it('offers Personal and Work', () => {
    expect(ROUTER_SETUP_AREAS.map((a) => a.id)).toEqual(['personal', 'work'])
  })

  it('finds the open router of an area, never a closed one or another area\'s', () => {
    const tasks = [vpA, personal, closedWork]
    expect(existingRouterFor(tasks, 'personal')?.id).toBe('router-p')
    expect(existingRouterFor(tasks, 'work')).toBeUndefined()
    expect(existingRouterFor([vpA, task('plain', { router_area_id: 'personal' })], 'personal')).toBeUndefined()
  })

  it('an area with its router shows its name and Open router, never Create router', () => {
    const html = setup([vpA, vpB, personal])
    expect(html).toContain('data-testid="router-setup-existing" data-task-id="router-p"')
    expect(html).toContain('Home router')
    expect(html).toContain('data-testid="router-setup-open-existing"')
    expect(html).not.toContain('data-testid="router-setup-create"')
    // The offer sits right under the area: no name field and no VP list to scroll past.
    expect(html).not.toContain('data-testid="router-name"')
    expect(html).not.toContain('type="checkbox"')
    expect(html.indexOf('router-setup-existing')).toBeGreaterThan(html.indexOf('<legend>Area</legend>'))
  })

  it('an area with none offers Create router, with zero or several VPs to link', () => {
    const none = setup([closedWork])
    expect(none).toContain('data-testid="router-setup-create"')
    expect(none).toContain('No open VP yet. A router works on its own.')
    const many = setup([vpA, vpB, closedWork])
    expect(many).toContain('Dock VP')
    expect(many).toContain('Ferry VP')
    expect((many.match(/type="checkbox"/g) ?? []).length).toBe(2)
    expect(many).not.toContain('router-setup-existing')
  })

  it('many VPs get the same finder and scrolling list as the settings, so Create stays near', () => {
    const vps = Array.from({ length: 12 }, (_, i) => task(`vp-${i}`, { org_role: 'lead', org_name: `Fleet ${i} VP` }))
    const html = setup(vps)
    expect(html).toContain('data-testid="router-setup-vp-filter"')
    expect(html).toContain('placeholder="Find a VP"')
    expect(html).toContain('class="org-router-link-list"')
    expect((html.match(/data-testid="router-setup-vp"/g) ?? []).length).toBe(12)
    // A few VPs need no finder.
    expect(setup([vpA, vpB])).not.toContain('router-setup-vp-filter')
  })

  it('opening the existing router sends no POST and keeps the typed draft; nothing is fetched or polled', () => {
    const src = code(read('web/src/components/org/OrgRouterSetup.tsx'))
    const reuse = src.indexOf('if (existing) { onDone(existing.id); return; }')
    expect(reuse).toBeGreaterThan(-1)
    expect(reuse).toBeLessThan(src.indexOf("apiPost<{ task: Task }>('/api/v1/org/routers'"))
    expect(src.indexOf('draft.clear(')).toBeGreaterThan(src.indexOf("apiPost<{ task: Task }>('/api/v1/org/routers'"))
    expect(src).not.toMatch(/\bapiGet\b|useEffect|setInterval|setTimeout|ContextMenu|createPortal|<select/)
  })
})

describe('router settings', () => {
  it('keep no per-message area rules: a mailbox is bound to its router as a whole', () => {
    const settings = code(read('web/src/components/org/OrgRouterSettings.tsx'))
    expect(settings).toContain('className="org-router-settings-scroll"')
    expect(settings).not.toMatch(/OrgRouterRules|router\/rules|router\/assign/)
    expect(fs.existsSync(path.join(ROOT, 'web/src/components/org/OrgRouterRules.tsx'))).toBe(false)
  })
})
