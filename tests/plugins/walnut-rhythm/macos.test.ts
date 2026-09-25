/**
 * Rhythm on macOS: the Focus state parser and reader, and the Shortcuts plist, list
 * and install flow. Every file and process is a fixture or a fake: no real
 * ~/Library path is read and no real `shortcuts` / `plutil` / `open` runs.
 */
import { describe, expect, it } from 'vitest'
import type { RunResult, Runner } from '../../../plugin-store/walnut-rhythm/src/server/exec'
import { modeName, parseMacosFocus, readMacosFocus } from '../../../plugin-store/walnut-rhythm/src/server/macos-focus'
import {
  buildShortcutPlistXml, ensureShortcuts, installShortcuts, parseShortcutsList, runShortcut,
  SHORTCUT_OFF, SHORTCUT_ON,
} from '../../../plugin-store/walnut-rhythm/src/server/macos-shortcuts'

const DEEP_WORK = 'com.apple.focus.deep-work-fixture'

/** Shaped like ~/Library/DoNotDisturb/DB/Assertions.json with one live Focus. */
const ASSERTIONS_ACTIVE = {
  data: [{
    storeAssertionRecords: [
      {
        assertionUUID: 'A1',
        assertionStartDateTimestamp: 780_000_000,
        assertionDetails: { assertionDetailsIdentifier: 'x', assertionDetailsModeIdentifier: 'com.apple.donotdisturb.mode.default', assertionDetailsReason: 'user-action' },
      },
      {
        assertionUUID: 'A2',
        assertionStartDateTimestamp: 780_000_500,
        assertionDetails: { assertionDetailsIdentifier: 'y', assertionDetailsModeIdentifier: DEEP_WORK, assertionDetailsReason: 'user-action' },
      },
    ],
    storeInvalidationRecords: [],
  }],
  header: { timestamp: 780_000_600 },
}

const ASSERTIONS_NONE = { data: [{ storeAssertionRecords: [], storeInvalidationRecords: [{ assertionUUID: 'A0' }] }] }

/** Shaped like ModeConfigurations.json. */
const MODES = {
  data: [{
    modeConfigurations: {
      [DEEP_WORK]: { mode: { name: 'Deep Work', modeIdentifier: DEEP_WORK, symbolImageName: 'brain' } },
      'com.apple.donotdisturb.mode.default': { mode: { name: 'Do Not Disturb', modeIdentifier: 'com.apple.donotdisturb.mode.default' } },
    },
  }],
}

describe('parseMacosFocus', () => {
  it('reads the most recently started live Focus and names it', () => {
    expect(parseMacosFocus(ASSERTIONS_ACTIVE, MODES)).toEqual({ active: true, modeId: DEEP_WORK, name: 'Deep Work' })
  })

  it('no live assertion means no Focus', () => {
    expect(parseMacosFocus(ASSERTIONS_NONE, MODES)).toEqual({ active: false })
    expect(parseMacosFocus({}, MODES)).toEqual({ active: false })
    expect(parseMacosFocus(null)).toEqual({ active: false })
  })

  it('falls back to a readable name when the configurations are missing', () => {
    expect(modeName(undefined)).toBe('Do Not Disturb')
    expect(modeName('com.apple.donotdisturb.mode.default')).toBe('Do Not Disturb')
    expect(modeName('com.apple.focus.reading')).toBe('Reading')
    const unnamed = { data: [{ storeAssertionRecords: [{ assertionDetails: {} }] }] }
    expect(parseMacosFocus(unnamed)).toEqual({ active: true, name: 'Do Not Disturb' })
  })
})

