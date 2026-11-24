/**
 * Guard: every row of the Org list is the one plain row (web/src/components/org/OrgListRow.tsx):
 * its avatar, its name and, when something there waits on the user, one round red dot. Nothing
 * else (2026-11-22, the user: "just show name of vp icon, read dot for thread ... We need to be
 * super simple"): no time, no line under the name, no count, no unread dot, no state mark on the
 * avatar, no card for the CEO, and nothing hung under a row (watched or locked tasks, a folded
 * "N directors" line). What those said stays one hover away (the row's title) and the dot's label
 * says the count.
 *
 * The class: a row of the list that draws a second piece of text or a mark. Members are found from
 * the source: every file the list draws a row from, and every `org-channel` row in web/src. A new
 * row that is not an OrgListRow, or a removed part coming back, fails here.
 *
 * Render and source checks; the Org Playwright specs walk the real page.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { createElement, type ReactNode } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup as renderStatic } from '../../web/node_modules/react-dom/server.node.js'
import { MemoryRouter } from '../../web/node_modules/react-router-dom/dist/index.js'
import type { ChannelRow } from '../../web/src/components/org/org-channels-model.js'
import { OrgListRow, rowDot, rowHover } from '../../web/src/components/org/OrgListRow'
import { OrgAvatar } from '../../web/src/components/org/OrgAvatar'

const { OrgRouterSection } = await import('../../web/src/components/org/OrgRouterSection')

const render = (node: ReactNode) => renderStatic(createElement(MemoryRouter, null, node))
const ROOT = path.resolve(import.meta.dirname, '../..')
const WEB = path.join(ROOT, 'web/src')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
/** The words a row shows: its markup with tags (and their attributes, the hover included) taken out. */
const shownText = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const NOW = Date.UTC(2026, 10, 22, 12, 0)

function row(extra: Partial<ChannelRow> = {}): ChannelRow {
  return {
    key: 'project:orchard', kind: 'project', project: 'Orchard', name: 'Orchard', contactId: 'lead-1', contactTitle: 'Orchard VP',
    isLead: true, counts: { open: 9, running: 4, needsYou: 2, toRead: 1, waiting: 3 }, state: 'alert',
    alerts: [{ taskId: 'a1', toRead: false }, { taskId: 'a2', toRead: false }] as ChannelRow['alerts'], needs: 5,
    threadsBadge: 3, latest: '3 threads: Pick a host', latestAt: NOW - 7 * 60_000, latestWatched: true, lastAt: NOW - 7 * 60_000,
    unread: true, led: [{ name: 'Garden', project: 'Garden' }] as ChannelRow['led'],
    ...extra,
  } as ChannelRow
}

const drawRow = (r: ChannelRow) => render(createElement(OrgListRow, {
  avatar: createElement(OrgAvatar, { row: r, plain: true }), name: r.name, dot: rowDot(r), title: rowHover(r, NOW),
}))

