/**
 * Every surface of the browser extension's frame that draws a task's second line (the drawer's and
 * Continue's ask rows, the kept Continue rows, the Tasks view's rows and their drawing, the open
 * row's last message) gets its words from ONE place: ext-tasks-model.ts (taskWords, askRowDetail,
 * needsRowLine, rowLine), fed by ONE reader of conversations (ask-words-read.ts, which reads a
 * chat's history too). Review 2026-11-06 round 4: the round-3 words reached the drawer but not the
 * Tasks view (29 of 30 rows read "Take a look"), and neither read a chat whose history lives in
 * chat history. Enumerated from the sources, so a new surface that reads words its own way fails.
 *
 * And ONE place decides whether a row needs the person (its red dot, the Tasks badge): the model's
 * helpers (readHere, askRowDetail, extTaskLists, needsCount), from Walnut's status and read marker.
 * The frame never marks an answer read itself: the embedded SessionPanel does, on the person's first
 * click or keystroke, as on Home (round 4 code review: a display-based read cleared answers nobody
 * had seen, and retried a refused write in a loop).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.resolve(__dirname, '../../web/src/popout')
/** Every source file under the frame's folder, nested folders included, by its path from there. */
const files = (fs.readdirSync(DIR, { recursive: true }) as string[])
  .map((f) => f.split(path.sep).join('/'))
  .filter((f) => /\.(ts|tsx)$/.test(f) && fs.statSync(path.join(DIR, f)).isFile())
const code = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
/** A row line drawn: the class in a className, as a literal, a template or an expression. */
const DRAWS_LINE = /className=\{?[^>\n]*?\b(?:ask-walnut-drawer-item-line|ext-task-line)\b/

/** Where a task's words come from, and the only files that may read each. */
const SOURCES: Array<[RegExp, string, string[]]> = [
  // Any read of a conversation: the session's transcript (any of its readers or routes), the chat's
  // earlier part, a chat's messages or history, a history hook, Walnut's task_history op.
  [/\bfetch(?:Session|Subagent|Chat|Triage)History\w*\b|\/chat-earlier\b|\/messages(?=[/'"`?]|$)|\/history(?=[/'"`?]|$)|\buse\w*History\b|\btask_history\b/m, 'a conversation read', ['ask-words-read.ts']],
  [/\blastWordsOfStatus\b|\.last_words\b|\bneedsLineOf\b/, "Walnut's words of a task", ['ext-tasks-model.ts']],
  [/\bkeptWords\(/, "this browser's read of a conversation", ['ext-ask-words.ts', 'ext-tasks-model.ts', 'useExtAsks.ts']],
  // Whether a task needs the person: its status and its read marker.
  [/\.unread\b|\.user_status\b|\b(?:taskUserState|shownState|storedUserState|taskNeedsAction)\(/, 'whether a row needs the person', ['ext-tasks-model.ts']],
]

describe('one source of a row\'s words in the extension frame', () => {
  it('found the surfaces (the scan reads what it should)', () => {
    const drawing = files.filter((f) => DRAWS_LINE.test(code(f)))
    expect(drawing.sort()).toEqual(['ExtAskChrome.tsx', 'PopoutExtTasks.tsx'])
  })

  for (const [re, what, allowed] of SOURCES) {
    it(`${what} only in ${allowed.join(', ')}`, () => {
      const readers = files.filter((f) => re.test(code(f)))
      expect(readers.filter((f) => !allowed.includes(f)), `read ${what} through ext-tasks-model.ts / ask-words-read.ts instead`).toEqual([])
    })
  }

  it('every file that draws a row\'s line gets it from the model\'s helpers', () => {
    for (const f of files) {
      const src = code(f)
      if (!DRAWS_LINE.test(src)) continue
      expect(/\baskRowDetail\(|\browLine\(/.test(src), `${f} draws a row's line: take it from askRowDetail or rowLine`).toBe(true)
    }
    // The drawer's rows (Home's AskWalnutDrawer in its panel shape) are given the same helper.
    for (const f of files) {
      for (const m of code(f).matchAll(/\browDetail:\s*([\w.]+)/g)) expect(m[1], f).toBe('askRowDetail')
    }
  })

  it('the frame never marks an answer read itself (SessionPanel does, on a click or a keystroke)', () => {
    const writers = files.filter((f) => /\b(?:update|updateTask)\w*\([^)]*\bunread\b/.test(code(f)))
    expect(writers).toEqual([])
  })

  it('the scan catches a className written as a template or an expression', () => {
    expect(DRAWS_LINE.test('<span className={`ext-task-line ${x}`}>')).toBe(true)
    expect(DRAWS_LINE.test("<span className={cn('ask-walnut-drawer-item-line', on && 'is-on')}>")).toBe(true)
    expect(DRAWS_LINE.test("el.querySelector('.ext-task-line')")).toBe(false)
  })

  it('the Tasks view reads its rows\' words the way the drawer does', () => {
    const tasks = code('PopoutExtTasks.tsx')
    expect(tasks).toMatch(/\buseAskWords\(/)
    expect(code('useExtAsks.ts')).toMatch(/\blatestReplies\(/)
    expect(tasks).toMatch(/\blatestReplies\(/)
  })
})
