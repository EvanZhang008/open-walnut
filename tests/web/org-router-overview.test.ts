/**
 * A router's Org page says what it is and where it stands (2026-11-11, the person, on a router page
 * that showed only "No conversation history found": "why it is empty that is weird it is not working
 * or what"). The words of OrgRouterOverview for each state, and source checks that the page wires the
 * overview and its own empty-chat line for routers only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const { routerWhatLine, routerStateLine, routerRoutedLine, routerNextLine, routerEmptyChatLine, routerCheckedLines } = await import('../../web/src/components/org/OrgRouterOverview')
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
    expect(routerWhatLine('Personal mail router', 'Personal')).toBe('Personal mail router reads the mail and messages that reach Personal and hands each one to the task that owns it, found by searching all tasks. It does none of the work itself.')
  })

  it('reads a running router with nothing assigned as running, with no email and how to give it mail', () => {
    const s = base()
    expect(routerStateLine(s, NOW)).toMatch(/^Running\. It checks for new Personal messages every 5 minutes \(last check .+\)\.$/)
    expect(routerRoutedLine(s, NOW)).toBe('No messages so far.')
    expect(routerNextLine(s)).toBe('Nothing is assigned to Personal yet, so it has nothing to route. To give it mail, open an email in Mail and choose Personal on its route line.')
  })

  it('reads paused, a wake that is off, and a router whose session has not started', () => {
    expect(routerStateLine(base({ paused: true }), NOW)).toBe('Paused: it reads nothing until you turn Paused off in Router settings.')
    expect(routerNextLine(base({ paused: true }))).toBe('')
    expect(routerStateLine(base({ wake: { armed: false } }), NOW)).toMatch(/^Ready, but its check for new messages is off/)
    // Not paused, but its wake hands it nothing (the org is off): never "Running".
    expect(routerStateLine(base({ blocked: 'The org is off.' }), NOW)).toBe('Not reading now: The org is off.')
    expect(routerNextLine(base({ blocked: 'The org is off.' }))).toBe('')
    expect(routerStateLine(base({ session: { started: false } }), NOW)).toMatch(/^Not running yet: it starts when a message for Personal arrives\. It checks/)
  })

  it('counts what it routed and names the newest by its task', () => {
    const s = base({ assigned: 3, counts: { ...ZERO, routed: 2, not_routed: 1 }, latest: { at: NOW - 5 * 60_000, status: 'routed', taskId: 't1', taskTitle: 'Renew car insurance' } })
    expect(routerRoutedLine(s, NOW)).toMatch(/^3 messages: 2 handed to a task, 1 needed nothing\. Last one .+ to Renew car insurance\.$/)
    expect(routerNextLine(s)).toBe('')
    const one = base({ assigned: 1, counts: { ...ZERO, failed: 1 }, latest: { at: NOW - 60_000, status: 'failed' } })
    expect(routerRoutedLine(one, NOW)).toMatch(/^1 message: 1 failed\. Last one .+\.$/)
  })

  it('never says only "No messages yet" for a router', () => {
    expect(routerEmptyChatLine('Personal')).toBe('Nothing in this conversation yet. It starts when the next message for Personal reaches the router.')
  })
})

describe('router page wiring', () => {
  const detail = read('web/src/components/org/OrgNodeDetail.tsx')
  it('shows the overview for a router and hands its chat the router empty line', () => {
    expect(detail).toMatch(/\{routerTask && <OrgRouterOverview /)
    expect(detail).toMatch(/routerEmptyChat \? \{ emptyHistory: routerEmptyChat \} : \{\}/)
    // A string (the shared EmptyState's title), so SessionChatHistory's memo holds with no useMemo.
    expect(detail).toMatch(/const routerEmptyChat = isRouterNode \? routerEmptyChatLine\(routerAreaLabel\) : undefined;/)
  })
  it('lets the chat history take another empty line, keeping the old one as the default', () => {
    const history = read('web/src/components/sessions/SessionChatHistory.tsx')
    expect(history).toMatch(/stateWords\(emptyHistory \?\? 'No messages yet\. /)
    expect(read('web/src/components/sessions/SessionPanel.tsx')).toMatch(/emptyHistory=\{emptyHistory\}/)
  })
})

describe('the missed-message check, in words', () => {
  const row = (extra: Record<string, unknown> = {}) => ({ kind: 'slack', account: 'T0TEAM', saw: 12, filtered: 0, had: 12, missed: 0, entered: 0, ...extra })
  const checked = (accounts: ReturnType<typeof row>[]) => base({ reconcile: { at: NOW - 10 * 60_000, sinceMs: NOW - 86_400_000, accounts } as never })

  it('says nothing when no account was checked', () => {
    expect(routerCheckedLines(base(), NOW)).toEqual([])
    expect(routerCheckedLines(checked([]), NOW)).toEqual([])
  })

  it('says the source saw N and the router had them all, and what its filter left out', () => {
    const [line] = routerCheckedLines(checked([row({ filtered: 3 })]), NOW)
    expect(line).toMatch(/^Slack saw 12 in the last day and the router had all 12, checked .+\. 3 more left out by its filter\.$/)
    expect(routerCheckedLines(checked([row({ saw: 1, had: 1 })]), NOW)[0]).toMatch(/^Slack saw 1 in the last day and the router had it, checked .+\.$/)
  })

  it('counts the missed and how many entered now', () => {
    expect(routerCheckedLines(checked([row({ had: 10, missed: 2, entered: 2 })]), NOW)[0])
      .toMatch(/^Slack saw 12 in the last day; the router had 10, so 2 missed, all 2 entered now, checked .+\.$/)
    expect(routerCheckedLines(checked([row({ had: 9, missed: 3, entered: 1 })]), NOW)[0])
      .toMatch(/^Slack saw 12 in the last day; the router had 9, so 3 missed, 1 of them entered now, checked .+\.$/)
  })

  it('says a source could not count, never that nothing was missed', () => {
    const [line] = routerCheckedLines(checked([row({ saw: 0, had: 0, error: 'The slack integration cannot say what arrived.' })]), NOW)
    expect(line).toMatch(/^Slack: could not count what it saw \(The slack integration cannot say what arrived\.\), checked .+\.$/)
    expect(line).not.toMatch(/had all/)
  })

  it('names the account only when one kind has several', () => {
    const lines = routerCheckedLines(checked([row(), row({ account: 'T0OTHER' }), row({ kind: 'wechat', account: 'wx-1' })]), NOW)
    expect(lines.map((line) => line.split(' saw')[0])).toEqual(['Slack (T0TEAM)', 'Slack (T0OTHER)', 'WeChat'])
  })

  it('the page shows the lines under Missed, only when there are some', () => {
    const page = read('web/src/components/org/OrgRouterOverview.tsx')
    expect(page).toMatch(/checkedLines\.length > 0 && <div><dt>Missed<\/dt><dd data-testid="org-router-overview-checked">/)
  })
})