describe('readMacosFocus', () => {
  const files = (map: Record<string, string | NodeJS.ErrnoException>) => async (file: string) => {
    const name = file.split('/').pop()!
    const value = map[name]
    if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    if (typeof value !== 'string') throw value
    return value
  }

  it('reads both files from the named directory only', async () => {
    const seen: string[] = []
    const read = files({ 'Assertions.json': JSON.stringify(ASSERTIONS_ACTIVE), 'ModeConfigurations.json': JSON.stringify(MODES) })
    const result = await readMacosFocus('/fixture/DB', async (file) => { seen.push(file); return read(file) })
    expect(result).toEqual({ ok: true, focus: { active: true, modeId: DEEP_WORK, name: 'Deep Work' } })
    expect(seen).toEqual(['/fixture/DB/Assertions.json', '/fixture/DB/ModeConfigurations.json'])
  })

  it('a missing file is "no Focus"; a refused read is "unavailable"; junk is reported', async () => {
    expect(await readMacosFocus('/fixture/DB', files({}))).toEqual({ ok: true, focus: { active: false } })
    const denied = Object.assign(new Error('denied'), { code: 'EPERM' }) as NodeJS.ErrnoException
    expect(await readMacosFocus('/fixture/DB', files({ 'Assertions.json': denied }))).toMatchObject({ ok: false, reason: 'permission' })
    expect(await readMacosFocus('/fixture/DB', files({ 'Assertions.json': '{not json' }))).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('an inactive Focus never reads the mode file', async () => {
    const seen: string[] = []
    await readMacosFocus('/fixture/DB', async (file) => { seen.push(file); return JSON.stringify(ASSERTIONS_NONE) })
    expect(seen).toEqual(['/fixture/DB/Assertions.json'])
  })
})

describe('the shortcut plist', () => {
  it('is one Set Focus action on Do Not Disturb, on until turned off, or off', () => {
    const on = buildShortcutPlistXml(true)
    expect(on).toContain('<string>is.workflow.actions.dnd.set</string>')
    expect(on).toMatch(/<key>Enabled<\/key>\s*<integer>1<\/integer>/)
    expect(on).toContain('<string>AssertionTypeTurnedOnUntilOff</string>')
    expect(on).toContain('<string>com.apple.donotdisturb.mode.default</string>')
    expect(on).toContain('<string>Do Not Disturb</string>')
    expect(buildShortcutPlistXml(false)).toMatch(/<key>Enabled<\/key>\s*<integer>0<\/integer>/)
    expect(on.startsWith('<?xml')).toBe(true)
  })
})

function scripted(results: Record<string, Partial<RunResult>>) {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = []
  const run: Runner = async (command, args, options) => {
    calls.push({ command, args, timeoutMs: options.timeoutMs })
    const key = `${command} ${args[0] ?? ''}`.trim()
    const result = results[key] ?? {}
    return { ok: true, code: 0, stdout: '', stderr: '', ...result }
  }
  return { run, calls }
}

describe('Shortcuts status and install', () => {
  it('parses the list and reports what is missing', async () => {
    expect(parseShortcutsList(`Morning\n  ${SHORTCUT_ON}\n\nOther\n`)).toEqual(['Morning', SHORTCUT_ON, 'Other'])
    const { run } = scripted({ 'shortcuts list': { stdout: `Morning\n${SHORTCUT_ON}\n` } })
    expect(await ensureShortcuts(run)).toEqual({ checked: true, installed: { on: true, off: false }, missing: [SHORTCUT_OFF] })
    const failing = scripted({ 'shortcuts list': { ok: false, error: 'shortcuts timed out after 10s' } })
    expect(await ensureShortcuts(failing.run)).toMatchObject({ installed: null, error: 'shortcuts timed out after 10s' })
  })

  it('writes XML, converts it to a BINARY plist, signs it, then opens it, in that order', async () => {
    const written: Array<{ file: string; text: string }> = []
    const { run, calls } = scripted({})
    const steps = await installShortcuts(run, '/fixture/shortcuts', [SHORTCUT_OFF], {
      async mkdir() { /* fixture */ },
      async writeText(file, text) { written.push({ file, text }) },
    })
    expect(steps).toEqual([{ name: SHORTCUT_OFF, ok: true }])
    expect(written.map((w) => w.file)).toEqual([`/fixture/shortcuts/${SHORTCUT_OFF}.xml`])
    expect(written[0]!.text).toMatch(/<integer>0<\/integer>/)
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['plutil', '-convert', 'binary1', '-o', `/fixture/shortcuts/${SHORTCUT_OFF}.wflow`, `/fixture/shortcuts/${SHORTCUT_OFF}.xml`],
      ['shortcuts', 'sign', '--mode', 'anyone', '--input', `/fixture/shortcuts/${SHORTCUT_OFF}.wflow`, '--output', `/fixture/shortcuts/${SHORTCUT_OFF}.shortcut`],
      ['open', `/fixture/shortcuts/${SHORTCUT_OFF}.shortcut`],
    ])
    expect(calls.every((c) => c.timeoutMs > 0)).toBe(true)
  })

  it('a failed sign stops that shortcut before anything is opened, and the next one still runs', async () => {
    let signs = 0
    const calls: string[] = []
    const run: Runner = async (command, args) => {
      calls.push(`${command} ${args[0]}`)
      if (command === 'shortcuts' && args[0] === 'sign' && signs++ === 0) return { ok: false, code: 1, stdout: '', stderr: 'no', error: 'sign refused' }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    const steps = await installShortcuts(run, '/fixture/s', [SHORTCUT_ON, SHORTCUT_OFF], { async mkdir() {}, async writeText() {} })
    expect(steps).toEqual([{ name: SHORTCUT_ON, ok: false, step: 'sign', error: 'sign refused' }, { name: SHORTCUT_OFF, ok: true }])
    expect(calls.filter((c) => c.startsWith('open'))).toHaveLength(1)
  })

  it('runShortcut runs by name with a deadline and never throws', async () => {
    const { run, calls } = scripted({ 'shortcuts run': { ok: false, error: 'not found' } })
    expect(await runShortcut(run, SHORTCUT_ON)).toEqual({ ok: false, error: 'not found' })
    expect(calls[0]).toEqual({ command: 'shortcuts', args: ['run', SHORTCUT_ON], timeoutMs: 10_000 })
  })
})
