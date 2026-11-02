/**
 * Drive macOS Do Not Disturb from focus blocks through two Shortcuts.
 *
 * A plugin cannot flip the system Focus directly, but the Shortcuts app can, and the
 * `shortcuts` command can run a shortcut by name. Rhythm ships the two shortcuts it
 * needs as files: an unsigned workflow plist per shortcut, converted to a BINARY plist
 * (`shortcuts sign` only accepts that form), signed for anyone, then opened, which is
 * what makes Shortcuts show its Add Shortcut dialog. One click per shortcut, and the
 * person sees exactly what is being added.
 *
 * "On" turns Do Not Disturb on UNTIL A TIME, the block's end, read from the shortcut's
 * input. macOS keeps that end time itself, so Do Not Disturb ends on time even when
 * Walnut is not running then, and a restart of Walnut or the Mac never leaves it on.
 * An older Rhythm shipped "Walnut Focus On", which stayed on until turned off, and an
 * early "Walnut Do Not Disturb Until" that set no end time; neither is run now.
 *
 * Every process runs through the injected Runner (async, deadline, no shell).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Runner } from './exec'
import { LEGACY_SHORTCUT_NAMES, LEGACY_SHORTCUT_ON, SHORTCUT_OFF, SHORTCUT_ON } from './dnd-words'

export { LEGACY_SHORTCUT_NAMES, LEGACY_SHORTCUT_ON, SHORTCUT_OFF, SHORTCUT_ON }

export const SHORTCUT_NAMES = [SHORTCUT_ON, SHORTCUT_OFF] as const

const LIST_TIMEOUT_MS = 10_000
/** The first run after a login can take 20 s while Shortcuts starts. */
const RUN_TIMEOUT_MS = 45_000
const CONVERT_TIMEOUT_MS = 10_000
const SIGN_TIMEOUT_MS = 60_000
const OPEN_TIMEOUT_MS = 10_000

const DND_MODE = `<key>FocusModes</key>
        <dict>
          <key>Identifier</key>
          <string>com.apple.donotdisturb.mode.default</string>
          <key>DisplayString</key>
          <string>Do Not Disturb</string>
        </dict>`

/**
 * Turn Do Not Disturb on until the date in the shortcut's input. The time goes in as a
 * text token holding the Shortcut Input: macOS parses the text as a date and starts a
 * Do Not Disturb that ends at it ("date-interval"). A plain variable attachment there
 * (the shape Shortcuts uses for most parameters) is dropped on import, and the action
 * then falls back to a fixed 7 PM that macOS treats as until-turned-off (verified on
 * macOS 26, 2026-11-01). It ends with Nothing: an action's output goes back to the
 * `shortcuts run` that started it, and handing out output makes macOS ask the person
 * first ("Allow ... to output 1 text item?"), which held the first run until it timed out.
 */
const ON_UNTIL_ACTIONS = `<dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.dnd.set</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>Enabled</key>
        <integer>1</integer>
        <key>AssertionType</key>
        <string>Time</string>
        <key>Time</key>
        <dict>
          <key>Value</key>
          <dict>
            <key>string</key>
            <string>\uFFFC</string>
            <key>attachmentsByRange</key>
            <dict>
              <key>{0, 1}</key>
              <dict><key>Type</key><string>ExtensionInput</string></dict>
            </dict>
          </dict>
          <key>WFSerializationType</key>
          <string>WFTextTokenString</string>
        </dict>
        ${DND_MODE}
      </dict>
    </dict>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.nothing</string>
      <key>WFWorkflowActionParameters</key>
      <dict/>
    </dict>`

const OFF_ACTIONS = `<dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.dnd.set</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>Enabled</key>
        <integer>0</integer>
        ${DND_MODE}
      </dict>
    </dict>`

/**
 * The workflow plist for one of Rhythm's shortcuts. PURE. Every value is a constant,
 * so nothing here needs escaping.
 */
