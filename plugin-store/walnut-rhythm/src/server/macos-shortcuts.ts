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
 * Every process runs through the injected Runner (async, deadline, no shell).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Runner } from './exec'

export const SHORTCUT_ON = 'Walnut Focus On'
export const SHORTCUT_OFF = 'Walnut Focus Off'
export const SHORTCUT_NAMES = [SHORTCUT_ON, SHORTCUT_OFF] as const

const LIST_TIMEOUT_MS = 10_000
const RUN_TIMEOUT_MS = 10_000
const CONVERT_TIMEOUT_MS = 10_000
const SIGN_TIMEOUT_MS = 60_000
const OPEN_TIMEOUT_MS = 10_000

/**
 * The workflow plist for one shortcut: a single "Set Focus" action on Do Not
 * Disturb, on (until turned off) or off. PURE. Every value is a constant, so nothing
 * here needs escaping.
 */
export function buildShortcutPlistXml(enabled: boolean): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowActions</key>
  <array>
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.dnd.set</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>Enabled</key>
        <integer>${enabled ? 1 : 0}</integer>
        <key>AssertionType</key>
        <string>AssertionTypeTurnedOnUntilOff</string>
        <key>FocusModes</key>
        <dict>
          <key>Identifier</key>
          <string>com.apple.donotdisturb.mode.default</string>
          <key>DisplayString</key>
          <string>Do Not Disturb</string>
        </dict>
      </dict>
    </dict>
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
    <integer>${enabled ? 463140863 : 3031607807}</integer>
  </dict>
  <key>WFWorkflowImportQuestions</key>
  <array/>
  <key>WFWorkflowInputContentItemClasses</key>
  <array/>
  <key>WFWorkflowOutputContentItemClasses</key>
  <array/>
  <key>WFWorkflowTypes</key>
  <array/>
  <key>WFQuickActionSurfaces</key>
  <array/>
  <key>WFWorkflowHasShortcutInputVariables</key>
  <false/>
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
  error?: string
}

/** Read-only: which of the two shortcuts exist. Never throws. */
export async function ensureShortcuts(run: Runner): Promise<ShortcutsStatus> {
  const result = await run('shortcuts', ['list'], { timeoutMs: LIST_TIMEOUT_MS })
  if (!result.ok) return { checked: true, installed: null, missing: [...SHORTCUT_NAMES], error: result.error ?? 'shortcuts list failed' }
  const names = new Set(parseShortcutsList(result.stdout))
  const installed = { on: names.has(SHORTCUT_ON), off: names.has(SHORTCUT_OFF) }
  return { checked: true, installed, missing: SHORTCUT_NAMES.filter((name) => !names.has(name)) }
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
      await fs.writeText(xml, buildShortcutPlistXml(name === SHORTCUT_ON))
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

/** Run one shortcut by name. Never throws; the caller logs and reports a failure. */
export async function runShortcut(run: Runner, name: string): Promise<{ ok: boolean; error?: string }> {
  const result = await run('shortcuts', ['run', name], { timeoutMs: RUN_TIMEOUT_MS })
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? `shortcuts run "${name}" failed` }
}
