import fs from 'node:fs/promises'
import path from 'node:path'
import type { DemoPaths } from './demo-home.js'
import { demoProcessGone } from './demo-process.js'

export function demoSignInDirectories(paths: DemoPaths): { root: string; accepting: string; closed: string } {
  const root = path.join(paths.data, 'local', 'demo-sign-ins')
  return { root, accepting: path.join(root, 'accepting'), closed: path.join(root, 'closed') }
}

async function privateDirectory(dir: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077
      || process.getuid && stat.uid !== process.getuid()) throw new Error('Demo sign-in directory is not private; data was kept')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function prepareDemoSignIns(paths: DemoPaths): Promise<void> {
  const dirs = demoSignInDirectories(paths)
  for (const dir of [path.dirname(dirs.root), dirs.root]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await privateDirectory(dir)
  }
  if (await privateDirectory(dirs.closed)) return
  await fs.mkdir(dirs.accepting, { mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  await privateDirectory(dirs.accepting)
}

export async function closeDemoSignIns(paths: DemoPaths): Promise<void> {
  const dirs = demoSignInDirectories(paths)
  if (!await privateDirectory(path.dirname(dirs.root)) || !await privateDirectory(dirs.root)) return
  const closed = await privateDirectory(dirs.closed)
  const accepting = await privateDirectory(dirs.accepting)
  if (closed && accepting) throw new Error('Demo sign-in admission is inconsistent; data was kept')
  // Rename also captures a writer whose record was opened just before admission closed.
  if (accepting) await fs.rename(dirs.accepting, dirs.closed)
  if (!closed && !accepting) return
  for (const name of await fs.readdir(dirs.closed)) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) throw new Error('Demo sign-in record is invalid; data was kept')
    const handle = await fs.open(path.join(dirs.closed, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let record: { pid: number; startTime: string }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) {
        throw new Error('Demo sign-in record is not private; data was kept')
      }
      record = JSON.parse(await handle.readFile('utf8'))
    } finally { await handle.close() }
    if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 1
      || typeof record.startTime !== 'string' || !/^ps:[A-Za-z0-9 :]+$/.test(record.startTime)) {
      throw new Error('Demo sign-in identity is unavailable; data was kept')
    }
    if (!await demoProcessGone(record)) {
      throw new Error('Demo sign-in is still open in Terminal. Finish or close it, then reset again. Demo data was kept.')
    }
  }
}

