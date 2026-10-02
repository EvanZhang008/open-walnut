/**
 * Rhythm on macOS: the Focus state parser and reader, and the Shortcuts plist, list
 * and install flow. Every file and process is a fixture or a fake: no real
 * ~/Library path is read and no real `shortcuts` / `plutil` / `open` runs.
 */
import { describe, expect, it } from 'vitest'
import { createFakeWalnut } from '../../../packages/plugin-api/src/testing.js'
import type { RunResult, Runner } from '../../../plugin-store/walnut-rhythm/src/server/exec'
import { INSTALL_POLL_MS, INSTALL_WATCH_MS, MacosBridge } from '../../../plugin-store/walnut-rhythm/src/server/macos-bridge'
import { modeName, parseMacosFocus, readMacosFocus, type MacosFocusRead } from '../../../plugin-store/walnut-rhythm/src/server/macos-focus'
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

describe('the install watch', () => {
  const okRun = (stdout = ''): RunResult => ({ ok: true, code: 0, stdout, stderr: '' })
  const focusOff = async (): Promise<MacosFocusRead> => ({ ok: true, focus: { active: false } })
  const dir = '/tmp/walnut-rhythm-test-shortcuts'

  it('re-lists Shortcuts after the Add dialogs open and stops once both exist, announcing each Add', async () => {
    // Nothing tells Rhythm that the person clicked Add in another app, so after opening
    // the dialogs it lists again every few seconds; the App must not need Check again.
    let lists = 0
    const run: Runner = async (command, args) => {
      if (command === 'shortcuts' && args[0] === 'list') {
        lists++
        // Install's own check sees none; the watch then sees On, then both.
        return okRun(lists === 1 ? '' : lists === 2 ? `${SHORTCUT_ON}\n` : `${SHORTCUT_ON}\n${SHORTCUT_OFF}\n`)
      }
      return okRun()
    }
    let t = 1_000_000
    const seen: string[] = []
    const bridge = new MacosBridge({
      enabled: true, log: createFakeWalnut({ pluginId: 'rhythm-fixture', pluginName: 'Rhythm' }).api.log, run, readFocus: focusOff, shortcutsDir: dir,
      onChange: () => seen.push(`${bridge.shortcuts.watching ? 'watching' : 'idle'}:${bridge.shortcuts.missing.length}`),
      wait: async () => { t += INSTALL_POLL_MS },
    })
    const result = await bridge.install(() => t)
    expect(result.alreadyInstalled).toBe(false)
    await bridge.settled()
    expect(lists).toBe(3)
    expect(bridge.shortcuts.missing).toEqual([])
    expect(bridge.shortcuts.watching).toBe(false)
    // Each change of what is missing reached the App, and the watch announced its start and end.
    expect(seen).toEqual(['idle:2', 'watching:2', 'watching:1', 'watching:0', 'idle:0'])
  })

  it('gives up after the watch window when the person never clicks Add', async () => {
    let lists = 0
    const run: Runner = async (command, args) => {
      if (command === 'shortcuts' && args[0] === 'list') lists++
      return okRun()
    }
    let t = 5_000_000
    const bridge = new MacosBridge({
      enabled: true, log: createFakeWalnut({ pluginId: 'rhythm-fixture', pluginName: 'Rhythm' }).api.log, run, readFocus: focusOff, shortcutsDir: dir,
      onChange: () => undefined,
      wait: async () => { t += INSTALL_POLL_MS },
    })
    await bridge.install(() => t)
    await bridge.settled()
    expect(lists).toBe(1 + INSTALL_WATCH_MS / INSTALL_POLL_MS)
    expect(bridge.shortcuts.missing).toEqual([SHORTCUT_ON, SHORTCUT_OFF])
    expect(bridge.shortcuts.watching).toBe(false)
  })

  it('stops listing and announcing once the plugin is disposed mid-watch', async () => {
    // Disabling or reloading Rhythm within the watch window must not leave the old
    // instance listing Shortcuts and emitting state over the new one's.
    let lists = 0
    const run: Runner = async (command, args) => {
      if (command === 'shortcuts' && args[0] === 'list') lists++
      return okRun()
    }
    let t = 7_000_000
    let waits = 0
    const seen: string[] = []
    const bridge: MacosBridge = new MacosBridge({
      enabled: true, log: createFakeWalnut({ pluginId: 'rhythm-fixture', pluginName: 'Rhythm' }).api.log, run, readFocus: focusOff, shortcutsDir: dir,
      onChange: () => seen.push(`${bridge.shortcuts.watching ? 'watching' : 'idle'}:${bridge.shortcuts.missing.length}`),
      // The host tears the plugin down while the watch sleeps before its second list.
      wait: async () => { t += INSTALL_POLL_MS; if (++waits === 2) bridge.dispose() },
    })
    await bridge.install(() => t)
    await bridge.settled()
    expect(lists).toBe(2)
    expect(seen).toEqual(['idle:2', 'watching:2'])
    // A later Install on the disposed bridge opens nothing to watch for.
    await bridge.install(() => t)
    await bridge.settled()
    expect(seen).toEqual(['idle:2', 'watching:2', 'idle:2'])
  })
})

