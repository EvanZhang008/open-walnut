import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  DAEMON_SERVICE_LABEL,
  DAEMON_SERVICE_PLIST_NAME,
  DAEMON_SERVICE_UNIT_NAME,
  daemonInstallRoot,
  renderDaemonLaunchAgent,
  renderDaemonSystemdUnit,
  replaceDaemonServiceExecutable,
  readDaemonServiceExecutable,
  type DaemonServiceConfig,
  type DaemonServicePlatform,
} from '../../src/providers/daemon-service-config.js'

const LINUX: DaemonServiceConfig = {
  platform: 'linux',
  home: '/home/walnut',
  executable: '/home/walnut/.local/share/open-walnut/daemon/open-walnut-daemon',
  args: ['--start'],
  runtimeDir: '/tmp/open-walnut',
  stateDir: '/home/walnut/.local/share/open-walnut/daemon',
  path: '/usr/local/bin:/usr/bin:/bin',
  user: 'walnut',
}

const DARWIN: DaemonServiceConfig = {
  platform: 'darwin',
  home: '/Users/example',
  executable: '/Users/example/Library/Application Support/Open Walnut/Daemon/open-walnut-daemon',
  args: ['--start'],
  runtimeDir: '/tmp/open-walnut',
  stateDir: '/Users/example/Library/Application Support/Open Walnut/Daemon',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
}

const linux = (over: Partial<DaemonServiceConfig> = {}): DaemonServiceConfig => ({ ...LINUX, ...over })
const darwin = (over: Partial<DaemonServiceConfig> = {}): DaemonServiceConfig => ({ ...DARWIN, ...over })

function lineOf(text: string, prefix: string): string {
  const hits = text.split('\n').filter((line) => line.startsWith(prefix))
  expect(hits, `expected exactly one line starting with ${prefix}`).toHaveLength(1)
  return hits[0]
}

function linesOf(text: string, prefix: string): string[] {
  return text.split('\n').filter((line) => line.startsWith(prefix))
}

/** The value side of `<key>NAME</key>` in a plist dict, one line later. */
function plistValueAfter(text: string, key: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() === `<key>${key}</key>`)
  expect(at, `missing key ${key}`).toBeGreaterThan(-1)
  return lines[at + 1].trim()
}

/** The body of the container `<key>NAME</key>` opens, matched at its own indent. */
function containerAfter(text: string, key: string, kind: 'array' | 'dict'): string[] {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() === `<key>${key}</key>`)
  expect(at, `missing key ${key}`).toBeGreaterThan(-1)
  const indent = lines[at].slice(0, lines[at].indexOf('<'))
  expect(lines[at + 1]).toBe(`${indent}<${kind}>`)
  const end = lines.indexOf(`${indent}</${kind}>`, at + 2)
  expect(end, `unterminated ${kind} for ${key}`).toBeGreaterThan(at + 1)
  return lines.slice(at + 2, end)
}

describe.each(['linux', 'darwin'] as const)('service executable update on %s', (platform) => {
  const render = (executable: string) => platform === 'linux'
    ? renderDaemonSystemdUnit(linux({ executable, args: ['--service'] }), 'user')
    : renderDaemonLaunchAgent(darwin({ executable, args: ['--service'] }))

  it.each(['/opt/daemon', '/opt/\u5de5\u4f5c $HOME %h "quoted" \\ path/daemon', '/opt/a&b<service>/daemon'])('changes only the executable with correct escaping: %s', (executable) => { // the second path has a CJK segment ("work")
    const previous = render('/opt/previous/daemon')
    expect(replaceDaemonServiceExecutable(platform, previous, executable)).toBe(render(executable))
    expect(readDaemonServiceExecutable(platform, render(executable))).toBe(executable)
  })

  it('refuses missing and ambiguous executable declarations', () => {
    const previous = render('/opt/previous/daemon')
    for (const text of ['', previous + previous, previous.replaceAll('--service', '--start')]) {
      expect(() => replaceDaemonServiceExecutable(platform, text, '/opt/new/daemon')).toThrow('not recognized')
    }
  })

  it('refuses relative paths and newlines before modifying config', () => {
    for (const executable of ['relative/daemon', '/opt/daemon\nInjected=true']) {
      expect(() => replaceDaemonServiceExecutable(platform, render('/opt/old/daemon'), executable)).toThrow()
    }
  })
})