describe('an Org list row draws its avatar, its name and at most one red dot', () => {
  it('shows only the name: no time, no line, no count, even on a row full of news', () => {
    const html = drawRow(row())
    expect(shownText(html)).toBe('Orchard')
    // One line, a long name too: cut, whole on hover (2026-11-23, the user: the watch rows should be slim).
    expect(html).toMatch(/<span class="org-channel-name wn-meta">/)
    expect(html).not.toMatch(/org-channel-(?:time|latest|tail|led|pin)|org-badge|badge-count|is-unread|is-main|org-state-dot|task-state-icon/)
  })

  it('wears one dot for threads (or asks), labelled with the count; none at 0', () => {
    const html = drawRow(row())
    expect(html.match(/data-testid="org-channel-dot"/g)).toHaveLength(1)
    expect(html).toMatch(/<span class="org-channel-dot" role="img" aria-label="3 threads"/)
    // A node's own row: its threads decide, never its asks; a grey 0 is no dot.
    expect(drawRow(row({ threadsBadge: 0 }))).not.toContain('org-channel-dot')
    // A row with no Threads of its own (a router, a project with no VP): what it asks.
    expect(rowDot(row({ threadsBadge: undefined }))).toBe('2 Needs you')
    expect(rowDot(row({ threadsBadge: undefined, alerts: [] }))).toBeNull()
    // Work that runs is no dot (the green count is gone).
    expect(rowDot(row({ threadsBadge: undefined, alerts: [], counts: { open: 9, running: 4, needsYou: 0, toRead: 0, waiting: 3 } }))).toBeNull()
  })

  it('keeps what it no longer draws one hover away', () => {
    const hover = rowHover(row(), NOW)
    expect(hover).toMatch(/^Orchard: Needs you, moved 7m ago, unread\n/)
    expect(hover).toContain('3 threads: Pick a host (a watched thread)')
    expect(hover).toContain('Also leads Garden')
    // The count is said once: here the line already names it.
    expect(hover.match(/3 threads/g)).toHaveLength(1)
    expect(rowHover(row({ latest: 'Working on: x' }), NOW)).toContain('\n3 threads')
    // A node with none still says so in its hover (it draws no grey "0").
    expect(rowHover(row({ latest: 'Working on: x', threadsBadge: 0 }), NOW)).toContain('\n0 threads')
  })

  it('draws a router row the same way, its avatar plain', () => {
    const r = row({ key: 'router:r1', kind: 'router', name: 'Support router', threadsBadge: undefined, alerts: [], latest: 'support · Active · 2 VP links' })
    const html = render(createElement(OrgRouterSection, { rows: [r], selectedKey: null, onSelect: () => {} }))
    const option = html.slice(html.indexOf('<button'), html.lastIndexOf('</button>'))
    expect(shownText(option)).toBe('Support router')
    expect(option).not.toMatch(/org-state-dot|org-channel-dot|org-badge/)
  })
})

describe('every row of the Org list goes through OrgListRow', () => {
  // The files the list draws a row from, found from its own imports and every `org-channel` row in web/src.
  const ROW_FILES = (() => {
    const out = new Set<string>()
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx$/.test(e.name) && /className=\{?[`'"]org-channel(?![\w-])|<OrgListRow\b/.test(fs.readFileSync(p, 'utf8'))) out.add(path.relative(ROOT, p).split(path.sep).join('/'))
      }
    }
    walk(WEB)
    return [...out].sort()
  })()

  it('finds the list\'s rows (so the scan reads what it should)', () => {
    for (const f of ['OrgChannelList.tsx', 'OrgRouterSection.tsx', 'OrgDirectorSection.tsx', 'OrgListRow.tsx']) {
      expect(ROW_FILES, f).toContain(`web/src/components/org/${f}`)
    }
    expect(ROW_FILES).toContain('web/src/components/topics/OrgTopicsSection.tsx')
  })

  it.each(ROW_FILES.filter((f) => !f.endsWith('/OrgListRow.tsx')))('%s draws no row of its own and none of the removed parts', (f) => {
    const src = code(read(f))
    // Only OrgListRow writes the row's own class.
    expect(src).not.toMatch(/className=\{?[`'"]org-channel(?![\w-])/)
    expect(src).not.toMatch(/org-channel-(?:time|latest|tail|top|mid|led|pin)\b|org-badge\b|is-unread|org-watched|KeptChildren|<OrgLeaders\b|<TaskStateIcon\b|shortAgo\(/)
  })

  it('the row draws its avatar, its name and the dot, and nothing else', () => {
    const src = code(read('web/src/components/org/OrgListRow.tsx'))
    const jsx = src.slice(src.indexOf('<button type="button"'), src.indexOf('</button>'))
    const tags = [...jsx.matchAll(/<([a-zA-Z]+)\b/g)].map((m) => m[1])
    expect(tags).toEqual(['button', 'span', 'span'])
    expect(jsx).toContain('{avatar}')
    expect(jsx).toContain('className="org-channel-name wn-meta">{name}</span>')
  })

  it('the CEO row is flat like the others, and the dot is round', () => {
    const css = read('web/src/styles/org-page.css')
    expect(css).not.toMatch(/\.org-channel\.is-main\b/)
    const dot = css.slice(css.indexOf('.org-channel-dot {'), css.indexOf('}', css.indexOf('.org-channel-dot {')))
    expect(dot).toContain('border-radius: 50%')
    expect(dot).toContain('background: var(--error)')
  })
})
