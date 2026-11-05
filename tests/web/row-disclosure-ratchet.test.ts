/**
 * Every disclosure a chat row draws (a tool run, a tool card, the reasoning, a
 * diff, a details block) keeps its open state in the row-disclosure store, so it
 * stays as the reader left it when the row is drawn again: the live block gives
 * way to its saved row, a person's message sent mid-turn is saved, a subagent's
 * lane becomes its transcript (2026-11-01, the user: streaming and finished must
 * look exactly the same, "no flash, no change of format"; an expanded run folded
 * shut when a mid-turn message was saved).
 *
 * The class: open state held in a row component alone. This walks every
 * component a row can draw (the import closure of the row renderers) and fails on
 * an open/expanded/collapsed/show state from `useState`, or an uncontrolled
 * `<details>`, unless it is listed below with why it is not a row's disclosure.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

const WEB = join(__dirname, '../../web/src')
const ROOTS = [
  'components/sessions/SessionMessage.tsx',
  'components/sessions/StreamingBlockView.tsx',
  'components/sessions/LaneTimeline.tsx',
  'components/sessions/WorkflowTranscriptModal.tsx',
  'components/sessions/SessionChatHistory.tsx',
]

/** `file:state` → why it is not a row's disclosure. */
const NOT_ROW_STATE: Record<string, string> = {
  'components/sessions/BashToolCall.tsx:popupOpen': 'a modal over the page, closed on any rebuild by design',
  'components/sessions/PermissionNoteBox.tsx:open': "a toast's or the panel's note box (DenyWithNote), never a chat row; once words are typed the draft keeps it open",
  'components/common/MicButton.tsx:showChevron': 'the composer mic, not a chat row',
  'components/common/MicButton.tsx:dropdownOpen': 'the composer mic menu',
  'components/common/MicButton.tsx:expandedId': 'the composer mic menu',
  // The chat itself: one long-lived component that no handover rebuilds.
  'components/sessions/SessionChatHistory.tsx:firstCheckShown': 'which held blocks show, not a disclosure',
  'components/sessions/SessionChatHistory.tsx:foldOverrides': 'Conversation Mode fold choices, held by the chat itself',
  'components/sessions/SessionChatHistory.tsx:cardOpen': 'the Ask here card over the chat',
  'components/sessions/SessionChatHistory.tsx:mapDoneOpen': 'the thread map beside the chat',
  'components/sessions/ChatEarlierBlock.tsx:expanded': 'how many earlier pages are loaded, saved rows only',
  'components/sessions/TaskEarlierSessions.tsx:open': 'earlier sessions of the task, saved rows only',
  'components/sessions/WorkflowProgress.tsx:expandedAgent': 'the Background ledger, pinned above the chat',
  'components/sessions/WorkflowProgress.tsx:showScript': 'the Background ledger, pinned above the chat',
  'components/sessions/WorkflowProgress.tsx:collapseOverride': 'the Background ledger, pinned above the chat',
  // Popovers and menus: closed by any rebuild, as a menu is.
  'components/sessions/PassageCommentMarks.tsx:open': 'a passage comment popover',
  'components/sessions/QuotePinPopover.tsx:open': 'a quote-pin popover',
  'components/sessions/QuotePinSelectionBar.tsx:commentOpen': 'the selection bar comment box',
  'components/sessions/SessionPinnedToc.tsx:open': 'the pinned-messages menu',
  'components/sessions/ThreadCommentCard.tsx:expanded': 'a comment card in the side thread, not a chat row',
  'components/sessions/ThreadMap.tsx:open': 'the thread map menu',
  'components/sessions/ThreadStackMenu.tsx:open': 'the thread stack menu',
}

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = join(WEB, spec.slice(2))
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec))
  else return null
  for (const ext of ['.tsx', '/index.tsx']) if (existsSync(base + ext)) return base + ext
  return null
}

function rowComponentFiles(): string[] {
  const seen = new Set<string>()
  const stack = ROOTS.map((r) => join(WEB, r))
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      const r = resolveImport(f, m[1])
      if (r && r.includes('/components/')) stack.push(r)
    }
  }
  return [...seen].map((f) => relative(WEB, f)).sort()
}

describe('row disclosures survive a rebuild', () => {
  const files = rowComponentFiles()

  it('walks the row components', () => {
    for (const f of ['components/sessions/SessionMessage.tsx', 'components/sessions/BashToolCall.tsx', 'components/sessions/SessionOutboundCard.tsx', 'components/sessions/InjectedBannerRow.tsx']) {
      expect(files, `${f} is not reached from the row renderers`).toContain(f)
    }
  })

  it('no open state lives in a row component alone', () => {
    const offenders: string[] = []
    const seenAllowed = new Set<string>()
    for (const f of files) {
      // Comments name tags and states too; only code counts.
      const src = readFileSync(join(WEB, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const m of src.matchAll(/const \[(\w+),\s*set\w*\]\s*=\s*useState\b/g)) {
        if (!/open|expand|collaps|show|fold/i.test(m[1])) continue
        const key = `${f}:${m[1]}`
        if (NOT_ROW_STATE[key]) { seenAllowed.add(key); continue }
        offenders.push(`${key} (use useRowDisclosure with an id the live row and its saved twin share)`)
      }
      for (const m of src.matchAll(/<details(\s[^>]*)?>/g)) {
        if (/\{\.\.\.|open=/.test(m[1] ?? '')) continue
        offenders.push(`${f}: an uncontrolled <details> (spread useDetailsDisclosure onto it)`)
      }
    }
    expect(offenders).toEqual([])
    // A listed state that is gone is a stale entry.
    expect(Object.keys(NOT_ROW_STATE).filter((k) => !seenAllowed.has(k))).toEqual([])
  })

  it('every surface that draws session rows gives them their session scope', () => {
    for (const f of ['components/sessions/SessionChatHistory.tsx', 'components/sessions/WorkflowTranscriptModal.tsx']) {
      expect(readFileSync(join(WEB, f), 'utf8'), f).toContain('RowDisclosureScope.Provider')
    }
  })
})