describe('daemonInstallRoot', () => {
  it('puts the linux install root under the XDG data dir', () => {
    expect(daemonInstallRoot('linux', '/home/walnut'))
      .toBe('/home/walnut/.local/share/open-walnut/daemon')
  })

  it('puts the darwin install root under Application Support', () => {
    expect(daemonInstallRoot('darwin', '/Users/example'))
      .toBe('/Users/example/Library/Application Support/Open Walnut/Daemon')
  })

  it('joins rather than concatenates, so a trailing slash does not double up', () => {
    expect(daemonInstallRoot('linux', '/home/walnut/')).toBe(daemonInstallRoot('linux', '/home/walnut'))
    expect(daemonInstallRoot('darwin', '/Users/example/')).toBe(daemonInstallRoot('darwin', '/Users/example'))
  })

  it('keeps a home with spaces and non-ASCII characters verbatim', () => {
    const home = '/Users/\u7528\u6237 \u7a7a\u683c' // CJK "user" + "space"
    expect(daemonInstallRoot('darwin', home))
      .toBe(path.join(home, 'Library', 'Application Support', 'Open Walnut', 'Daemon'))
  })

  it('rejects a relative home', () => {
    expect(() => daemonInstallRoot('linux', 'home/walnut')).toThrow(/absolute path/)
    expect(() => daemonInstallRoot('linux', '')).toThrow(/must not be empty/)
  })

  it('rejects a home carrying a NUL, a newline, or a traversal segment', () => {
    expect(() => daemonInstallRoot('linux', '/home/wal\u0000nut')).toThrow(/control characters/)
    expect(() => daemonInstallRoot('linux', '/home/walnut\nExecStart=/bin/sh')).toThrow(/control characters/)
    expect(() => daemonInstallRoot('linux', '/home/walnut/../root')).toThrow(/".." segments/)
  })

  it('rejects a platform it cannot render for', () => {
    expect(() => daemonInstallRoot('win32' as DaemonServicePlatform, '/home/walnut'))
      .toThrow(/unsupported platform/)
  })
})