/** POSIX single quoting; csh and fish read `'\''` the same way. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const DEMO_NOT_TAKING_SIGN_INS = 'Walnut Demo is not taking sign-ins right now, so this sign-in did not start. Demo data was kept. Start sign-in again from Walnut Demo.'
export const DEMO_CLI_NOT_FOUND = 'Claude Code was not found. Install it in Walnut Demo, then try signing in again.'
const UNSAFE_IN_COMMAND = /[\u0000-\u001f\u007f\\]/
const SYSTEM_PATH = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

// As desktop/ClaudeSignInBridge.swift: the record exists before the CLI runs under that pid, so reset can wait for it.
export function demoSignInCommand(paths: DemoPaths, inheritedPath = process.env.PATH ?? ''): string | null {
  const home = paths.home
  const accepting = demoSignInDirectories(paths).accepting
  if ([home, accepting].some(value => !path.isAbsolute(value) || UNSAFE_IN_COMMAND.test(value))) return null
  const privateBins = ['.local/bin', '.npm-global/bin', '.bun/bin'].map(dir => path.join(home, dir))
  const inherited = inheritedPath.split(':').filter(dir => path.isAbsolute(dir) && !UNSAFE_IN_COMMAND.test(dir))
  const search = [...new Set([...privateBins, ...inherited, ...SYSTEM_PATH])].join(':')
  // Paths ride in the environment: the script stays free of backslashes and `!`, which fish and csh read differently.
  const fail = `walnut_fail() { echo "${DEMO_NOT_TAKING_SIGN_INS}"; exit 1; }`
  const script = [
    'umask 077', fail,
    'walnut_cli=$(command -v claude 2>/dev/null)',
    `case "$walnut_cli" in /*) ;; *) echo "${DEMO_CLI_NOT_FOUND}"; exit 1 ;; esac`,
    'walnut_dir=$WALNUT_DEMO_SIGN_INS', 'unset WALNUT_DEMO_SIGN_INS',
    '[ -h "$walnut_dir" ] && walnut_fail',
    '[ -d "$walnut_dir" ] || walnut_fail',
    'walnut_id=$(/usr/bin/uuidgen 2>/dev/null || /bin/cat /proc/sys/kernel/random/uuid 2>/dev/null) || walnut_fail',
    '[ ${#walnut_id} -eq 36 ] || walnut_fail',
    'walnut_bad=$(printf %s "$walnut_id" | LC_ALL=C /usr/bin/tr -d 0-9A-Fa-f-) || walnut_fail',
    '[ -z "$walnut_bad" ] || walnut_fail',
    'walnut_start=$(LC_ALL=C TZ=UTC /bin/ps -o lstart= -p $$ 2>/dev/null) || walnut_fail',
    // Folded the way demoProcessStart folds it, or reset never matches the record.
    'set -f', 'set -- $walnut_start', 'walnut_start="$*"', 'set +f',
    '[ -n "$walnut_start" ] || walnut_fail',
    'walnut_bad=$(printf %s "$walnut_start" | LC_ALL=C /usr/bin/tr -d "A-Za-z0-9: ") || walnut_fail',
    '[ -z "$walnut_bad" ] || walnut_fail',
    'USER=$(/usr/bin/id -un) || walnut_fail', 'export USER',
    'set -C',
    `{ printf '{"pid":%d,"startTime":"ps:%s"}' "$$" "$walnut_start" > "$walnut_dir/$walnut_id.json"; } 2>/dev/null || walnut_fail`,
    'set +C',
    'exec "$walnut_cli" auth login',
  ].join('; ')
  return `/usr/bin/env -i HOME=${shellQuote(home)} CLAUDE_CONFIG_DIR=${shellQuote(path.join(home, '.claude'))}`
    + ` PATH=${shellQuote(search)} TERM=xterm-256color WALNUT_DEMO_SIGN_INS=${shellQuote(accepting)} /bin/sh -c ${shellQuote(script)}`
}

/** Where the Demo writes its sign-in script: this generation's data, private to the account. */
export function demoSignInScriptFile(paths: DemoPaths): string {
  return path.join(paths.data, 'local', 'demo-sign-in.sh')
}

/**
 * The sign-in command a person pastes: `/bin/sh '<this generation's script>'`, one short line. The
 * script is demoSignInCommand's line, unchanged, run with `exec` so its pid is the one it records
 * (2026-11-08: the whole line, about 1,500 characters, filled the first-use card in a browser).
 * Null when there is no line to write, or the file's path is not one a shell reads the same.
 */
export async function writeDemoSignInScript(paths: DemoPaths, inheritedPath = process.env.PATH ?? ''): Promise<string | null> {
  const line = demoSignInCommand(paths, inheritedPath)
  const file = demoSignInScriptFile(paths)
  if (!line || UNSAFE_IN_COMMAND.test(file)) return null
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, `#!/bin/sh\nexec ${line}\n`, { mode: 0o700, flag: 'w' })
  await fs.chmod(tmp, 0o700)
  await fs.rename(tmp, file)
  return `/bin/sh ${shellQuote(file)}`
}

export async function reopenDemoSignIns(paths: DemoPaths): Promise<void> {
  await closeDemoSignIns(paths)
  const dirs = demoSignInDirectories(paths)
  if (await privateDirectory(dirs.closed)) {
    for (const name of await fs.readdir(dirs.closed)) await fs.unlink(path.join(dirs.closed, name))
    await fs.rename(dirs.closed, dirs.accepting)
  } else await prepareDemoSignIns(paths)
}
