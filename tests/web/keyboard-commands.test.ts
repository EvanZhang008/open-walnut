/**
 * The keyboard commands a person can change (web/src/keyboard/commands.ts) are one table that
 * the key handlers, the shortcuts sheet, Settings > Keyboard shortcuts and the hints shown while
 * the modifier is held all read. This fails when one of them drifts from it: a default that two
 * commands share or that a place keeps for itself, a hint naming no command, a handler gone, a
 * Settings list built from anything else, or a Mac app menu key the table does not know about.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { chordLabel, chordOf, hasCommandModifier, normalizeChord } from '../../web/src/keyboard/chords'
import { COMMANDS, RESERVED, bindings, chordsFor, commandFor, type CommandId } from '../../web/src/keyboard/commands'
import { cycleDir, fixedChords, isHelpChord, jumpIndex, shortcutGroups, type KeyEnv } from '../../web/src/keyboard/shortcuts'
import { chordConflict, cleanOverrides } from '../../web/src/keyboard/shortcut-overrides'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')
const ENVS: KeyEnv[] = ['mac-app', 'mac-browser', 'other']
type K = { key: string; code: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }
const ev = (k: K) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...k })

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []
  })
}

describe('chords', () => {
  it('read the physical key, in one written form', () => {
    expect(chordOf(ev({ key: 'n', code: 'KeyN', metaKey: true }))).toBe('Cmd+N')
    // Option+N types a dead key on a Mac: the chord is still Alt+N.
    expect(chordOf(ev({ key: '˜', code: 'KeyN', altKey: true }))).toBe('Alt+N')
    expect(chordOf(ev({ key: 'O', code: 'KeyO', metaKey: true, shiftKey: true }))).toBe('Cmd+Shift+O')
    expect(chordOf(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBeNull()
    expect(chordOf(ev({ key: '\\', code: 'Backslash', ctrlKey: true }))).toBe('Ctrl+\\')
    expect(normalizeChord('shift+cmd+o')).toBe('Cmd+Shift+O')
    expect(normalizeChord('Hyper+O')).toBeNull()
    expect(chordLabel('Cmd+Shift+O', true)).toBe('⌘⇧O')
    expect(chordLabel('Ctrl+Shift+O', false)).toBe('Ctrl+Shift+O')
    expect(hasCommandModifier('Shift+N')).toBe(false)
  })

  it('a letter is the one the key types, as the Mac\'s menus read it, whatever the layout', () => {
    // AZERTY: the key printed Z sits where QWERTY's W does. Its Cmd+Z is Undo, never a close.
    expect(chordOf(ev({ key: 'z', code: 'KeyW', metaKey: true }))).toBe('Cmd+Z')
    expect(commandFor(ev({ key: 'z', code: 'KeyW', metaKey: true }), 'mac-app')).toBeNull()
    // Dvorak: the key printed K is QWERTY's V.
    expect(commandFor(ev({ key: 'k', code: 'KeyV', metaKey: true }), 'mac-app')).toBe('task.search')
    // A non-Latin layout types no Latin letter: the physical key answers.
    expect(chordOf(ev({ key: '\u0446', code: 'KeyW', metaKey: true }))).toBe('Cmd+W')
    // Shift on a digit types a sign: still the digit.
    expect(chordOf(ev({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true }))).toBe('Cmd+Shift+2')
  })
})

describe('the defaults', () => {
  for (const env of ENVS) {
    it(`${env}: every command has a key of its own that the place leaves to the page`, () => {
      const seen = new Map<string, CommandId>()
      const fixed = fixedChords(env)
      for (const c of COMMANDS) {
        expect(c.defaults[env].length, `${c.id} has no key in ${env}`).toBeGreaterThan(0)
        for (const ch of c.defaults[env]) {
          expect(normalizeChord(ch), `${c.id}: ${ch} is not in the written form`).toBe(ch)
          expect(hasCommandModifier(ch), `${c.id}: ${ch} is typing`).toBe(true)
          expect(seen.get(ch), `${ch} is both ${seen.get(ch)} and ${c.id}`).toBeUndefined()
          expect(RESERVED[env], `${c.id}: ${ch} is the ${env}'s own`).not.toContain(ch)
          expect(fixed.get(ch), `${c.id}: ${ch} is the fixed "${fixed.get(ch)}"`).toBeUndefined()
          seen.set(ch, c.id)
        }
      }
    })
  }

  it('the ones asked for: Cmd+N new task and Cmd+W close in the Mac app, never the browser\'s own', () => {
    expect(commandFor(ev({ key: 'n', code: 'KeyN', metaKey: true }), 'mac-app')).toBe('task.new')
    expect(commandFor(ev({ key: 'w', code: 'KeyW', metaKey: true }), 'mac-app')).toBe('session.close')
    // A browser keeps Cmd+N / Cmd+W (Ctrl+ elsewhere): there they take the session modifier.
    expect(commandFor(ev({ key: 'n', code: 'KeyN', metaKey: true }), 'mac-browser')).toBeNull()
    expect(commandFor(ev({ key: 'n', code: 'KeyN', ctrlKey: true }), 'mac-browser')).toBe('task.new')
    expect(commandFor(ev({ key: 'w', code: 'KeyW', altKey: true }), 'other')).toBe('session.close')
  })
})

describe('the fixed keys', () => {
  // fixedChords is what a command may never take; each chord in it must be one its handler
  // answers, so the two lists cannot drift.
  const CODE: Record<string, string> = { '[': 'BracketLeft', ']': 'BracketRight', '/': 'Slash' }
  const press = (chord: string) => {
    const parts = chord.split('+')
    const key = parts.pop()!
    const code = CODE[key] ?? (/[0-9]/.test(key) ? `Digit${key}` : `Key${key}`)
    return ev({ key: key.toLowerCase(), code, metaKey: parts.includes('Cmd'), ctrlKey: parts.includes('Ctrl'), altKey: parts.includes('Alt'), shiftKey: parts.includes('Shift') })
  }
  for (const env of ENVS) {
    it(`${env}: each one is a key its handler answers`, () => {
      for (const ch of fixedChords(env).keys()) {
        const e = press(ch)
        const answered = jumpIndex(e, env) > 0 || cycleDir(e, env) !== 0 || isHelpChord(e, env, true) || /\+(Z|F|Shift\+E)$/.test(ch)
        expect(answered, `${env}: ${ch} is listed fixed but nothing answers it`).toBe(true)
      }
    })
  }
})

describe('a person\'s own keys', () => {
  it('replace the default, and a key nobody may take is refused with who has it', () => {
    const own = { 'task.new': 'Cmd+J' }
    expect(chordsFor('task.new', 'mac-app', own)).toEqual(['Cmd+J'])
    expect(bindings('mac-app', own).get('Cmd+N')).toBeUndefined()
    expect(chordsFor('task.new', 'mac-app', { 'task.new': '' })).toEqual([])
    expect(chordConflict('task.new', 'Cmd+W', 'mac-app', {})).toMatch(/Close the current session column/)
    expect(chordConflict('task.new', 'Cmd+Q', 'mac-app', {})).toMatch(/Mac app's menus/)
    expect(chordConflict('task.new', 'Cmd+Shift+E', 'mac-app', {})).toMatch(/cannot change/)
    expect(chordConflict('task.new', 'Cmd+3', 'mac-app', {})).toMatch(/cannot change/)
    expect(chordConflict('task.new', 'Shift+N', 'mac-app', {})).toMatch(/typing/)
    expect(chordConflict('task.new', 'Cmd+N', 'mac-browser', {})).toMatch(/browser/)
    expect(chordConflict('task.new', 'Cmd+J', 'mac-app', {})).toBeNull()
    // Its own key again is no conflict.
    expect(chordConflict('task.new', 'Cmd+N', 'mac-app', {})).toBeNull()
    // A key another command was given is that command's now.
    expect(chordConflict('panel.tasks', 'Cmd+J', 'mac-app', own)).toMatch(/New task/)
  })

  it('a hand-edited config keeps only known commands and keys that parse', () => {
    expect(cleanOverrides({ 'mac-app': { 'task.new': 'shift+cmd+j', 'nope': 'Cmd+K', 'panel.tasks': 7 }, junk: {} }))
      .toEqual({ 'mac-app': { 'task.new': 'Cmd+Shift+J' } })
  })
})

describe('one table for every place that names a key', () => {
  it('every command is a row of the sheet, once, and its handler still handles it', () => {
    for (const env of ENVS) {
      const rows = shortcutGroups(env).flatMap((g) => g.rows).filter((r) => r.command)
      expect(rows.map((r) => r.command).sort()).toEqual(COMMANDS.map((c) => c.id).sort())
    }
    for (const c of COMMANDS) {
      expect(read(`web/src/${c.handler.file}`), `${c.id}: ${c.handler.file} no longer handles it`).toMatch(c.handler.has)
    }
  })

  it('Settings lists the sheet with the person\'s keys, and the hints read the same keys', () => {
    const section = read('web/src/components/settings/sections/KeyboardShortcutsSection.tsx')
    expect(section).toMatch(/shortcutGroups\(env, overrides\)/)
    expect(section).toMatch(/setCommandChord\(/)
    expect(section).toMatch(/resetCommandChord\(/)
    expect(read('web/src/keyboard/ShortcutHint.tsx')).toMatch(/chordsFor\(command, env, overrides\)/)
    expect(read('web/src/keyboard/ShortcutsHelp.tsx')).toMatch(/shortcutGroups\(env, overrides\)/)
  })

  it('every hint names a command, and the commands asked for have one', () => {
    const ids = new Set(COMMANDS.map((c) => c.id))
    const named = new Set<string>()
    for (const f of files(path.join(ROOT, 'web/src'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<ShortcutHint command="([^"]+)"/g)) {
        expect(ids.has(m[1] as CommandId), `${path.relative(ROOT, f)}: "${m[1]}" is no command`).toBe(true)
        named.add(m[1]!)
      }
    }
    expect([...named].sort()).toEqual(expect.arrayContaining(['session.close', 'task.new']))
  })

  it('no key handler checks a command\'s key by hand', () => {
    // The keys the commands took over, written the old way: they would ignore a person's own key.
    const HAND = [
      /\(e\.metaKey \|\| e\.ctrlKey\) && e\.shiftKey && \(e\.key === 'o'/,
      /\(e\.metaKey \|\| e\.ctrlKey\) && e\.shiftKey && e\.key === 'Enter'/,
      /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === 'k'\)/,
      /isFocusComposerChord|isCompleteNextChord/,
    ]
    for (const f of files(path.join(ROOT, 'web/src'))) {
      const src = readFileSync(f, 'utf8')
      for (const re of HAND) expect(src, `${path.relative(ROOT, f)} checks ${re} by hand`).not.toMatch(re)
    }
  })
})

describe('the Mac app', () => {
  // Each menu item with a key, as a chord (desktop/main.swift).
  function menuChords(): { title: string; chord: string; action: string }[] {
    const src = read('desktop/main.swift')
    const masks = new Map<string, string>()
    for (const m of src.matchAll(/(\w+)\.keyEquivalentModifierMask = \[([^\]]*)\]/g)) masks.set(m[1]!, m[2]!)
    const out: { title: string; chord: string; action: string }[] = []
    for (const m of src.matchAll(/(?:let (\w+) = )?NSMenuItem\(title: "([^"]+)", action: ([^,]+), keyEquivalent: "([^"]+)"\)/g)) {
      const [, name, title, action, key] = m
      const mask = (name && masks.get(name)) ?? '.command'
      const mods: string[] = []
      if (mask.includes('.command')) mods.push('Cmd')
      if (mask.includes('.control')) mods.push('Ctrl')
      if (mask.includes('.option')) mods.push('Alt')
      if (mask.includes('.shift') || /[A-Z]/.test(key!)) mods.push('Shift')
      out.push({ title: title!, action: action!, chord: normalizeChord([...mods, key!].join('+'))! })
    }
    return out
  }

  it('the table knows every menu key, and only Close Column hands its key to the page', () => {
    const items = menuChords()
    expect(items.length).toBeGreaterThan(10)
    for (const it of items) {
      if (it.action.includes('closeColumnOrPopout')) { expect(it.chord).toBe('Cmd+W'); continue }
      expect(RESERVED['mac-app'], `"${it.title}" (${it.chord}) is the menu's: list it in RESERVED`).toContain(it.chord)
    }
    // Close Window never sits on the key that closes a column.
    expect(items.find((i) => i.title === 'Close Window')?.chord).toBe('Cmd+Shift+W')
  })
})
