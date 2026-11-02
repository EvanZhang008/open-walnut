/**
 * Windows and WSL, as the app reaches them: PowerShell for the setup script (hidden, its lines
 * read back), wsl.exe for a look into the OpenWalnut Linux, and the console's own port.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { psQuote } from './model'

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
export const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
export const WSL = path.join(SYSTEM_ROOT, 'System32', 'wsl.exe')
/** The WSL Linux Walnut runs in (net-join-ps1.ts WSL_DISTRO). */
export const DISTRO = 'OpenWalnut'
/** The app's own Walnut serves its console here (net-join-ps1.ts APP_CONSOLE_PORT). */
export const CONSOLE_PORT = 3456
export const CONSOLE_URL = `http://localhost:${CONSOLE_PORT}`

/** %LOCALAPPDATA%\OpenWalnut: start.ps1, the app's state and its log (the setup script makes it). */
export function walnutDir(): string {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenWalnut')
}

function splitLines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let rest = ''
  return (chunk) => {
    rest += chunk.toString('utf8')
    const lines = rest.split(/\r?\n/)
    rest = lines.pop() ?? ''
    for (const l of lines) onLine(l.replace(/\u0000/g, ''))
  }
}

/**
 * Runs a PowerShell script with no window, in UTF-8 (a Chinese or Japanese Windows prints its
 * errors in its own language, and wsl.exe prints UTF-8 with WSL_UTF8), each line to `onLine`.
 * Read as text into a script block, as `irm | iex` runs the invite: a policy that allows only
 * signed script files (AllSigned) would refuse the file itself, Bypass or not. The script sets
 * $LASTEXITCODE; resolves with it.
 */
export function runPowerShellFile(file: string, env: Record<string, string>, onLine: (line: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(file)}))); exit $LASTEXITCODE`,
    ], { windowsHide: true, cwd: os.homedir(), env: { ...process.env, WSL_UTF8: '1', ...env } })
    child.stdout.on('data', splitLines(onLine))
    child.stderr.on('data', splitLines(onLine))
    child.on('error', (err) => { onLine(`Could not start PowerShell: ${err.message}`); resolve(null) })
    child.on('close', (code) => resolve(code))
  })
}

/**
 * A command in the OpenWalnut Linux, as its default user, with a deadline. The script goes as
 * base64, as the setup script sends its own: nothing of it is quoted on the Windows command line.
 */
export function inLinux(script: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  const b64 = Buffer.from(script.replace(/\r/g, ''), 'utf8').toString('base64')
  return new Promise((resolve) => {
    const child = spawn(WSL, ['-d', DISTRO, '--cd', '~', '--exec', 'sh', '-c', `echo ${b64} | base64 -d | sh`], {
      windowsHide: true, env: { ...process.env, WSL_UTF8: '1' },
    })
    let out = ''
    const add = (b: Buffer) => { if (out.length < 64_000) out += b.toString('utf8') }
    child.stdout.on('data', add)
    child.stderr.on('data', add)
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, out: err.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.replace(/\u0000/g, '') }) })
  })
}

/** The Linuxes WSL has, from wsl.exe (UTF-16 unless WSL_UTF8, so the NULs are dropped either way). */
export function distros(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(WSL, ['--list', '--quiet'], { windowsHide: true, env: { ...process.env, WSL_UTF8: '1' } })
    let out = ''
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8') })
    const timer = setTimeout(() => child.kill(), 30_000)
    child.on('error', () => { clearTimeout(timer); resolve([]) })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out.replace(/\u0000/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    })
  })
}

const WALNUT = '"$HOME/.local/share/open-walnut/bin/walnut"'

/** What the OpenWalnut Linux says it is, for a PC the app has no record of (model.ts inferMode). */
export async function probeLinux(): Promise<{ exists: boolean; consoleActive: boolean; joined: boolean }> {
  if (!(await distros()).includes(DISTRO)) return { exists: false, consoleActive: false, joined: false }
  const r = await inLinux([
    'export XDG_RUNTIME_DIR=/run/user/$(id -u)',
    'echo "console=$(systemctl --user is-active open-walnut-web.service 2>/dev/null)"',
    `[ -x ${WALNUT} ] && ${WALNUT} net status 2>/dev/null`,
    'true',
  ].join('\n'), 60_000)
  return { exists: true, consoleActive: /^console=active$/m.test(r.out), joined: /"enabled":\s*true/.test(r.out) }
}

/**
 * Starts the hold that keeps the Linux running (start.ps1, one at a time by its own mutex), as
 * the sign-in item does: after a `wsl --shutdown`, or on the first open after setup.
 */
export function holdLinux(): void {
  const start = path.join(walnutDir(), 'start.ps1')
  if (!fs.existsSync(start)) return
  const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', start], {
    windowsHide: true, detached: true, stdio: 'ignore', cwd: SYSTEM_ROOT,
  })
  child.on('error', () => { /* the sign-in item starts it next time */ })
  child.unref()
}

/** The console answers on Windows' localhost (WSL forwards it into the Linux). */
export async function consoleAnswers(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/api/config`, { signal: AbortSignal.timeout(4000) })
    return r.ok
  } catch {
    return false
  }
}

/** `walnut net status` in the Linux (JSON): the This PC page says it (model.ts netSummary). */
export async function netStatus(): Promise<string> {
  const r = await inLinux(`${WALNUT} net status 2>&1`, 45_000)
  return r.out.trim()
}
