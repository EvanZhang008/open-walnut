/**
 * What a brand-new task and its project are called before any model names them
 * (2026-11-10 review: a new user's first New task read "New project: ~" in the draft and
 * "Session: <folder>" on the board). A folder that says nothing about the work (the home
 * folder, an id, the root) never names a task, and the home folder's project is "Home",
 * the same on the draft (draft-column.ts) and at the launch (folder-project.ts). A New task a
 * person typed words into is named by those words from ANY folder (review round 2: "Second task"
 * from ~/Projects read "Session: Projects"); "Session: <folder>" is left for a launch with no words.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { folderBaseName, folderProjectName, HOME_PROJECT_NAME } from '../../../src/core/sessions/folder-project.js'
import { folderNamesNoWork } from '../../../src/core/sessions/quick-start.js'

const valid = (name: string) => !!name.trim() && !name.includes('/') && name !== '~'

describe('a folder that names no work names no task', () => {
  it('the home folder, the root and id-named folders say nothing; a named folder does', () => {
    for (const dir of ['~', '~/', '', '/', '/Users/sam', '/Users/sam/', '/d/homes/501afb78-a4c3-4b8b-90e5-6dc04f7f7ee4', '/x/0123456789abcdef0123']) {
      expect(folderNamesNoWork(dir, '/Users/sam'), dir).toBe(true)
    }
    for (const dir of ['/Users/sam/tidepool', '/work/walnut', '/Users', '~/notes', '/x/Home']) {
      expect(folderNamesNoWork(dir, '/Users/sam'), dir).toBe(false)
    }
    // Without a known home (a remote host), only `~` itself is the home.
    expect(folderNamesNoWork('/Users/sam')).toBe(false)
  })
})

describe('the home folder\'s project is "Home"', () => {
  const none = () => false
  it('on the launch: `~` and the home path, grown like any other name when taken', () => {
    expect(folderBaseName('~')).toBe(HOME_PROJECT_NAME)
    expect(folderBaseName('/Users/sam/', '/Users/sam')).toBe(HOME_PROJECT_NAME)
    expect(folderBaseName('/Users/sam')).toBe('sam')
    expect(folderProjectName('/Users/sam', null, none, valid, '/Users/sam')).toBe('Home')
    // Its parent (/Users) says nothing about it, so a taken "Home" goes to a number.
    expect(folderProjectName('/Users/sam', null, (n) => n === 'Home', valid, '/Users/sam')).toBe('Home 2')
    // A folder that is really named Home keeps its parent step.
    expect(folderProjectName('/x/Home', null, (n) => n === 'Home', valid, '/Users/sam')).toBe('x-Home')
  })
})

describe('guard: every new-task title and folder-project name goes through the rule', () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, '../../../src', rel), 'utf8')
  it('quick-start decides the words title by folderNamesNoWork, and refines any cut words title', () => {
    const qs = src('core/sessions/quick-start.ts')
    expect(qs).toMatch(/folderNamesNoWork\(cwd, home\)/)
    // The refine kick is outside the own-task-dir branch, so every words title gets it.
    const kick = qs.indexOf('refineShortTitle(id, wordsTitle, message)')
    const ownDir = qs.indexOf('if (inOwnTaskDir) {')
    expect(kick).toBeGreaterThan(0)
    const ownDirEnd = qs.indexOf('\n    }\n', ownDir)
    expect(kick).toBeGreaterThan(ownDirEnd)
  })
  it('a person\'s typed words title every New task, from any folder; an Ask, a command or an agent do not', () => {
    const qs = src('core/sessions/quick-start.ts')
    // The words title is decided by who typed, not only by the folder.
    expect(qs).toMatch(/const personTyped = isPersonSource\(source\) && !isCommandLine\(message\);/)
    expect(qs).toMatch(/\(inOwnTaskDir \|\| !askAgent && \(personTyped \|\| folderNamesNoWork\(cwd, home\)\)\) && !params\.taskTitle\?\.trim\(\) \? titleFromWords\(message\)/)
    // Still refined in the background: the launch auto-title takes the words title as its placeholder.
    expect(qs).toMatch(/\?\? \(launchWordsTitle && updatedTask\.title === launchWordsTitle \? launchWordsTitle : undefined\)/)
  })
  it('every title a new task is created with is the caller\'s, the words title or the placeholder', () => {
    // A new title source added beside these three would skip the rule above.
    const qs = src('core/sessions/quick-start.ts')
    expect(qs).toMatch(/const title = params\.taskTitle\?\.trim\(\) \|\| wordsTitle \|\| placeholderTitle;/)
    expect(qs.match(/const title = params\./g)?.length).toBe(1)
    expect(qs.match(/addTask\(\{[^}]*?\btitle\b/gs)?.length ?? 0).toBeLessThanOrEqual(1)
  })
  it('the folder project name comes from folderBaseName on the server, and ensureFolderProject passes the home', () => {
    expect(src('core/sessions/folder-project.ts')).toMatch(/const base = folderBaseName\(cwd, home\)/)
    expect(src('core/task-manager.ts')).toMatch(/folderProjectFor\(store\.projects \?\? \{\}, cwd, host, isValidProjectName, home\)/)
  })
})