export function buildShortcutPlistXml(name: string): string {
  const on = name === SHORTCUT_ON
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowActions</key>
  <array>
    ${on ? ON_UNTIL_ACTIONS : OFF_ACTIONS}
  </array>
  <key>WFWorkflowClientVersion</key>
  <string>1146.14</string>
  <key>WFWorkflowMinimumClientVersion</key>
  <integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key>
  <string>900</string>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconGlyphNumber</key>
    <integer>59446</integer>
    <key>WFWorkflowIconStartColor</key>
    <integer>${on ? 463140863 : 3031607807}</integer>
  </dict>
  <key>WFWorkflowImportQuestions</key>
  <array/>
  <key>WFWorkflowInputContentItemClasses</key>
  ${on ? '<array><string>WFStringContentItem</string><string>WFDateContentItem</string><string>WFGenericFileContentItem</string></array>' : '<array/>'}
  <key>WFWorkflowOutputContentItemClasses</key>
  <array/>
  <key>WFWorkflowTypes</key>
  <array/>
  <key>WFQuickActionSurfaces</key>
  <array/>
  <key>WFWorkflowHasShortcutInputVariables</key>
  ${on ? '<true/>' : '<false/>'}
</dict>
</plist>
`
}

/** `shortcuts list` prints one name per line. PURE. */
export function parseShortcutsList(stdout: string): string[] {
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

export interface ShortcutsStatus {
  checked: boolean
  installed: { on: boolean; off: boolean } | null
  missing: string[]
  /** An older Rhythm's "on" shortcut is still in Shortcuts (unused now). */
  legacy?: boolean
  /** Which of them, by name. */
  legacyNames?: string[]
  error?: string
}

/** Read-only: which of the two shortcuts exist. Never throws. */
export async function ensureShortcuts(run: Runner): Promise<ShortcutsStatus> {
  const result = await run('shortcuts', ['list'], { timeoutMs: LIST_TIMEOUT_MS })
  if (!result.ok) return { checked: true, installed: null, missing: [...SHORTCUT_NAMES], error: result.error ?? 'shortcuts list failed' }
  const names = new Set(parseShortcutsList(result.stdout))
  const installed = { on: names.has(SHORTCUT_ON), off: names.has(SHORTCUT_OFF) }
  return {
    checked: true, installed, missing: SHORTCUT_NAMES.filter((name) => !names.has(name)),
    ...legacyOf(names),
  }
}

function legacyOf(names: Set<string>): { legacy?: true; legacyNames?: string[] } {
  const present = LEGACY_SHORTCUT_NAMES.filter((name) => names.has(name))
  return present.length ? { legacy: true, legacyNames: present } : {}
}

export interface InstallStep {
  name: string
  ok: boolean
  step?: 'write' | 'convert' | 'sign' | 'open'
  error?: string
}

export interface InstallFs {
  mkdir(dir: string): Promise<void>
  writeText(file: string, text: string): Promise<void>
}

const realFs: InstallFs = {
  async mkdir(dir) { await fsp.mkdir(dir, { recursive: true }) },
  async writeText(file, text) { await fsp.writeFile(file, text, 'utf8') },
}

/**
 * Build, sign and open each shortcut in `names` (by default the missing ones, so an
 * existing shortcut is never imported twice as "Walnut Focus On 1"). Opening a signed
 * file is what asks the person to add it; nothing is added without that click.
 */
export async function installShortcuts(
  run: Runner,
  dir: string,
  names: readonly string[],
  fs: InstallFs = realFs,
): Promise<InstallStep[]> {
  const steps: InstallStep[] = []
  try { await fs.mkdir(dir) } catch (error) {
    return names.map((name) => ({ name, ok: false, step: 'write' as const, error: String((error as Error).message ?? error) }))
  }
  for (const name of names) {
    const xml = path.join(dir, `${name}.xml`)
    const binary = path.join(dir, `${name}.wflow`)
    const signed = path.join(dir, `${name}.shortcut`)
    try {
      await fs.writeText(xml, buildShortcutPlistXml(name))
    } catch (error) {
      steps.push({ name, ok: false, step: 'write', error: String((error as Error).message ?? error) })
      continue
    }
    const convert = await run('plutil', ['-convert', 'binary1', '-o', binary, xml], { timeoutMs: CONVERT_TIMEOUT_MS })
    if (!convert.ok) { steps.push({ name, ok: false, step: 'convert', error: convert.error }); continue }
    const sign = await run('shortcuts', ['sign', '--mode', 'anyone', '--input', binary, '--output', signed], { timeoutMs: SIGN_TIMEOUT_MS })
    if (!sign.ok) { steps.push({ name, ok: false, step: 'sign', error: sign.error }); continue }
    const open = await run('open', [signed], { timeoutMs: OPEN_TIMEOUT_MS })
    if (!open.ok) { steps.push({ name, ok: false, step: 'open', error: open.error }); continue }
    steps.push({ name, ok: true })
  }
  return steps
}

/**
 * Run one shortcut by name, optionally with a file as its input. Never throws; the
 * caller logs and reports a failure.
 */
export async function runShortcut(run: Runner, name: string, inputPath?: string): Promise<{ ok: boolean; error?: string }> {
  const args = inputPath ? ['run', name, '--input-path', inputPath] : ['run', name]
  const result = await run('shortcuts', args, { timeoutMs: RUN_TIMEOUT_MS })
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? `shortcuts run "${name}" failed` }
}