describe('renderDaemonSystemdUnit — user scope', () => {
  const unit = renderDaemonSystemdUnit(linux(), 'user')

  it('renders the three sections once each and ends with a newline', () => {
    expect(linesOf(unit, '[Unit]')).toHaveLength(1)
    expect(linesOf(unit, '[Service]')).toHaveLength(1)
    expect(linesOf(unit, '[Install]')).toHaveLength(1)
    expect(unit.endsWith('\n')).toBe(true)
    expect(unit).not.toContain('\r')
  })

  it('is a simple service that restarts on failure with a rate limit', () => {
    expect(lineOf(unit, 'Type=')).toBe('Type=simple')
    expect(lineOf(unit, 'Restart=')).toBe('Restart=on-failure')
    expect(lineOf(unit, 'RestartSec=')).toBe('RestartSec=5')
    expect(lineOf(unit, 'StartLimitIntervalSec=')).toBe('StartLimitIntervalSec=60')
    expect(lineOf(unit, 'StartLimitBurst=')).toBe('StartLimitBurst=5')
  })

  it('leaves the spawned CLI processes alone on stop and keeps files private', () => {
    expect(lineOf(unit, 'KillMode=')).toBe('KillMode=process')
    expect(lineOf(unit, 'TimeoutStopSec=')).toBe('TimeoutStopSec=60')
    expect(lineOf(unit, 'UMask=')).toBe('UMask=0077')
  })

  it('runs from the home directory, unquoted (systemd does not unquote path settings)', () => {
    expect(lineOf(unit, 'WorkingDirectory=')).toBe('WorkingDirectory=/home/walnut')
  })

  it('starts the executable by absolute path with the caller-supplied args only', () => {
    expect(lineOf(unit, 'ExecStart='))
      .toBe('ExecStart="/home/walnut/.local/share/open-walnut/daemon/open-walnut-daemon" "--start"')
  })

  it('never adds a User= line', () => {
    expect(linesOf(unit, 'User=')).toHaveLength(0)
    expect(unit).not.toContain('Group=')
  })

  it('installs into the user manager default target', () => {
    expect(lineOf(unit, 'WantedBy=')).toBe('WantedBy=default.target')
  })

  it('declares exactly the four environment variables, in order', () => {
    expect(linesOf(unit, 'Environment=')).toEqual([
      'Environment="HOME=/home/walnut"',
      'Environment="PATH=/usr/local/bin:/usr/bin:/bin"',
      'Environment="WALNUT_DAEMON_DIR=/tmp/open-walnut"',
      'Environment="WALNUT_DAEMON_STATE_DIR=/home/walnut/.local/share/open-walnut/daemon"',
    ])
  })

  it('carries no credential-shaped material', () => {
    expect(unit).not.toMatch(/token|secret|credential|password|bearer|api[_-]?key/i)
    expect(unit).not.toMatch(/AWS_|ANTHROPIC_/)
  })

  it('does not order against the network in the user manager', () => {
    expect(unit).not.toContain('network')
  })

  it('is deterministic and does not mutate the config it was given', () => {
    const config = linux()
    const snapshot = structuredClone(config)
    expect(renderDaemonSystemdUnit(config, 'user')).toBe(renderDaemonSystemdUnit(config, 'user'))
    expect(config).toEqual(snapshot)
  })
})

describe('renderDaemonSystemdUnit — system scope', () => {
  const unit = renderDaemonSystemdUnit(linux(), 'system')

  it('runs as the original user and installs into multi-user.target', () => {
    expect(lineOf(unit, 'User=')).toBe('User=walnut')
    expect(lineOf(unit, 'WantedBy=')).toBe('WantedBy=multi-user.target')
    expect(lineOf(unit, 'After=')).toBe('After=network.target')
  })

  it('still points HOME at the user home rather than root', () => {
    expect(linesOf(unit, 'Environment=')[0]).toBe('Environment="HOME=/home/walnut"')
  })

  it('refuses to render without a user, because it would default to root', () => {
    const { user: _user, ...withoutUser } = linux()
    expect(() => renderDaemonSystemdUnit(withoutUser as DaemonServiceConfig, 'system'))
      .toThrow(/needs config\.user/)
    expect(() => renderDaemonSystemdUnit(linux({ user: '' }), 'system')).toThrow(/must not be empty/)
  })

  it('rejects a user name that could smuggle another directive or a specifier', () => {
    expect(() => renderDaemonSystemdUnit(linux({ user: 'walnut\nExecStartPre=/bin/sh -c id' }), 'system'))
      .toThrow(/control characters/)
    expect(() => renderDaemonSystemdUnit(linux({ user: 'wal nut' }), 'system')).toThrow(/plain account name/)
    expect(() => renderDaemonSystemdUnit(linux({ user: '%h' }), 'system')).toThrow(/plain account name/)
    expect(() => renderDaemonSystemdUnit(linux({ user: '-walnut' }), 'system')).toThrow(/plain account name/)
    expect(() => renderDaemonSystemdUnit(linux({ user: '$USER' }), 'system')).toThrow(/plain account name/)
  })

  it('accepts a numeric uid', () => {
    expect(lineOf(renderDaemonSystemdUnit(linux({ user: '1000' }), 'system'), 'User=')).toBe('User=1000')
  })

  it('validates a user it will not use, so a bad config fails in both scopes', () => {
    expect(() => renderDaemonSystemdUnit(linux({ user: 'wal nut' }), 'user')).toThrow(/plain account name/)
  })
})

