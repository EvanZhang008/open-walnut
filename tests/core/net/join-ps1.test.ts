/**
 * The Windows invite (net-join-ps1.ts, scripts/join.ps1), run for real by PowerShell with
 * a stand-in wsl.exe that records what it is asked and answers like WSL: it readies WSL and
 * its own Linux, sets that Linux up once (a user, systemd, no Windows PATH), and hands over
 * to the same join a Linux machine runs. A real Windows PC runs the whole of it in
 * .github/workflows/windows-join.yml.
 *
 * Needs PowerShell (`pwsh`, or WALNUT_TEST_PWSH); skipped without it. GitHub's Linux and
 * macOS runners have it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { joinScriptWindows, startScriptWindows, WSL_DISTRO } from '../../../src/core/net/net-join-ps1.js'
import { JOIN_PS1_URL, JOIN_SCRIPT_URL, PS_TLS12, ticketWindowsCommand } from '../../../src/core/net/join-ticket.js'
import { guardedPath } from '../../setup/exec-guard.js'

const ROOT = path.resolve(__dirname, '../../..')
const PWSH = (() => {
  if (process.env.WALNUT_TEST_PWSH) return process.env.WALNUT_TEST_PWSH
  const r = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
})()
const withPwsh = PWSH ? describe : describe.skip

let dir = ''

// wsl.exe as WSL answers. Every Linux command arrives as `--exec sh -c "echo <b64> | base64 -d | sh"`:
// the stand-in decodes it, keeps it, and answers what that step would.
function standIn(mode: { version?: 'ok' | 'old' | 'none'; linuxUser?: string } = {}): void {
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const version = mode.version ?? 'ok'
  fs.writeFileSync(path.join(bin, 'wsl.exe'), `#!/bin/sh
d="${dir}"
echo "$*" >> "$d/calls"
case "$1" in
  --version) ${version === 'ok' ? 'echo "WSL version: 2.3.26.0"; echo "Kernel version: 5.15"; exit 0' : 'exit 1'} ;;
  --status) ${version === 'none' ? 'exit 1' : 'exit 0'} ;;
  --list) cat "$d/distros" 2>/dev/null; exit 0 ;;
  --import) echo "$2" >> "$d/distros"; exit 0 ;;
  --terminate) exit 0 ;;
esac
last=""; for a in "$@"; do last="$a"; done
b64=$(printf '%s' "$last" | sed -n 's/^echo \\([A-Za-z0-9+\\/=]*\\) | base64 -d | sh$/\\1/p')
n=$(ls "$d"/linux-* 2>/dev/null | wc -l | tr -d ' ')
printf '%s' "$b64" | base64 -d > "$d/linux-$n"
user=$(printf '%s\\n' "$*" | sed -n 's/.* -u \\([^ ]*\\) .*/\\1/p')
echo "$user" > "$d/linux-$n.user"
if grep -q wsl.conf.new "$d/linux-$n"; then ${mode.linuxUser ? `echo "user=${mode.linuxUser}"; ` : ''}[ -f "$d/configured" ] || { touch "$d/configured"; echo restart; }; exit 0; fi
if grep -q 'curl -fsSL' "$d/linux-$n"; then echo "the Linux join ran"; env | grep -E '^WSLENV=' ; exit 0; fi
exit 0
`, { mode: 0o755 })
}

function run(script: string, env: Record<string, string> = {}) {
  const file = path.join(dir, 'join.ps1')
  fs.writeFileSync(file, script)
  const r = spawnSync(PWSH!, ['-NoProfile', '-NonInteractive', '-File', file], {
    encoding: 'utf8',
    env: {
      PATH: guardedPath([path.join(dir, 'bin')], '/usr/bin:/bin'), HOME: dir, USERNAME: 'PC',
      LOCALAPPDATA: path.join(dir, 'local'), TEMP: path.join(dir, 'temp'),
      WALNUT_WSL_ROOTFS: path.join(dir, 'rootfs.tar.gz'), ...env,
    },
  })
  const calls = fs.existsSync(path.join(dir, 'calls')) ? fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n') : []
  const linux = fs.readdirSync(dir).filter((f) => /^linux-\d+$/.test(f)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    .map((f) => ({ user: fs.readFileSync(path.join(dir, `${f}.user`), 'utf8').trim(), script: fs.readFileSync(path.join(dir, f), 'utf8') }))
  return { ...r, out: `${r.stdout}${r.stderr}`, calls, linux }
}

const TICKET = 'wn1-eyJ2IjoxfQ'

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'join-ps1-')))
  fs.writeFileSync(path.join(dir, 'rootfs.tar.gz'), 'not a real image')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('scripts/join.ps1', () => {
  it('is what the generator makes, and the Settings command runs it', () => {
    expect(fs.readFileSync(path.join(ROOT, 'scripts/join.ps1'), 'utf8')).toBe(joinScriptWindows({ ticket: true }))
    // TLS 1.2 first: Windows PowerShell 5.1 may offer only TLS 1.0, which GitHub refuses.
    expect(PS_TLS12).toBe('[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; ')
    expect(ticketWindowsCommand(TICKET)).toBe(`${PS_TLS12}$env:WALNUT_JOIN_TICKET='${TICKET}'; iex ((New-Object Net.WebClient).DownloadString('${JOIN_PS1_URL}'))`)
  })

  it('never exits the window it runs in, and quotes no link it was given', () => {
    const s = joinScriptWindows({ origin: "https://wn.example.dev'; Remove-Item x; '", code: "ABCD-EFGH-JKLM'" })
    // Everything but URL characters is dropped, so no quote or `;` ever closes the string.
    expect(s).toContain(`$inner = 'f=$(mktemp) && curl -fsSL ''https://wn.example.devRemove-Itemx/join/ABCD-EFGH-JKLM'' -o "$f" && sh "$f"; c=$?; rm -f "$f"; exit $c'`)
    expect(s).not.toMatch(/'; Remove-Item x|Remove-Item x;/)
    // `exit` only when run as a file; under `irm | iex` it would close the user's PowerShell
    // (the Linux join's own `exit`, in the sh it hands over, is not PowerShell's).
    expect(s.split('\n').filter((l) => !l.includes('$inner =')).join('\n').match(/\bexit\b/g)).toEqual(['exit'])
    expect(s).toContain('if ($PSCommandPath) { exit $code }')
  })

  it('calls no script function of Windows PowerShell 5.1 modules, which a 5.1 started from PowerShell 7 lacks', () => {
    // 2026-11-02, CI: Get-FileHash was not recognized. These are defined in 5.1's Utility .psm1,
    // not compiled in, so a 5.1 that inherited PowerShell 7's module path never gets them.
    const SCRIPT_FUNCTIONS = /\b(Get-FileHash|New-TemporaryFile|New-Guid|Format-Hex|Import-PowerShellDataFile|ConvertFrom-SddlString)\b/i
    for (const s of [joinScriptWindows({ ticket: true }), joinScriptWindows({ origin: 'https://wn.example.dev', code: 'ABCD-EFGH-JKLM' }), startScriptWindows()]) {
      expect(s.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(SCRIPT_FUNCTIONS)
    }
  })
})

withPwsh('the Windows invite, run by PowerShell against a stand-in WSL', () => {
  it('parses', () => {
    const r = spawnSync(PWSH!, ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, 'scripts/join.ps1')}',[ref]$null,[ref]$e); $e.Count`], { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe('0')
  })

  // What the sign-in item and "Open Walnut" in the Start menu run; a Windows PC runs it in
  // windows-join.yml (Start-Process -WindowStyle exists only on Windows).
  it('start.ps1 parses, and the join writes it as it is', () => {
    const f = path.join(dir, 'start.ps1')
    fs.writeFileSync(f, startScriptWindows())
    const r = spawnSync(PWSH!, ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f}',[ref]$null,[ref]$e); $e.Count`], { encoding: 'utf8' })
    expect(r.stdout.trim()).toBe('0')
    expect(joinScriptWindows({ ticket: true })).toContain(`-Value @'\n${startScriptWindows().trimEnd()}\n'@`)
  })

  // 2026-11-02: over SSH, Windows ends every process of the session when it closes (home-pc:
  // a Start-Process child was gone after the disconnect, a WMI one lived), so a join run over
  // SSH left nothing holding the Linux, and WSL stopped Walnut until the next sign-in.
  it.each([
    ['in a window', undefined, 'Start-Process'],
    ['over SSH', '192.0.2.5 51234 192.0.2.9 22', 'Invoke-CimMethod'],
  ])('start.ps1 %s starts the hold so it outlives the session that ran it', (_how, ssh, by) => {
    const f = path.join(dir, 'start.ps1')
    fs.writeFileSync(f, startScriptWindows())
    const log = path.join(dir, 'started')
    // Functions win over cmdlets of the same name: each records how the hold was started.
    const probe = [
      `function Start-Process { param($FilePath, $WindowStyle, $WorkingDirectory, $ArgumentList) Add-Content '${log}' ('Start-Process ' + $FilePath + ' ' + ($ArgumentList -join ' ')) }`,
      `function Invoke-CimMethod { param($ClassName, $MethodName, $Arguments) Add-Content '${log}' ('Invoke-CimMethod ' + $ClassName + ' ' + $MethodName + ' ' + $Arguments.CommandLine) }`,
      `& '${f}'`,
    ].join('; ')
    const env: Record<string, string | undefined> = { ...process.env, PATH: guardedPath([], '/usr/bin:/bin'), SSH_CONNECTION: ssh, SystemRoot: 'C:\\Windows' }
    if (!ssh) delete env.SSH_CONNECTION
    const r = spawnSync(PWSH!, ['-NoProfile', '-NonInteractive', '-Command', probe], { encoding: 'utf8', env })
    expect(r.status, r.stderr).toBe(0)
    const started = fs.readFileSync(log, 'utf8').trim().split('\n')
    expect(started).toHaveLength(1)
    expect(started[0].startsWith(by + ' ')).toBe(true)
    expect(started[0]).toContain('-Hold')
    if (ssh) expect(started[0]).toContain('Win32_Process Create')
  })

  it('a PC with WSL: makes its own Linux once, sets it up, and hands over to the Linux join', () => {
    standIn()
    const r = run(joinScriptWindows({ ticket: true }), { WALNUT_JOIN_TICKET: TICKET })
    expect(r.out).not.toMatch(/could not join|failed/i)
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('Walnut: adding this PC to your Walnut machines')
    expect(r.out).toContain('  WSL ............... ready (2.3.26.0)')
    expect(r.out).toContain(`  Linux ............. ${WSL_DISTRO} ready (Ubuntu 24.04, user pc)`)
    expect(r.out).toContain('the Linux join ran')
    expect(r.out).toContain(`To take it off this PC: wsl --unregister ${WSL_DISTRO}`)
    // Its own Linux, never the user's: imported once under its own name, restarted once for systemd.
    const imports = r.calls.filter((c) => c.startsWith('--import'))
    expect(imports).toHaveLength(1)
    expect(imports[0]).toMatch(new RegExp(`^--import ${WSL_DISTRO} \\S*OpenWalnut.wsl.${WSL_DISTRO} ${path.join(dir, 'rootfs.tar.gz')} --version 2$`))
    expect(r.calls).toContain(`--terminate ${WSL_DISTRO}`)
    expect(r.calls.every((c) => c.startsWith('--') || c.startsWith(`-d ${WSL_DISTRO} `))).toBe(true)
    const [setup, boot, join] = r.linux
    expect(setup.user).toBe('root')
    expect(setup.script.startsWith("u='pc'\n")).toBe(true)
    // Not a system account's name, and a uid of its own (its daemon's lock port follows it).
    expect(setup.script).toContain('[ "$(id -u "$u")" -ge 1000 ] || u=walnut')
    expect(setup.script).toContain('useradd -m -s /bin/bash -K UID_MIN=1500 "$u"')
    expect(setup.script).toContain(`printf '[boot]\\nsystemd=true\\n[user]\\ndefault=%s\\n[interop]\\nappendWindowsPath=false\\n' "$u" > /etc/wsl.conf.new`)
    expect(boot).toEqual({ user: 'root', script: 'timeout 120 systemctl is-system-running --wait >/dev/null 2>&1; loginctl enable-linger pc; test -d /run/systemd/system' })
    expect(join.user).toBe('pc')
    // Fetched to a file first: a failed download never runs as an empty script that succeeds.
    expect(join.script).toBe(`export XDG_RUNTIME_DIR=/run/user/$(id -u)\nf=$(mktemp) && curl -fsSL '${JOIN_SCRIPT_URL}' -o "$f" && sh "$f" ${TICKET}; c=$?; rm -f "$f"; exit $c\n`)
    expect(join.script).not.toContain('\r')
  })

  it('a second run reuses the Linux and its setup, and the knobs a test sets reach the Linux join', () => {
    standIn()
    expect(run(joinScriptWindows({ ticket: true }), { WALNUT_JOIN_TICKET: TICKET }).status).toBe(0)
    fs.rmSync(path.join(dir, 'calls'))
    const r = run(joinScriptWindows({ ticket: true }), {
      WALNUT_JOIN_TICKET: TICKET, WALNUT_JOIN_SCRIPT_URL: 'file:///mnt/d/repo/scripts/join.sh', WALNUT_JOIN_INSTALL_URL: 'file:///mnt/d/repo/scripts/install.sh',
    })
    expect(r.status, r.out).toBe(0)
    expect(r.calls.some((c) => c.startsWith('--import'))).toBe(false)
    expect(r.calls.some((c) => c.startsWith('--terminate'))).toBe(false)
    expect(r.linux.at(-1)!.script).toContain(`curl -fsSL 'file:///mnt/d/repo/scripts/join.sh' -o "$f" && sh "$f" ${TICKET};`)
    expect(r.out).toContain('WSLENV=WALNUT_JOIN_INSTALL_URL/u')
  })

  it('a companion invite hands over its own link', () => {
    standIn()
    const r = run(joinScriptWindows({ origin: 'https://wn.example.dev', code: 'ABCD-EFGH-JKLM' }))
    expect(r.status, r.out).toBe(0)
    expect(r.linux.at(-1)!.script).toContain(`curl -fsSL 'https://wn.example.dev/join/ABCD-EFGH-JKLM' -o "$f" && sh "$f"; c=$?`)
  })

  it('a Windows name that is a system account in Linux: the Linux names its own user, and the join runs as it', () => {
    standIn({ linuxUser: 'walnut' })
    const r = run(joinScriptWindows({ ticket: true }), { WALNUT_JOIN_TICKET: TICKET, USERNAME: 'backup' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain(`  Linux ............. ${WSL_DISTRO} ready (Ubuntu 24.04, user walnut)`)
    expect(r.linux.at(-1)!.user).toBe('walnut')
    expect(r.linux[1].script).toContain('loginctl enable-linger walnut')
  })

  it('a Linux join that fails says so, and its code comes back', () => {
    standIn()
    const wsl = fs.readFileSync(path.join(dir, 'bin/wsl.exe'), 'utf8').replace('echo "the Linux join ran"; env | grep -E \'^WSLENV=\' ; exit 0', 'echo "curl: (6) Could not resolve host" >&2; exit 6')
    fs.writeFileSync(path.join(dir, 'bin/wsl.exe'), wsl, { mode: 0o755 })
    const r = run(joinScriptWindows({ ticket: true }), { WALNUT_JOIN_TICKET: TICKET })
    expect(r.status).toBe(6)
    expect(r.out).toContain(`The join in the ${WSL_DISTRO} Linux stopped (above).`)
    expect(r.out).not.toContain('This PC runs Walnut in WSL')
  })

  it('no ticket, or not one: says what to run and changes nothing', () => {
    standIn()
    const r = run(joinScriptWindows({ ticket: true }), { WALNUT_JOIN_TICKET: 'nope; rm -rf /' })
    expect(r.status).toBe(1)
    expect(r.out).toContain('Run the command your Mac shows under Settings > Remote Hosts > Add a machine.')
    // Checked before anything: no WSL step, no download, no Linux made.
    expect(r.calls).toEqual([])
  })

  it('an old WSL, or none: asks Windows for the one administrator step, and stops cleanly when it is declined', () => {
    standIn({ version: 'old' })
    let r = run(joinScriptWindows({ ticket: true }), { WALNUT_JOIN_TICKET: TICKET })
    expect(r.status).toBe(1)
    expect(r.out).toContain('too old for Walnut: Windows asks you next to let it update (an administrator prompt)')
    expect(r.out).toContain('WSL was not updated (the prompt was declined). Run "wsl --update" yourself, then paste this command again.')
    expect(r.calls.some((c) => c.startsWith('--import'))).toBe(false)

    fs.rmSync(path.join(dir, 'calls'))
    standIn({ version: 'none' })
    r = run(joinScriptWindows({ ticket: true }), { WALNUT_JOIN_TICKET: TICKET })
    expect(r.status).toBe(1)
    expect(r.out).toContain('not on this PC: Windows asks you next to turn it on (an administrator prompt)')
    expect(r.out).toContain('WSL was not turned on (the prompt was declined).')
  })
})
