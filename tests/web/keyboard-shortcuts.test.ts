/**
 * The keyboard shortcuts (web/src/keyboard/shortcuts.ts): each place gets the chords its
 * browser leaves to the page (Cmd in the Mac app, Ctrl in a Mac browser, Alt elsewhere for
 * session switching), and the shortcuts sheet names only keys something handles: every row
 * of the sheet is matched here to its handler, so a row added without one (or a handler
 * removed under a row) fails.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cycleDir, envNote, isCompleteNextChord, isFocusComposerChord, isHelpChord, isJumpHintModifier,
  jumpBadgeLabel, jumpIndex, shortcutGroups, type KeyEnv,
} from '../../web/src/keyboard/shortcuts'

type K = { key: string; code: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }
const ev = (k: K) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...k })
const digit = (n: number, mods: Partial<K>) => ev({ key: String(n), code: `Digit${n}`, ...mods })

describe('session switching takes the modifier the place leaves free', () => {
  it('Mac app: Cmd+1..9, Cmd+Shift+[ ]', () => {
    expect(jumpIndex(digit(1, { metaKey: true }), 'mac-app')).toBe(1)
    expect(jumpIndex(digit(9, { metaKey: true }), 'mac-app')).toBe(9)
    expect(jumpIndex(digit(1, { ctrlKey: true }), 'mac-app')).toBe(0)
    expect(jumpIndex(digit(1, { metaKey: true, shiftKey: true }), 'mac-app')).toBe(0)
    expect(cycleDir(ev({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true }), 'mac-app')).toBe(-1)
    expect(cycleDir(ev({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true }), 'mac-app')).toBe(1)
    // Cmd+[ without Shift is Tree Mode's pair move (usePanelKeyRouter), not ours.
    expect(cycleDir(ev({ key: '[', code: 'BracketLeft', metaKey: true }), 'mac-app')).toBe(0)
  })

  it('Mac browser: Control, since Cmd+digit switches the browser tab', () => {
    expect(jumpIndex(digit(3, { metaKey: true }), 'mac-browser')).toBe(0)
    expect(jumpIndex(digit(3, { ctrlKey: true }), 'mac-browser')).toBe(3)
    expect(cycleDir(ev({ key: '}', code: 'BracketRight', ctrlKey: true, shiftKey: true }), 'mac-browser')).toBe(1)
  })

  it('elsewhere: Alt, read from the physical key (no layout or special character changes it)', () => {
    expect(jumpIndex(digit(2, { ctrlKey: true }), 'other')).toBe(0)
    expect(jumpIndex(ev({ key: '\u2122', code: 'Digit2', altKey: true }), 'other')).toBe(2)
    expect(jumpIndex(ev({ key: '0', code: 'Digit0', altKey: true }), 'other')).toBe(0)
  })

  it('the column badges and the hold that shows them follow the same modifier', () => {
    expect(jumpBadgeLabel(1, 'mac-app')).toBe('\u23181')
    expect(jumpBadgeLabel(4, 'mac-browser')).toBe('\u23034')
    expect(jumpBadgeLabel(2, 'other')).toBe('Alt+2')
    expect(isJumpHintModifier(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }), 'mac-app')).toBe(true)
    expect(isJumpHintModifier(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true, shiftKey: true }), 'mac-app')).toBe(false)
    expect(isJumpHintModifier(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), 'mac-browser')).toBe(true)
    expect(isJumpHintModifier(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }), 'mac-browser')).toBe(false)
  })
})

describe('task and help chords', () => {
  const envs: KeyEnv[] = ['mac-app', 'mac-browser', 'other']
  it('mod+I focuses the composer and mod+Shift+D completes and goes on, with the ordinary modifier', () => {
    for (const env of envs) {
      const mod = env === 'other' ? { ctrlKey: true } : { metaKey: true }
      expect(isFocusComposerChord(ev({ key: 'i', code: 'KeyI', ...mod }), env)).toBe(true)
      expect(isFocusComposerChord(ev({ key: 'I', code: 'KeyI', ...mod, shiftKey: true }), env)).toBe(false)
      expect(isCompleteNextChord(ev({ key: 'D', code: 'KeyD', ...mod, shiftKey: true }), env)).toBe(true)
      expect(isCompleteNextChord(ev({ key: 'd', code: 'KeyD', ...mod }), env)).toBe(false)
      expect(isCompleteNextChord(ev({ key: 'D', code: 'KeyD', ...mod, shiftKey: true, altKey: true }), env)).toBe(false)
    }
  })

  it('the composer key also takes the session modifier, so elsewhere Alt+I sits with Alt+1..9', () => {
    expect(isFocusComposerChord(ev({ key: '\u02c6', code: 'KeyI', altKey: true }), 'other')).toBe(true)
    expect(isFocusComposerChord(ev({ key: 'i', code: 'KeyI', ctrlKey: true }), 'mac-browser')).toBe(true)
    expect(isFocusComposerChord(ev({ key: 'i', code: 'KeyI', altKey: true }), 'mac-app')).toBe(false)
    const row = (env: KeyEnv) => shortcutGroups(env)[0].rows.find((r) => r.id === 'composer.focus')!.keys[0]
    expect(row('other')).toEqual(['Alt', 'I'])
    expect(row('mac-app')).toEqual(['\u2318', 'I'])
  })

  it('? opens the sheet only outside a text box; mod+/ anywhere', () => {
    expect(isHelpChord(ev({ key: '?', code: 'Slash', shiftKey: true }), 'mac-app', false)).toBe(true)
    expect(isHelpChord(ev({ key: '?', code: 'Slash', shiftKey: true }), 'mac-app', true)).toBe(false)
    expect(isHelpChord(ev({ key: '/', code: 'Slash', metaKey: true }), 'mac-app', true)).toBe(true)
    expect(isHelpChord(ev({ key: '/', code: 'Slash', ctrlKey: true }), 'other', true)).toBe(true)
    expect(isHelpChord(ev({ key: '/', code: 'Slash' }), 'mac-app', false)).toBe(false)
  })

  it('a browser says why its session keys differ from the app', () => {
    expect(envNote('mac-app')).toBeNull()
    expect(envNote('mac-browser')).toMatch(/Control/)
    expect(envNote('other')).toMatch(/Alt/)
  })
})

describe('the sheet names only handled keys', () => {
  const web = (p: string) => readFileSync(path.resolve(import.meta.dirname, '../../web/src', p), 'utf8')
  // Each row: where its key is handled, and a line that only that handler has.
  const HANDLERS: Record<string, { file: string; has: RegExp }> = {
    'session.jump': { file: 'pages/useHomeKeyboard.ts', has: /jumpIndex\(e, env\)/ },
    'session.last': { file: 'pages/useHomeKeyboard.ts', has: /n === 9 \? ids\[ids\.length - 1\]/ },
    'session.numbers': { file: 'pages/useHomeKeyboard.ts', has: /isJumpHintModifier\(e, env\)/ },
    'session.cycle': { file: 'pages/useHomeKeyboard.ts', has: /cycleDir\(e, env\)/ },
    'composer.focus': { file: 'pages/useHomeKeyboard.ts', has: /isFocusComposerChord\(e, env\)/ },
    'task.completeNext': { file: 'pages/useHomeKeyboard.ts', has: /isCompleteNextChord\(e, env\)/ },
    'undo': { file: 'undo/TaskUndoContext.tsx', has: /undoKeyApplies\(e, active\)/ },
    'help': { file: 'keyboard/ShortcutsHelp.tsx', has: /isHelpChord\(e, detectKeyEnv\(\)/ },
    'session.find': { file: 'pages/MainPage.tsx', has: /e\.shiftKey && \(e\.key === 'o' \|\| e\.key === 'O'\)/ },
    'session.new': { file: 'pages/MainPage.tsx', has: /e\.shiftKey && e\.key === 'Enter'/ },
    'session.drawer': { file: 'hooks/usePanelKeyRouter.ts', has: /isDrawerChord\(e, isMacPlatform\(\)\)/ },
    'task.search': { file: 'components/tasks/TodoSearchBar.tsx', has: /e\.key === 'k'/ },
    'task.filter': { file: 'components/tasks/useHomeFilters.ts', has: /e\.key !== 'f' && e\.key !== 'F'/ },
    'page.find': { file: 'components/common/PageFind.tsx', has: /isFindChord/ },
    'escape': { file: 'pages/MainPage.tsx', has: /e\.key === 'Escape' && focusedTaskRef\.current/ },
  }

  it('every row of the sheet has its handler', () => {
    const rows = shortcutGroups('mac-app').flatMap((g) => g.rows)
    expect(rows.length).toBeGreaterThan(8)
    for (const row of rows) {
      const h = HANDLERS[row.id]
      expect(h, `the sheet lists "${row.id}" (${row.label}) but no handler is named for it here`).toBeDefined()
      expect(web(h.file), `"${row.id}" names ${h.file}, which no longer handles it`).toMatch(h.has)
    }
  })

  // GETTING_STARTED.md lists the same sheet as a table, so the doc can never name a key the
  // app does not have. WALNUT_WRITE_SHORTCUTS_DOC=1 rewrites the block from the sheet.
  it('the Getting Started table is the sheet, for every place', () => {
    const chord = (keys: string[], env: KeyEnv) => '`' + keys.join(env === 'other' ? '+' : '') + '`'
    const cell = (row: ReturnType<typeof shortcutGroups>[number]['rows'][number], env: KeyEnv) =>
      row.keys.map((k) => chord(k, env)).join(` ${row.sep ?? 'or'} `)
    const envs: KeyEnv[] = ['mac-app', 'mac-browser', 'other']
    const lines: string[] = []
    shortcutGroups('mac-app').forEach((g, gi) => {
      lines.push(`**${g.title}**`, '', '| Action | Mac app | Browser on a Mac | Windows and Linux |', '|---|---|---|---|')
      g.rows.forEach((row, ri) => {
        const cells = envs.map((env) => cell(shortcutGroups(env)[gi].rows[ri], env))
        lines.push(`| ${row.label} | ${cells.join(' | ')} |`)
      })
      lines.push('')
    })
    const block = `<!-- shortcuts:start -->\n${lines.join('\n')}<!-- shortcuts:end -->`
    const docPath = path.resolve(import.meta.dirname, '../../GETTING_STARTED.md')
    const doc = readFileSync(docPath, 'utf8')
    const re = /<!-- shortcuts:start -->[\s\S]*?<!-- shortcuts:end -->/
    expect(doc, 'GETTING_STARTED.md lost its shortcuts block').toMatch(re)
    if (process.env.WALNUT_WRITE_SHORTCUTS_DOC === '1') writeFileSync(docPath, doc.replace(re, block))
    else expect(doc.match(re)![0], 'run with WALNUT_WRITE_SHORTCUTS_DOC=1 to rewrite it').toBe(block)
  })

  it('every place gets the same rows, in its own keys', () => {
    const ids = (env: KeyEnv) => shortcutGroups(env).flatMap((g) => g.rows.map((r) => r.id))
    expect(ids('mac-browser')).toEqual(ids('mac-app'))
    expect(ids('other')).toEqual(ids('mac-app'))
    const jump = (env: KeyEnv) => shortcutGroups(env)[0].rows.find((r) => r.id === 'session.jump')!.keys[0][0]
    expect([jump('mac-app'), jump('mac-browser'), jump('other')]).toEqual(['\u2318', '\u2303', 'Alt'])
  })
})