describe('renderDaemonSystemdUnit — quoting and injection', () => {
  it('keeps a path with spaces as one argument', () => {
    const unit = renderDaemonSystemdUnit(linux({ executable: '/opt/Open Walnut/daemon' }), 'user')
    expect(lineOf(unit, 'ExecStart=')).toBe('ExecStart="/opt/Open Walnut/daemon" "--start"')
  })

  it('escapes quotes and backslashes in an argument', () => {
    const unit = renderDaemonSystemdUnit(linux({ args: ['--tag="a b"', 'back\\slash'] }), 'user')
    expect(lineOf(unit, 'ExecStart='))
      .toBe(`ExecStart="${LINUX.executable}" "--tag=\\"a b\\"" "back\\\\slash"`)
  })

  it('doubles a percent so systemd does not read it as a specifier', () => {
    const unit = renderDaemonSystemdUnit(linux({ args: ['--label=%h/%%n'], home: '/home/100%real' }), 'user')
    expect(lineOf(unit, 'ExecStart=')).toBe(`ExecStart="${LINUX.executable}" "--label=%%h/%%%%n"`)
    expect(lineOf(unit, 'WorkingDirectory=')).toBe('WorkingDirectory=/home/100%%real')
    expect(linesOf(unit, 'Environment=')[0]).toBe('Environment="HOME=/home/100%%real"')
  })

  it('doubles a dollar in an exec argument, where systemd expands variables', () => {
    const unit = renderDaemonSystemdUnit(linux({ args: ['--dir=$HOME/x', '--raw=${PATH}'] }), 'user')
    expect(lineOf(unit, 'ExecStart='))
      .toBe('ExecStart="' + LINUX.executable + '" "--dir=$$HOME/x" "--raw=$${PATH}"')
  })

  it('leaves a dollar literal in Environment=, which systemd does not expand', () => {
    const unit = renderDaemonSystemdUnit(linux({ path: '/opt/$tools/bin:/usr/bin' }), 'user')
    expect(linesOf(unit, 'Environment=')[1]).toBe('Environment="PATH=/opt/$tools/bin:/usr/bin"')
  })

  it('keeps shell metacharacters inside the quoted word (nothing runs through a shell)', () => {
    const unit = renderDaemonSystemdUnit(linux({ args: ['--x=a; rm -rf /', '--y=`id`', '--z=&& id'] }), 'user')
    const exec = lineOf(unit, 'ExecStart=')
    expect(exec).toBe(`ExecStart="${LINUX.executable}" "--x=a; rm -rf /" "--y=\`id\`" "--z=&& id"`)
    expect(exec.split('"').length % 2).toBe(1)
  })

  it('keeps non-ASCII paths verbatim', () => {
    const home = '/home/\u7528\u6237 \u7a7a\u683c' // CJK "user" + "space"
    const unit = renderDaemonSystemdUnit(linux({ home, args: ['--note=\u5907\u6ce8'] }), 'user') // CJK "note"
    expect(lineOf(unit, 'WorkingDirectory=')).toBe(`WorkingDirectory=${home}`)
    expect(linesOf(unit, 'Environment=')[0]).toBe(`Environment="HOME=${home}"`)
    expect(lineOf(unit, 'ExecStart=')).toContain('"--note=\u5907\u6ce8"') // CJK "note"
  })

  it('adds no arguments of its own', () => {
    const unit = renderDaemonSystemdUnit(linux({ args: [] }), 'user')
    expect(lineOf(unit, 'ExecStart=')).toBe(`ExecStart="${LINUX.executable}"`)
    expect(unit).not.toContain('--start')
    expect(unit).not.toContain('--service')
  })
})

