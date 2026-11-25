/**
 * A view that judges a time window (shown for 6 hours, a grace period, a snooze, "stale after 30
 * minutes", "resets in 12m") reads a clock that draws it: never the wall clock at its render.
 *
 * Why (2026-11-25, task 9bceb9f2): the session panels' stores stopped handing out new copies of an
 * unchanged answer (a poll every 15 s, a re-read on every focus), so they stopped drawing for
 * nothing. Views that read `Date.now()` at their render to end a window had been kept current by
 * those draws alone: "Stop not confirmed" would have stayed past its 6 hours, and a letter's
 * answer card past its grace period. They now read web/src/utils/minute-clock.ts (useMinuteValue
 * redraws only when the answer changes; useMinuteNow for a label that moves).
 *
 * The class: `Date.now()` or `new Date()` read in the body of a component or hook, or inside a
 * useMemo there. Members are found from the TypeScript source of web/src. Each one left is pinned
 * below with why it is not a window that only another draw would end; a new one fails.
 * The minute ticks themselves are tests/web/minute-tick-ratchet.test.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const WEB = path.join(ROOT, 'web/src')

const OWN_CLOCK = 'its own clock draws it (an interval, a ticker, an expiry timer or the minute clock)'
const STAMP = 'stamps when it saw something, into a ref or a log: it judges no window'
const DAY = 'the calendar day of a page the person has open: a new day is a new visit'
const MENU = 'read while a menu is open, built again each time it opens'

/** The reads left, by file: how many and why each may stay. */
const PINNED: Record<string, { n: number; why: string }> = {
  'web/src/components/approvals/ApprovalRow.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/board/BoardStatusView.tsx': { n: 1, why: 'a done window counted in days, drawn with its task list' },
  'web/src/components/board/TaskBoardPane.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/board/kanban/useKanbanBoard.ts': { n: 1, why: OWN_CLOCK },
  'web/src/components/board/useTeamOverview.ts': { n: 1, why: OWN_CLOCK },
  'web/src/components/calendar/CalendarSidePanel.tsx': { n: 2, why: DAY },
  'web/src/components/calendar/MonthView.tsx': { n: 1, why: DAY },
  'web/src/components/common/MonthGrid.tsx': { n: 1, why: DAY },
  'web/src/pages/CalendarPage.tsx': { n: 2, why: DAY },
  'web/src/hooks/useUsageCosts.ts': { n: 1, why: DAY },
  'web/src/components/usage/UsageBreakdownCard.tsx': { n: 1, why: DAY },
  'web/src/components/chat/camera/useCameraStream.ts': { n: 1, why: STAMP },
  'web/src/components/sessions/ComposerModelPill.tsx': { n: 1, why: STAMP },
  'web/src/components/sessions/DeliveryMetaLine.tsx': { n: 1, why: STAMP },
  'web/src/components/sessions/SessionChatHistory.tsx': { n: 1, why: STAMP },
  'web/src/components/sessions/StreamingBlockView.tsx': { n: 1, why: STAMP },
  'web/src/components/tasks/TodoPanel.tsx': { n: 1, why: STAMP },
  'web/src/components/layout/useAppAutoUpdate.ts': { n: 2, why: 'a tab id, and the update step worked out again on each draw of the shell its own state drives' },
  'web/src/components/common/NotificationToaster.tsx': { n: 2, why: OWN_CLOCK },
  'web/src/components/hosts/HostConnectCard.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/layout/SidebarStatusItems.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/org/OrgThreads.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/org/TopThread.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/passwords/ItemView.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/passwords/LockScreens.tsx': { n: 2, why: OWN_CLOCK },
  'web/src/components/sessions/DraftFallbackNotice.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/sessions/SessionBrowserCard.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/sessions/SessionBrowserReplay.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/sessions/SessionSpeedReadout.tsx': { n: 2, why: OWN_CLOCK },
  'web/src/components/sessions/UsageLimitBanner.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/settings/sections/BackupSection.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/settings/sections/HealthMonitorSection.tsx': { n: 1, why: OWN_CLOCK },
  'web/src/components/tasks/useNormalizedTaskQuery.ts': { n: 1, why: OWN_CLOCK },
  'web/src/hooks/useFixNotes.ts': { n: 2, why: OWN_CLOCK },
  'web/src/hooks/useSessionStatus.ts': { n: 1, why: OWN_CLOCK },
  'web/src/components/org/OrgThreadSnooze.tsx': { n: 1, why: MENU },
  'web/src/components/sessions/useDraftMoreMenu.ts': { n: 2, why: MENU },
  'web/src/components/sessions/ThreadTreeRows.tsx': { n: 1, why: 'a hover title ("answered 5m ago"), read again on the tree\'s next draw' },
  'web/src/components/settings/sections/PageUseSection.tsx': { n: 1, why: 'a Settings page read when it opens or the person refreshes it' },
  'web/src/contexts/notifications/NotificationProvider.tsx': { n: 1, why: 'no clock on purpose: the server\'s expiry event takes an approval off' },
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)

