/**
 * On the phone, a tapped task opens its SESSION, never its task page first (2026-11-04, the
 * user: "always jump straight to the session"). The task page opens only for a task that has
 * never had a session, or where the user asked for the page itself (a "Details" or
 * "Task Details" item).
 *
 * The guard reads the iOS source. Every place that builds the task page (`TaskDetailSheet(`)
 * must be the one opener (`TaskSessionSheet`, which opens the page only for a sessionless
 * task) or be listed below with why it is a request for the page. Every task opened by id
 * (`TaskOpenTarget(`) must be presented through `TaskSessionSheet`, and every timeline
 * `.openTask` action too. A new entry that opens the task page fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const APP = path.join(ROOT, 'ios-native/Walnut')

/** Files that build the task page on purpose, with why. */
const OPENS_THE_PAGE: Record<string, string> = {
  'Views/Tasks/TaskSessionSheet.swift': 'the one opener: the task page only when the task has no session',
  'Views/Tasks/TasksView.swift': 'the board row long-press "Details" item and the recents row details button',
  'Views/Sessions/SessionConversationView.swift': 'the session title and its "Task Details" menu item: the page of the task the user is already in',
  'Views/Sessions/SessionTaskRow.swift': 'the task row inside a session\'s info sheet: the page of the task the user is already in',
}

function swiftFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) swiftFiles(p, out)
    else if (e.name.endsWith('.swift')) out.push(p)
  }
  return out
}

/** Source without line comments, so a comment naming a type is not a use of it. */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')
}

const files = swiftFiles(APP).map((f) => ({ rel: path.relative(APP, f), src: code(f) }))

describe('iOS task taps open the session', () => {
  it('builds the task page only in the opener and the listed requests for the page', () => {
    const builders = files.filter((f) => /\bTaskDetailSheet\(/.test(f.src)).map((f) => f.rel).sort()
    const unlisted = builders.filter((rel) => !(rel in OPENS_THE_PAGE))
    expect(unlisted, 'open the task through TaskSessionSheet, or list the file with why it asks for the page').toEqual([])
    // A listed file that no longer builds the page is dropped from the list.
    expect(Object.keys(OPENS_THE_PAGE).filter((rel) => !builders.includes(rel))).toEqual([])
  })

  it('presents every task opened by id through TaskSessionSheet', () => {
    const bad = files
      .filter((f) => f.rel !== 'Views/Tasks/TaskSessionSheet.swift')
      .filter((f) => /\bTaskOpenTarget\(/.test(f.src) && !/\bTaskSessionSheet\(target:/.test(f.src))
      .map((f) => f.rel)
    expect(bad).toEqual([])
  })

  it('routes every timeline task pill and task link to TaskSessionSheet', () => {
    const handlers = files.filter((f) => /case \.openTask\(let /.test(f.src))
    expect(handlers.length).toBeGreaterThanOrEqual(2)
    const links = files.filter((f) => /walnut-task/.test(f.src) && /openURL|OpenURLAction/.test(f.src))
    for (const f of [...handlers, ...links]) {
      expect(f.src, `${f.rel} opens a task without TaskSessionSheet`).toMatch(/\bTaskSessionSheet\(target:/)
    }
  })

  it('starts a session for a task only from its own page, never from a tap on the task', () => {
    // A tap on a sessionless task on the Tasks tab once opened a New Session draft (2026-11-04
    // review): the task's page is where its New Session lives. The tab's own draft is task-less.
    const drafts = files.filter((f) => /\bNewSession(ChatView|Sheet)\(/.test(f.src)).map((f) => f.rel).sort()
    expect(drafts).toEqual(['Views/Tasks/TaskDetailSheet.swift', 'Views/Tasks/TasksTabView.swift'])
    const tab = files.find((f) => f.rel === 'Views/Tasks/TasksTabView.swift')!.src
    expect(tab).toMatch(/if let taskId = seed\.taskId \{\s*[^]*?TaskSessionSheet\(target:/)
  })

  it('keeps no second task-by-id page', () => {
    for (const gone of ['InboxTaskSheet', 'InboxTaskDestination', 'InboxItemReadOnlyTaskSheet']) {
      expect(files.filter((f) => new RegExp(`\\b${gone}\\b`).test(f.src)).map((f) => f.rel), gone).toEqual([])
    }
  })
})