describe('the Full Disk Access path', () => {
  it('flags a refused read as needing access, names the program, and Check again skips the backoff', async () => {
    let reads = 0
    let refuse = true
    const readFocus = async (): Promise<MacosFocusRead> => {
      reads++
      return refuse
        ? { ok: false, reason: 'permission', message: 'macOS did not allow reading the Focus state (Full Disk Access may be needed)' }
        : { ok: true, focus: { active: false } }
    }
    const calls: string[] = []
    const run: Runner = async (command, args) => { calls.push([command, ...args].join(' ')); return { ok: true, code: 0, stdout: '', stderr: '' } }
    const bridge = new MacosBridge({
      enabled: true, log: createFakeWalnut({ pluginId: 'rhythm-fixture', pluginName: 'Rhythm' }).api.log, run, readFocus,
      shortcutsDir: '/tmp/walnut-rhythm-test-shortcuts', onChange: () => undefined,
    })
    await bridge.pollMirror(1_000, true)
    // A host without `walnut.macos` reads in the server process, so that is the program to name.
    expect(bridge.mirror).toMatchObject({ phase: 'unavailable', needsAccess: true, grantTarget: process.execPath })
    // The refusal backs off for ten minutes: a plain poll a minute later reads nothing.
    await bridge.pollMirror(61_000, true)
    expect(reads).toBe(1)
    // The person granted access and clicked Check again: the forced read goes through.
    refuse = false
    await bridge.pollMirror(62_000, true, true)
    expect(reads).toBe(2)
    expect(bridge.mirror).toEqual({ phase: 'inactive', checkedAt: 62_000 })
    // The button opens exactly the Full Disk Access pane and nothing else.
    await bridge.openPrivacySettings()
    expect(calls).toEqual(['open x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'])
  })
})

describe('reading through Walnut\'s Full Disk Access', () => {
  it('holds the declaration only while the mirror is wanted, and names Walnut on a refusal', async () => {
    let held = 0
    let released = 0
    let refuse = false
    const bridge = new MacosBridge({
      enabled: true, log: createFakeWalnut({ pluginId: 'rhythm-fixture', pluginName: 'Rhythm' }).api.log,
      run: async () => ({ ok: true, code: 0, stdout: '', stderr: '' }),
      readFocus: async () => refuse
        ? { ok: false, reason: 'permission', message: 'refused' }
        : { ok: true, focus: { active: false } },
      useAccess: () => { held++; return { dispose: () => { released++ } } },
      grantTarget: async () => '/Applications/Walnut.app',
      shortcutsDir: '/tmp/walnut-rhythm-test-shortcuts', onChange: () => undefined,
    })

    await bridge.pollMirror(1_000, true)
    await bridge.pollMirror(30_000, true)
    expect([held, released]).toEqual([1, 0]) // declared once, kept across polls

    refuse = true
    await bridge.pollMirror(60_000, true, true)
    expect(bridge.mirror).toMatchObject({ needsAccess: true, grantTarget: '/Applications/Walnut.app' })

    // "Follow macOS Focus" switched off: Settings must stop listing Rhythm's reason.
    await bridge.pollMirror(61_000, false)
    expect([held, released]).toEqual([1, 1])

    // Back on, then the plugin stops: released again, exactly once.
    await bridge.pollMirror(62_000, true, true)
    bridge.dispose()
    bridge.dispose()
    expect([held, released]).toEqual([2, 2])
  })
})
