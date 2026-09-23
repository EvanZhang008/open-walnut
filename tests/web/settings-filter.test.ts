import { describe, expect, it } from 'vitest'
import {
  filterEntries,
  PAGE_LINK_KEYWORDS,
  primaryHit,
  truncateHint,
  HINT_MAX,
  type FilterEntry,
} from '../../web/src/components/settings/settings-filter.js'
import { CORE_PANE_IDS, corePaneFilterEntry } from '../../web/src/components/settings/settings-routing.js'

// Nav order: the four Manage page links first, then every core pane in registry order.
const PAGE_LINKS: FilterEntry[] = ['agents', 'skills', 'commands', 'memory'].map((id) => ({
  key: `link:${id}`,
  kind: 'link',
  label: id[0].toUpperCase() + id.slice(1),
  keywords: PAGE_LINK_KEYWORDS[id],
}))
const ENTRIES: FilterEntry[] = [...PAGE_LINKS, ...CORE_PANE_IDS.map(corePaneFilterEntry)]

const keys = (q: string) => filterEntries(ENTRIES, q).map((h) => h.key)
const hit = (q: string, key: string) => filterEntries(ENTRIES, q).find((h) => h.key === key)

describe('Find a setting matcher', () => {
  it('finds every pane that talks about models', () => {
    expect(keys('model')).toEqual(expect.arrayContaining(['engines', 'advanced', 'tasks']))
    // F22: the hint names the row, and the exact keyword wins the Enter.
    expect(hit('model', 'engines')?.hint).toBe('Claude Code model')
    expect(primaryHit(filterEntries(ENTRIES, 'model'))?.key).toBe('engines')
    expect(hit('model', 'advanced')?.hint).toBe('Subagent model')
  })

  it('shows the row label for an anchored or row keyword', () => {
    expect(keys('all clear')).toEqual(['general'])
    expect(hit('all clear', 'general')?.hint).toBe('Heartbeat all clear')
    expect(hit('all clear', 'general')?.anchor).toBe('settings-notify-heartbeat') // F20
    const name = hit('your name', 'general')
    expect(name?.hint).toBe('Your name')
    expect(name?.anchor).toBe('settings-name')
  })

  it('counts folded sections under their owner pane', () => {
    expect(primaryHit(filterEntries(ENTRIES, 'cloud companion'))?.key).toBe('devices')
    expect(hit('cloud companion', 'devices')?.level).toBe(0)
    expect(primaryHit(filterEntries(ENTRIES, 'focus tiers'))?.key).toBe('tasks')
    expect(hit('focus tiers', 'tasks')?.hint).toBe('Focus Tiers')
    expect(primaryHit(filterEntries(ENTRIES, 'use an api'))?.key).toBe('advanced')
  })

  it('opens Engines for agent: a word-start keyword beats mid-word, panes beat page links', () => {
    const hits = filterEntries(ENTRIES, 'agent')
    expect(hits.map((h) => h.key)).toContain('link:agents')
    expect(hits[0].key).toBe('link:agents') // label prefix ranks first ...
    expect(primaryHit(hits)?.key).toBe('engines') // ... but Enter stays in Settings
    expect(hit('agent', 'engines')?.wordStart).toBe(true)
    expect(hit('agent', 'general')?.wordStart).toBe(false) // `subagent`
  })

  it('finds triage in General, Tasks and Inbox Triage', () => {
    expect(keys('triage')).toEqual(expect.arrayContaining(['general', 'tasks', 'triage']))
    expect(primaryHit(filterEntries(ENTRIES, 'triage'))?.key).toBe('triage')
    expect(hit('triage', 'triage')?.hint).toBeNull()
    expect(hit('triage', 'triage')?.labelRanges).toEqual([[6, 12]])
  })

  it('finds notify in Tasks', () => {
    expect(keys('notify')).toContain('tasks')
  })

  it('puts Plugins first for slack', () => {
    expect(primaryHit(filterEntries(ENTRIES, 'slack'))?.key).toBe('plugin-store')
  })

  it('finds idle in Sessions only, with its row label', () => {
    expect(keys('idle')).toEqual(['sessions'])
    expect(hit('idle', 'sessions')?.hint).toBe('Idle timeout')
    expect(hit('idle', 'sessions')?.anchor).toBe('idle-timeout')
  })

  it('needs every term and ignores case and extra spaces', () => {
    expect(keys('  IDLE   Timeout ')).toEqual(['sessions'])
    expect(keys('idle zzzq')).toEqual([])
    expect(keys('zzzq')).toEqual([])
    expect(keys('   ')).toEqual([])
  })

  it('N17: a folded title that only mentions a term never outranks the pane that owns it', () => {
    // "Use an API instead of Claude Code" is folded under Advanced; Claude Code lives in Engines.
    expect(primaryHit(filterEntries(ENTRIES, 'claude code'))?.key).toBe('engines')
    expect(primaryHit(filterEntries(ENTRIES, 'claude'))?.key).toBe('engines')
    // ... but a query that starts the folded title still opens its pane first.
    expect(primaryHit(filterEntries(ENTRIES, 'use an api'))?.key).toBe('advanced')
    expect(hit('instead', 'advanced')?.hint).toContain('instead')
  })

  it('F22: word-start keywords beat mid-word labels; hints name rows; wifi and slack are found', () => {
    expect(primaryHit(filterEntries(ENTRIES, 'port'))?.key).toBe('advanced')
    expect(hit('port', 'advanced')?.hint).toBe('Port') // N17: the row's real label
    expect(keys('slack')).toContain('integrations')
    expect(keys('wifi')).toContain('devices')
    expect(hit('theme', 'general')?.hint).toBe('Appearance')
    expect(hit('qr', 'devices')?.hint).toBe('Device name')
  })

  it('keeps nav order inside one rank level', () => {
    const hits = filterEntries(ENTRIES, 'model').filter((h) => h.level === 2 && h.wordStart && !h.exact)
    const order = hits.map((h) => h.order)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('caps hint text at 32 characters with three dots', () => {
    const long = 'Scheduled copies of your Walnut data to an S3 bucket.'
    const cut = truncateHint(long, long.indexOf('bucket'))
    expect(cut.length).toBeLessThanOrEqual(HINT_MAX)
    expect(cut).toMatch(/^\.\.\./)
    expect(cut).not.toMatch(/[\u2026\u2013\u2014]/)
    expect(truncateHint('short')).toBe('short')
  })

  it('uses a description snippet when only the description matches', () => {
    const d = hit('bucket', 'backup')
    expect(d?.level).toBe(2) // `bucket` is a keyword too
    const snippet = hit('scheduled', 'backup')
    expect(snippet?.level).toBe(3)
    expect(snippet?.hint?.startsWith('Scheduled copies')).toBe(true)
    expect((snippet?.hint ?? '').length).toBeLessThanOrEqual(HINT_MAX)
  })
})
