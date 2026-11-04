/**
 * Guard: every way the person opens a task records it for the Recent tab
 * (web/src/utils/recent-opened.ts), and a load putting the screen back never does.
 *
 * 2026-11-06, the user: Recent should list "the recent opened not recently updated ... so user
 * can find" what they just looked at. The class: a path that shows a task (focuses its row, opens
 * its detail or session, picks it in the chat slot or on the Org page) but leaves no open behind,
 * so the task is missing from Recent. This test enumerates the members from the source:
 *  1. Home: every non-null `setFocusedTask(...)` either bumps the focus nonce in the same
 *     statement (the nonce effect records it) or is listed below as a restore;
 *  2. Home: a session column opened through openSessionOrToast records, and only the phone's
 *     reload restore passes `restore: true`; a task shown from outside the list records;
 *  3. the chat slot: every `setSelectedTaskId(...)` is a recorded pick or listed as not one;
 *  4. Org: a node picked and a task or session opened beside the page record.
 * A new member fails here until it records or is listed with why it is not an open.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '../..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const lines = (src: string) => src.split('\n')

/** The line, and the two after it: one statement's reach. */
const around = (ls: string[], i: number) => ls.slice(i, i + 3).join('\n')

describe('Home (pages/MainPage.tsx)', () => {
  const src = read('web/src/pages/MainPage.tsx')
  const ls = lines(src)

  it('the focus nonce records the focused task, once per bump', () => {
    expect(src).toContain('if (focusNonce > 0) recordTaskOpened(focusedTaskRef.current?.id);')
  })

  it('every focus is a recorded open (nonce bumped) or a listed restore', () => {
    /** Focuses that are not the person opening a task, and why. */
    const RESTORES: Array<[RegExp, string]> = [
      [/^\s*setFocusedTask\(task\);\s*$/, 'restoreFocus: a load brings the focus back (paired with setSuppressDetail(true))'],
      [/else setFocusedTask\(task\);/, "the URL's Back/Forward: the person stepping back to a place, not opening a task"],
      [/setFocusedTask\(task\); \/\/ the list follows a column already open/, 'a key moving between session columns: the list follows a column whose open was recorded already'],
    ]
    const unlisted: string[] = []
    let restores = 0
    ls.forEach((line, i) => {
      if (!/setFocusedTask\((?!null\))/.test(line)) return
      if (/setFocusNonce\(/.test(around(ls, i))) return
      if (/restoreFocus|setSuppressDetail\(true\)/.test(around(ls, i)) || RESTORES.some(([re]) => re.test(line))) { restores += 1; return }
      unlisted.push(`${i + 1}: ${line.trim()}`)
    })
    expect(unlisted).toEqual([])
    expect(restores).toBe(RESTORES.length)
  })

  it('a session column opened is an open, except the phone reload restore', () => {
    expect(src).toMatch(/if \(!opts\?\.restore\) recordTaskOpened\(taskIdOfSession\(/)
    expect(src.match(/restore: true/g) ?? []).toHaveLength(1)
    expect(src).toContain('openSession: (sid) => openSessionOrToast(sid, { restore: true }),')
  })

  it('a task shown from outside the list is an open', () => {
    expect(src).toMatch(/setOutsideTask\(full as Task\);\s*\n\s*recordTaskOpened\(full\.id\);/)
  })
})

describe('the chat slot (components/chat/AskWalnutSlot.tsx)', () => {
  const src = read('web/src/components/chat/AskWalnutSlot.tsx')
  const ls = lines(src)

  it('every selection is a recorded pick or listed as not one', () => {
    /** Selections that are not the person picking a task, and why. */
    const NOT_PICKS: Array<[RegExp, string]> = [
      [/setSelectedTaskId\(MAIN_PICK\); return; \}/, 'the slot falls back to Main (its pick resolved to Main)'],
      [/if \(!keep\) setSelectedTaskId\(MAIN_PICK\);/, 'the shown ask left the list: back to Main'],
      [/if \(next !== selectedTaskId\) setSelectedTaskId\(next\);/, 'the selection resolving against the loaded asks'],
      [/setSelectedTaskId\(next\.id === GENERAL_AGENT_ID/, 'another agent picked: its default ask, not a task the person chose'],
    ]
    const unlisted: string[] = []
    let notPicks = 0
    ls.forEach((line, i) => {
      if (!/setSelectedTaskId\(/.test(line) || /useState/.test(line)) return
      if (/recordTaskOpened\(/.test(ls.slice(Math.max(0, i - 2), i + 2).join('\n'))) return
      if (NOT_PICKS.some(([re]) => re.test(line))) { notPicks += 1; return }
      unlisted.push(`${i + 1}: ${line.trim()}`)
    })
    expect(unlisted).toEqual([])
    expect(notPicks).toBe(NOT_PICKS.length)
  })
})

describe('Org (pages/OrgPage.tsx)', () => {
  const src = read('web/src/pages/OrgPage.tsx')
  const ls = lines(src)

  it('a node picked is an open, a led project as itself (Main left out)', () => {
    expect(src).toMatch(/if \(key !== MAIN_KEY\) \{\s*\n\s*const row = rowOf\(channelsRef\.current, key\);\s*\n\s*recordTaskOpened\(\(row\?\.key === key \? row : row\?\.led\?\.find\(\(l\) => l\.key === key\)\)\?\.contactId\);/)
  })

  it('every panel opened beside the page records its task', () => {
    const opens = ls.map((line, i) => [line, i] as const).filter(([line]) => /openSide\(\{ kind: '(task|session)'/.test(line))
    expect(opens.length).toBeGreaterThan(0)
    for (const [line, i] of opens) expect(ls[i - 1], line.trim()).toMatch(/recordTaskOpened\(/)
  })
})
