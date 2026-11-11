/**
 * A router's Org page says what it is and where it stands (2026-11-11, the person, on a router page
 * that showed only "No conversation history found": "why it is empty that is weird it is not working
 * or what"). The words of OrgRouterOverview for each state, and source checks that the page wires the
 * overview and its own empty-chat line for routers only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const { routerWhatLine, routerStateLine, routerRoutedLine, routerNextLine, routerEmptyChatLine } = await import('../../web/src/components/org/OrgRouterOverview')
type Summary = Parameters<typeof routerStateLine>[0]

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const NOW = Date.parse('2026-11-11T06:00:00.000Z')
const ZERO = { routed: 0, not_routed: 0, routing: 0, failed: 0, unknown: 0 }
const base = (extra: Partial<Summary> = {}): Summary => ({
  areaId: 'personal', areaName: 'Personal', paused: false, sources: 0, assigned: 0, waiting: 0, counts: { ...ZERO },
  wake: { armed: true, everyMs: 300_000, lastCheckAt: NOW - 2 * 60_000 }, session: { started: true, state: 'idle' }, ...extra,
})

describe('router overview words', () => {
  it('says what a router does in one line, naming its area', () => {
    expect(routerWhatLine('Personal mail router', 'Personal')).toBe('Personal mail router reads the mail you assign to Personal and hands each one to the task or VP that should own it. It does none of the work itself.')
  })

  it('reads a running router with nothing assigned as running, with no email and how to give it mail', () => {
    const s = base()
    expect(routerStateLine(s, NOW)).toMatch(/^Running\. It checks for new Personal mail every 5 minutes \(last check .+\)\.$/)
    expect(routerRoutedLine(s, NOW)).toBe('No email so far.')
    expect(routerNextLine(s)).toBe('Nothing is assigned to Personal yet, so it has nothing to route. To give it mail, open an email in Mail and choose Personal on its route line.')
  })

  it('reads paused, a wake that is off, and a router whose session has not started', () => {
    expect(routerStateLine(base({ paused: true }), NOW)).toBe('Paused: it reads nothing until you turn Paused off in Router settings.')
    expect(routerNextLine(base({ paused: true }))).toBe('')
    expect(routerStateLine(base({ wake: { armed: false } }), NOW)).toMatch(/^Ready, but its check for new mail is off/)
    // Not paused, but its wake hands it nothing (the org is off): never "Running".
    expect(routerStateLine(base({ blocked: 'The org is off.' }), NOW)).toBe('Not reading mail now: The org is off.')
    expect(routerNextLine(base({ blocked: 'The org is off.' }))).toBe('')
    expect(routerStateLine(base({ session: { started: false } }), NOW)).toMatch(/^Not running yet: it starts when mail for Personal arrives\. It checks/)
  })

  it('counts what it routed and names the newest by its task', () => {
    const s = base({ assigned: 3, counts: { ...ZERO, routed: 2, not_routed: 1 }, latest: { at: NOW - 5 * 60_000, status: 'routed', taskId: 't1', taskTitle: 'Renew car insurance' } })
    expect(routerRoutedLine(s, NOW)).toMatch(/^3 emails: 2 handed to a task, 1 needed nothing\. Last one .+ to Renew car insurance\.$/)
    expect(routerNextLine(s)).toBe('')
    const one = base({ assigned: 1, counts: { ...ZERO, failed: 1 }, latest: { at: NOW - 60_000, status: 'failed' } })
    expect(routerRoutedLine(one, NOW)).toMatch(/^1 email: 1 failed\. Last one .+\.$/)
  })

  it('never says "No conversation history found" for a router', () => {
    expect(routerEmptyChatLine('Personal')).toBe('Nothing in this conversation yet. It starts when the next mail you assigned to Personal reaches the router.')
  })
})

describe('router page wiring', () => {
  const detail = read('web/src/components/org/OrgNodeDetail.tsx')
  it('shows the overview for a router and hands its chat the router empty line', () => {
    expect(detail).toMatch(/\{routerTask && <OrgRouterOverview /)
    expect(detail).toMatch(/routerEmptyChat \? \{ emptyHistory: routerEmptyChat \} : \{\}/)
    // memoized: SessionChatHistory is memo'd, a fresh element each render would re-render it.
    expect(detail).toMatch(/const routerEmptyChat = useMemo\(/)
    // keyed on primitives, never the task object (a new one on every task update)
    expect(detail).toMatch(/\[isRouterNode, routerAreaLabel\]/)
  })
  it('lets the chat history take another empty line, keeping the old one as the default', () => {
    const history = read('web/src/components/sessions/SessionChatHistory.tsx')
    expect(history).toMatch(/emptyHistory \?\? <p className="text-muted">No conversation history found<\/p>/)
    expect(read('web/src/components/sessions/SessionPanel.tsx')).toMatch(/emptyHistory=\{emptyHistory\}/)
  })
})