describe('renderDaemonSystemdUnit — refusals', () => {
  it('refuses a newline or NUL anywhere it would break the unit file', () => {
    expect(() => renderDaemonSystemdUnit(linux({ args: ['--a\nExecStopPost=/bin/sh -c id'] }), 'user'))
      .toThrow(/args\[0\].*control characters/)
    expect(() => renderDaemonSystemdUnit(linux({ executable: '/opt/d\u0000aemon' }), 'user'))
      .toThrow(/executable.*control characters/)
    expect(() => renderDaemonSystemdUnit(linux({ stateDir: '/var/lib/w\naemon' }), 'user'))
      .toThrow(/stateDir.*control characters/)
    expect(() => renderDaemonSystemdUnit(linux({ home: '/home/wal\tnut' }), 'user'))
      .toThrow(/home.*control characters/)
  })

  it('refuses relative or traversing paths', () => {
    expect(() => renderDaemonSystemdUnit(linux({ executable: 'daemon/open-walnut-daemon' }), 'user'))
      .toThrow(/executable must be an absolute path/)
    expect(() => renderDaemonSystemdUnit(linux({ runtimeDir: 'tmp/open-walnut' }), 'user'))
      .toThrow(/runtimeDir must be an absolute path/)
    expect(() => renderDaemonSystemdUnit(linux({ stateDir: '/var/lib/../../etc' }), 'user'))
      .toThrow(/stateDir must not contain/)
    expect(() => renderDaemonSystemdUnit(linux({ home: '/home/walnut ' }), 'user'))
      .toThrow(/home must not have leading or trailing whitespace/)
  })

  it('refuses a PATH with a relative or empty entry', () => {
    expect(() => renderDaemonSystemdUnit(linux({ path: '/usr/bin:bin' }), 'user'))
      .toThrow(/path entries must be absolute/)
    expect(() => renderDaemonSystemdUnit(linux({ path: '/usr/bin::/bin' }), 'user'))
      .toThrow(/path must not contain an empty entry/)
    expect(() => renderDaemonSystemdUnit(linux({ path: ':/usr/bin' }), 'user'))
      .toThrow(/path must not contain an empty entry/)
    expect(() => renderDaemonSystemdUnit(linux({ path: '/usr/bin:/bin ' }), 'user'))
      .toThrow(/path entries must not have leading or trailing whitespace/)
  })

  it('refuses an empty argument and a non-array args', () => {
    expect(() => renderDaemonSystemdUnit(linux({ args: ['--start', ''] }), 'user'))
      .toThrow(/args\[1\] must not be empty/)
    expect(() => renderDaemonSystemdUnit(linux({ args: '--start' as unknown as string[] }), 'user'))
      .toThrow(/args must be an array/)
    expect(() => renderDaemonSystemdUnit(linux({ args: [42 as unknown as string] }), 'user'))
      .toThrow(/args\[0\] must be a string/)
  })

  it('refuses a config for the other platform and an unknown scope', () => {
    expect(() => renderDaemonSystemdUnit(darwin(), 'user')).toThrow(/expected a linux config/)
    expect(() => renderDaemonSystemdUnit(linux({ platform: 'win32' as DaemonServicePlatform }), 'user'))
      .toThrow(/unsupported platform/)
    expect(() => renderDaemonSystemdUnit(linux(), 'boot' as 'user')).toThrow(/unknown systemd scope/)
  })
})

