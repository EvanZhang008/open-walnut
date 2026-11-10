/**
 * A machine on hold, or in its quiet night, starts no test run (2026-11-09: review scripts
 * drove Playwright WebKit and started fixture servers on a Mac from 00:25 to 01:39 while
 * its hold file said its person was asleep; they called the browser lease and the
 * ephemeral launcher themselves, and neither read the hold).
 *
 *   ~/.config/walnut/hold         no test run while it exists (its first line says why)
 *   ~/.config/walnut/night-quiet  no test run from 22:00 to 08:00, the machine's own clock
 *
 * Read at every test entry point: every vitest config (`maxWorkers()`), every Playwright
 * config and hand-written script (`perRunWorkers()`, the :3457 lease `acquireSync`), the
 * ephemeral test server (`runEphemeralLauncher`), and every Playwright browser launched
 * under a Walnut session (the silencer preload, `MACHINE_HOLD_PRELOAD_PART`). The file is
 * the switch: there is no environment override, so lifting a hold is removing its file.
 * Ratchet: tests/setup/machine-hold.test.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Night-quiet hours, the machine's local clock: 22:00 up to 08:00. */
export function nightHour(hour: number): boolean {
  return hour >= 22 || hour < 8
}

/** Why this machine takes no test run now, or null. */
export function machineHold(home: string = os.homedir(), now: Date = new Date()): string | null {
  const dir = path.join(home, '.config', 'walnut')
  const hold = path.join(dir, 'hold')
  if (fs.existsSync(hold)) {
    let why = ''
    try { why = fs.readFileSync(hold, 'utf8').split('\n')[0].trim() } catch { /* unreadable: still held */ }
    return `this machine holds every new test run for now (~/.config/walnut/hold${why ? `: ${why}` : ''}). ` +
      'Run it elsewhere (a remote dev host, a container, CI) or once the hold is lifted.'
  }
  if (fs.existsSync(path.join(dir, 'night-quiet')) && nightHour(now.getHours())) {
    return 'this machine runs no test from 22:00 to 08:00 (~/.config/walnut/night-quiet). ' +
      'Run it elsewhere (a remote dev host, a container, CI) or after 08:00.'
  }
  return null
}

/** Throws before a test run starts on a held machine, or in its quiet night. */
export function assertNoMachineHold(home?: string, now?: Date): void {
  const why = machineHold(home, now)
  if (why) throw new Error(`[machine-hold] This test run did not start: ${why}`)
}

/**
 * The same rule for the silencer preload (plain CommonJS, src/providers/pw-silence-core.ts):
 * every Playwright browser a Walnut session launches, whichever engine and however it is
 * started (a runner, a worker, a script of its own), passes the server-side
 * BrowserType._prepareToLaunch, which refuses it here. Connecting to a running browser
 * (connectOverCDP, a person's own Chrome) launches nothing and is not touched, and the deploy's
 * first-paint check is no test run: a deploy from a session on a held machine still runs it.
 */
export function machineHoldPreloadPart(): string {
  return [
    '// A held machine, or one in its quiet night, launches no test browser (src/lib/machine-hold.ts).',
    'function machineHold(home, now) {',
    "  const fs = require('node:fs'), path = require('node:path');",
    "  const dir = path.join(home || require('node:os').homedir(), '.config', 'walnut');",
    "  const hold = path.join(dir, 'hold');",
    '  if (fs.existsSync(hold)) {',
    "    let why = '';",
    "    try { why = fs.readFileSync(hold, 'utf8').split('\\n')[0].trim(); } catch (e) {}",
    "    return 'this machine holds every new test run for now (~/.config/walnut/hold' + (why ? ': ' + why : '') + '). ' +",
    "      'Run it elsewhere (a remote dev host, a container, CI) or once the hold is lifted.';",
    '  }',
    '  const h = (now || new Date()).getHours();',
    "  if (fs.existsSync(path.join(dir, 'night-quiet')) && (h >= 22 || h < 8)) {",
    "    return 'this machine runs no test from 22:00 to 08:00 (~/.config/walnut/night-quiet). ' +",
    "      'Run it elsewhere (a remote dev host, a container, CI) or after 08:00.';",
    '  }',
    '  return null;',
    '}',
    "/** The deploy's first-paint check (scripts/devprod-render-check.mjs) is no test run: a deploy on a held machine still checks its bundle. */",
    'function deployCheck() {',
    "  return /[\\\\/]scripts[\\\\/]devprod-render-check\\.mjs$/.test(String(process.argv[1] || ''));",
    '}',
    "const HELD = Symbol.for('walnut.pwSilence.machineHold');",
    '/** Every launch of one Playwright library\'s browser types refuses on a held machine; once per library. */',
    'function holdBrowserTypes(mod) {',
    '  const proto = mod && mod.BrowserType && mod.BrowserType.prototype;',
    '  if (!proto || Object.prototype.hasOwnProperty.call(proto, HELD)) return false;',
    '  const prepare = proto._prepareToLaunch;',
    "  if (typeof prepare !== 'function') return false;",
    '  proto[HELD] = true;',
    '  proto._prepareToLaunch = function () {',
    '    const why = deployCheck() ? null : machineHold();',
    "    if (why) throw new Error('[machine-hold] This browser did not start: ' + why);",
    '    return prepare.apply(this, arguments);',
    '  };',
    '  return true;',
    '}',
    "/** Playwright's server-side BrowserType file, in node_modules or Bun's cache. */",
    'function isBrowserTypeServer(file) {',
    "  return typeof file === 'string' && /[\\\\/]playwright-core(@[^\\\\/]*)?[\\\\/]lib[\\\\/]server[\\\\/]browserType\\.js$/.test(file);",
    '}',
    '/** The same, from a Playwright library\'s folder. */',
    'function holdBrowsers(root) {',
    "  try { return holdBrowserTypes(require(require('node:path').join(root, 'lib', 'server', 'browserType.js'))); }",
    '  catch (e) { return false; }',
    '}',
  ].join('\n')
}