/** The name a function is known by: its own, its variable's, or the variable of the memo() it is wrapped in. */
function nameOf(f: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(f) || ts.isFunctionExpression(f)) && f.name) return f.name.text
  const p = f.parent
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
  if (p && ts.isCallExpression(p) && p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text
  return undefined
}
const drawsWith = (f: ts.Node | undefined) => { const n = f && nameOf(f); return !!n && /^([A-Z]|use[A-Z])/.test(n) }
const enclosing = (n: ts.Node): ts.Node | undefined => { let f = n.parent; while (f && !isFn(f)) f = f.parent; return f }

/** Each read of the wall clock at a render or in a useMemo, as `file:line`. */
export function renderClockReads(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: string[] = []
  const visit = (n: ts.Node) => {
    const read = (ts.isCallExpression(n) && n.expression.getText(sf) === 'Date.now')
      || (ts.isNewExpression(n) && n.expression.getText(sf) === 'Date' && !n.arguments?.length)
    if (read) {
      const f = enclosing(n)
      const memo = f?.parent && ts.isCallExpression(f.parent) && /^(React\.)?useMemo$/.test(f.parent.expression.getText(sf))
      if (f && (drawsWith(f) || (memo && drawsWith(enclosing(f.parent))))) {
        out.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function scan(): Map<string, number> {
  const byFile = new Map<string, number>()
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name) || /\.test\./.test(e.name)) continue
      const src = fs.readFileSync(p, 'utf8')
      if (!/Date\.now\(|new Date\(\)/.test(src)) continue
      const rel = path.relative(ROOT, p).split(path.sep).join('/')
      const n = renderClockReads(src, rel).length
      if (n) byFile.set(rel, n)
    }
  }
  walk(WEB)
  return byFile
}

describe('time windows judged at a render (web/src)', () => {
  const found = scan()

  it('finds a read in each form it looks for, and none in a handler or an effect', () => {
    const src = [
      'export function Card({ at }) { const shown = Date.now() - at < 6e4; return shown ? 1 : 0 }',
      'export const Row = memo(function Row({ at }) { const old = useMemo(() => Date.now() - at > 1, [at]); return old })',
      'export function useOpen(x) { return new Date() > x }',
      // Not members: inside an effect, a handler, a module function.
      'export function Quiet() { useEffect(() => { log(Date.now()) }, []); const onClick = () => Date.now(); return null }',
      'function helper() { return Date.now() }',
    ].join('\n')
    expect(renderClockReads(src, 'x.tsx')).toEqual(['x.tsx:1', 'x.tsx:2', 'x.tsx:3'])
  })

  it('has no read outside the pinned ones: read the minute clock (useMinuteValue / useMinuteNow)', () => {
    const fresh = [...found].filter(([f, n]) => n > (PINNED[f]?.n ?? 0)).map(([f, n]) => `${f}: ${n} (pinned ${PINNED[f]?.n ?? 0})`)
    expect(fresh, 'a view judges a time window by the wall clock at its render, so only an unrelated draw ends the window: use useMinuteValue((now) => ...) or useMinuteNow() from web/src/utils/minute-clock.ts').toEqual([])
  })

  it('every pin is still needed (lower it when a read goes)', () => {
    const stale = Object.entries(PINNED).filter(([f, p]) => (found.get(f) ?? 0) < p.n).map(([f, p]) => `${f}: ${found.get(f) ?? 0} (pinned ${p.n})`)
    expect(stale).toEqual([])
  })

  it('the windows of 2026-11-25 read the minute clock', () => {
    for (const f of ['web/src/components/sessions/SessionSupervisionBar.tsx', 'web/src/components/org/OrgInlineAnswer.tsx', 'web/src/components/org/ThreadLetterAnswer.tsx', 'web/src/components/tasks/ChangeCard.tsx', 'web/src/components/actions/ActionNeeded.tsx', 'web/src/components/common/StaleBuildPill.tsx', 'web/src/components/settings/sections/backup/RestorePanel.tsx', 'web/src/components/tasks/fallback-row.tsx', 'web/src/components/settings/sections/FallbackEngineRow.tsx', 'web/src/components/passwords/AgentActivity.tsx', 'web/src/components/tasks/StatusSections.tsx']) {
      expect(found.get(f) ?? 0, f).toBe(0)
      expect(fs.readFileSync(path.join(ROOT, f), 'utf8'), f).toMatch(/\buseMinute(Value|Now)\(/)
    }
  })
})