describe('renderDaemonLaunchAgent', () => {
  const plist = renderDaemonLaunchAgent(darwin())

  it('renders a plist header and closes both containers', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true)
    expect(plist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
      + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">')
    expect(plist).toContain('<plist version="1.0">')
    expect(plist.endsWith('</dict>\n</plist>\n')).toBe(true)
    expect(plist).not.toContain('\r')
  })

  it('uses the stable label, matching the exported file name', () => {
    expect(plistValueAfter(plist, 'Label')).toBe(`<string>${DAEMON_SERVICE_LABEL}</string>`)
    expect(DAEMON_SERVICE_LABEL).toBe('dev.openwalnut.session-daemon')
    expect(DAEMON_SERVICE_PLIST_NAME).toBe('dev.openwalnut.session-daemon.plist')
    expect(DAEMON_SERVICE_UNIT_NAME).toBe('open-walnut-daemon.service')
  })

  it('lists the executable first, then the caller args in order', () => {
    expect(containerAfter(plist, 'ProgramArguments', 'array')).toEqual([
      `\t\t<string>${DARWIN.executable}</string>`,
      '\t\t<string>--start</string>',
    ])
  })

  it('adds no arguments of its own', () => {
    const bare = renderDaemonLaunchAgent(darwin({ args: [] }))
    expect(containerAfter(bare, 'ProgramArguments', 'array'))
      .toEqual([`\t\t<string>${DARWIN.executable}</string>`])
    expect(bare).not.toContain('--start')
    expect(bare).not.toContain('--service')
  })

  it('runs from home, at load, and is restarted only after a failure', () => {
    expect(plistValueAfter(plist, 'WorkingDirectory')).toBe(`<string>${DARWIN.home}</string>`)
    expect(plistValueAfter(plist, 'RunAtLoad')).toBe('<true/>')
    expect(containerAfter(plist, 'KeepAlive', 'dict'))
      .toEqual(['\t\t<key>SuccessfulExit</key>', '\t\t<false/>'])
    expect(plistValueAfter(plist, 'ThrottleInterval')).toBe('<integer>5</integer>')
  })

  it('abandons the process group so a daemon restart does not kill the CLI processes', () => {
    expect(plistValueAfter(plist, 'AbandonProcessGroup')).toBe('<true/>')
    expect(plistValueAfter(plist, 'ExitTimeOut')).toBe('<integer>60</integer>')
  })

  it('declares exactly the four environment variables, in order', () => {
    expect(containerAfter(plist, 'EnvironmentVariables', 'dict')).toEqual([
      '\t\t<key>HOME</key>',
      `\t\t<string>${DARWIN.home}</string>`,
      '\t\t<key>PATH</key>',
      `\t\t<string>${DARWIN.path}</string>`,
      '\t\t<key>WALNUT_DAEMON_DIR</key>',
      '\t\t<string>/tmp/open-walnut</string>',
      '\t\t<key>WALNUT_DAEMON_STATE_DIR</key>',
      `\t\t<string>${DARWIN.stateDir}</string>`,
    ])
  })

  it('writes both logs into the state dir', () => {
    expect(plistValueAfter(plist, 'StandardOutPath'))
      .toBe(`<string>${path.join(DARWIN.stateDir, 'daemon-service.out.log')}</string>`)
    expect(plistValueAfter(plist, 'StandardErrorPath'))
      .toBe(`<string>${path.join(DARWIN.stateDir, 'daemon-service.err.log')}</string>`)
    expect(plistValueAfter(plist, 'StandardOutPath')).toContain(DARWIN.stateDir)
  })

  it('carries no credential-shaped material and claims nothing about booting', () => {
    expect(plist).not.toMatch(/token|secret|credential|password|bearer|api[_-]?key/i)
    expect(plist).not.toMatch(/AWS_|ANTHROPIC_/)
    expect(plist).not.toMatch(/boot/i)
  })

  it('escapes XML metacharacters instead of emitting them raw', () => {
    const nasty = renderDaemonLaunchAgent(darwin({
      home: '/Users/a&b',
      args: ['--note=<x>', '--quote="q"', "--tick='t'"],
      stateDir: '/Users/a&b/state',
    }))
    expect(plistValueAfter(nasty, 'WorkingDirectory')).toBe('<string>/Users/a&amp;b</string>')
    expect(containerAfter(nasty, 'ProgramArguments', 'array')).toEqual([
      `\t\t<string>${DARWIN.executable}</string>`,
      '\t\t<string>--note=&lt;x&gt;</string>',
      '\t\t<string>--quote=&quot;q&quot;</string>',
      '\t\t<string>--tick=&apos;t&apos;</string>',
    ])
    expect(nasty).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/)
    expect(nasty).not.toContain('<x>')
  })

  it('keeps spaces and non-ASCII characters verbatim', () => {
    const home = '/Users/\u7528\u6237 \u7a7a\u683c' // CJK "user" + "space"
    const out = renderDaemonLaunchAgent(darwin({ home, stateDir: `${home}/Library/Open Walnut` }))
    expect(plistValueAfter(out, 'WorkingDirectory')).toBe(`<string>${home}</string>`)
    expect(plistValueAfter(out, 'StandardErrorPath'))
      .toBe(`<string>${home}/Library/Open Walnut/daemon-service.err.log</string>`)
  })

  it('renders without a user, because an agent runs as whoever loads it', () => {
    const { user: _user, ...withoutUser } = darwin({ user: 'example' })
    const out = renderDaemonLaunchAgent(withoutUser as DaemonServiceConfig)
    expect(out).toBe(plist)
    expect(out).not.toContain('UserName')
  })

  it('still validates a user it will not use', () => {
    expect(() => renderDaemonLaunchAgent(darwin({ user: 'exam ple' }))).toThrow(/plain account name/)
  })

  it('refuses a config for the other platform', () => {
    expect(() => renderDaemonLaunchAgent(linux())).toThrow(/expected a darwin config/)
  })

  it('refuses NUL, newline, relative paths, and a bad PATH', () => {
    expect(() => renderDaemonLaunchAgent(darwin({ home: '/Users/a\u0000b' }))).toThrow(/control characters/)
    expect(() => renderDaemonLaunchAgent(darwin({ args: ['--a\n--b'] }))).toThrow(/control characters/)
    expect(() => renderDaemonLaunchAgent(darwin({ executable: 'Daemon/open-walnut-daemon' })))
      .toThrow(/absolute path/)
    expect(() => renderDaemonLaunchAgent(darwin({ stateDir: '/Users/example/../../etc' })))
      .toThrow(/".." segments/)
    expect(() => renderDaemonLaunchAgent(darwin({ path: 'bin:/usr/bin' }))).toThrow(/must be absolute/)
  })

  it('is deterministic and does not mutate the config it was given', () => {
    const config = darwin()
    const snapshot = structuredClone(config)
    expect(renderDaemonLaunchAgent(config)).toBe(renderDaemonLaunchAgent(config))
    expect(config).toEqual(snapshot)
  })
})

describe('the two renderers agree on the environment they hand the daemon', () => {
  it('names the same four variables with the same values on both platforms', () => {
    const unitEnv = linesOf(renderDaemonSystemdUnit(linux(), 'user'), 'Environment=')
      .map((line) => line.replace(/^Environment="/, '').replace(/"$/, ''))
    const plistEnv = containerAfter(renderDaemonLaunchAgent(darwin({
      home: LINUX.home,
      executable: LINUX.executable,
      stateDir: LINUX.stateDir,
      path: LINUX.path,
    })), 'EnvironmentVariables', 'dict')
    const pairs: string[] = []
    for (let i = 0; i < plistEnv.length; i += 2) {
      const key = plistEnv[i].trim().replace('<key>', '').replace('</key>', '')
      const value = plistEnv[i + 1].trim().replace('<string>', '').replace('</string>', '')
      pairs.push(`${key}=${value}`)
    }
    expect(pairs).toEqual(unitEnv)
    expect(pairs.map((pair) => pair.split('=')[0]))
      .toEqual(['HOME', 'PATH', 'WALNUT_DAEMON_DIR', 'WALNUT_DAEMON_STATE_DIR'])
  })
})
