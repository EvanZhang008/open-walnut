import path from 'node:path'

export type DaemonServicePlatform = 'linux' | 'darwin'

export interface DaemonServiceConfig {
  platform: DaemonServicePlatform
  home: string
  executable: string
  args: string[]
  runtimeDir: string
  stateDir: string
  path: string
  user?: string
}

export const DAEMON_SERVICE_LABEL = 'dev.openwalnut.session-daemon'
export const DAEMON_SERVICE_UNIT_NAME = 'open-walnut-daemon.service'
export const DAEMON_SERVICE_PLIST_NAME = `${DAEMON_SERVICE_LABEL}.plist`

const STDOUT_LOG_NAME = 'daemon-service.out.log'
const STDERR_LOG_NAME = 'daemon-service.err.log'

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/
const USER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

interface CheckedConfig {
  home: string
  executable: string
  args: string[]
  runtimeDir: string
  stateDir: string
  path: string
  user?: string
}

function fail(message: string): never {
  throw new Error(`daemon service config: ${message}`)
}

function checkText(label: string, value: unknown): string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  const text = value as string
  if (text.length === 0) fail(`${label} must not be empty`)
  if (CONTROL_CHAR.test(text)) fail(`${label} must not contain control characters (NUL, newline, tab)`)
  return text
}

function checkAbsolutePath(label: string, value: unknown): string {
  const text = checkText(label, value)
  if (!text.startsWith('/')) fail(`${label} must be an absolute path, got ${JSON.stringify(text)}`)
  if (text !== text.trim()) fail(`${label} must not have leading or trailing whitespace`)
  for (const segment of text.split('/')) {
    if (segment === '.' || segment === '..') fail(`${label} must not contain "." or ".." segments`)
  }
  return text
}

function checkSearchPath(label: string, value: unknown): string {
  const text = checkText(label, value)
  for (const entry of text.split(':')) {
    if (entry.length === 0) fail(`${label} must not contain an empty entry`)
    if (!entry.startsWith('/')) fail(`${label} entries must be absolute, got ${JSON.stringify(entry)}`)
    if (entry !== entry.trim()) fail(`${label} entries must not have leading or trailing whitespace`)
  }
  return text
}

function checkUser(value: unknown): string {
  const text = checkText('user', value)
  if (!USER_NAME.test(text)) fail(`user must be a plain account name or uid, got ${JSON.stringify(text)}`)
  return text
}

function checkPlatform(value: unknown): DaemonServicePlatform {
  if (value !== 'linux' && value !== 'darwin') fail(`unsupported platform ${JSON.stringify(value)}`)
  return value as DaemonServicePlatform
}

function checkConfig(config: DaemonServiceConfig, expected: DaemonServicePlatform): CheckedConfig {
  if (config === null || typeof config !== 'object') fail('config must be an object')
  if (checkPlatform(config.platform) !== expected) {
    fail(`expected a ${expected} config, got ${JSON.stringify(config.platform)}`)
  }
  if (!Array.isArray(config.args)) fail('args must be an array')
  return {
    home: checkAbsolutePath('home', config.home),
    executable: checkAbsolutePath('executable', config.executable),
    args: config.args.map((arg, i) => checkText(`args[${i}]`, arg)),
    runtimeDir: checkAbsolutePath('runtimeDir', config.runtimeDir),
    stateDir: checkAbsolutePath('stateDir', config.stateDir),
    path: checkSearchPath('path', config.path),
    user: config.user === undefined ? undefined : checkUser(config.user),
  }
}

function serviceEnv(config: CheckedConfig): [string, string][] {
  return [
    ['HOME', config.home],
    ['PATH', config.path],
    ['WALNUT_DAEMON_DIR', config.runtimeDir],
    ['WALNUT_DAEMON_STATE_DIR', config.stateDir],
  ]
}

export function daemonInstallRoot(platform: DaemonServicePlatform, home: string): string {
  const base = checkAbsolutePath('home', home)
  switch (checkPlatform(platform)) {
    case 'linux':
      return path.join(base, '.local', 'share', 'open-walnut', 'daemon')
    case 'darwin':
      return path.join(base, 'Library', 'Application Support', 'Open Walnut', 'Daemon')
  }
}

// Environment does not expand $, ExecStart does; both expand %.
function systemdQuoted(value: string, expandsDollar: boolean): string {
  let out = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
  if (expandsDollar) out = out.replace(/\$/g, '$$$$')
  return `"${out}"`
}

// WorkingDirectory neither strips quotes nor handles backslash escapes.
function systemdPathValue(value: string): string {
  return value.replace(/%/g, '%%')
}

export function renderDaemonSystemdUnit(
  config: DaemonServiceConfig,
  scope: 'user' | 'system',
): string {
  if (scope !== 'user' && scope !== 'system') fail(`unknown systemd scope ${JSON.stringify(scope)}`)
  const checked = checkConfig(config, 'linux')
  if (scope === 'system' && !checked.user) {
    fail('a system-scope unit needs config.user so the daemon keeps running as the original user')
  }

  const lines: string[] = ['[Unit]', 'Description=Open Walnut session daemon']
  if (scope === 'system') lines.push('After=network.target')
  lines.push('StartLimitIntervalSec=60', 'StartLimitBurst=5', '')

  lines.push('[Service]', 'Type=simple')
  if (scope === 'system') lines.push(`User=${checked.user}`)
  lines.push(
    `WorkingDirectory=${systemdPathValue(checked.home)}`,
    `ExecStart=${[checked.executable, ...checked.args].map((word) => systemdQuoted(word, true)).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=5',
    'KillMode=process',
    'TimeoutStopSec=60',
    'UMask=0077',
  )
  for (const [key, value] of serviceEnv(checked)) {
    lines.push(`Environment=${systemdQuoted(`${key}=${value}`, false)}`)
  }

  lines.push('', '[Install]', `WantedBy=${scope === 'system' ? 'multi-user.target' : 'default.target'}`, '')
  return lines.join('\n')
}

function xmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function serviceExecutableMatch(platform: DaemonServicePlatform, text: string): RegExpMatchArray {
  const pattern = platform === 'linux'
    ? /^ExecStart=("(?:\\.|[^"\\\n])*") "--service"$/gm
    : /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>--service<\/string>\s*<\/array>/g
  const matches = [...text.matchAll(pattern)]
  if (matches.length !== 1) throw new Error('Service executable configuration is not recognized; use an explicit installation')
  return matches[0]
}

export function readDaemonServiceExecutable(platform: DaemonServicePlatform, text: string): string {
  const encoded = serviceExecutableMatch(platform, text)[1]
  const decoded = platform === 'linux'
    ? encoded.slice(1, -1).replace(/\\([\\"])|%%|\$\$/g, (match, escaped) => escaped ?? match[0])
    : encoded.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!)
  if ((platform === 'linux' ? systemdQuoted(decoded, true) : xmlText(decoded)) !== encoded) {
    throw new Error('Service executable encoding is not recognized')
  }
  return checkAbsolutePath('executable', decoded)
}

export function replaceDaemonServiceExecutable(platform: DaemonServicePlatform, text: string, executable: string): string {
  checkAbsolutePath('executable', executable)
  readDaemonServiceExecutable(platform, text)
  const match = serviceExecutableMatch(platform, text)
  const encoded = platform === 'linux' ? systemdQuoted(executable, true) : xmlText(executable)
  const updated = match[0].replace(match[1], () => encoded)
  return text.slice(0, match.index!) + updated + text.slice(match.index! + match[0].length)
}

export function renderDaemonLaunchAgent(config: DaemonServiceConfig): string {
  const checked = checkConfig(config, 'darwin')

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${xmlText(DAEMON_SERVICE_LABEL)}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
  ]
  for (const word of [checked.executable, ...checked.args]) {
    lines.push(`\t\t<string>${xmlText(word)}</string>`)
  }
  lines.push(
    '\t</array>',
    '\t<key>WorkingDirectory</key>',
    `\t<string>${xmlText(checked.home)}</string>`,
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<dict>',
    '\t\t<key>SuccessfulExit</key>',
    '\t\t<false/>',
    '\t</dict>',
    '\t<key>ThrottleInterval</key>',
    '\t<integer>5</integer>',
    '\t<key>ExitTimeOut</key>',
    '\t<integer>60</integer>',
    '\t<key>AbandonProcessGroup</key>',
    '\t<true/>',
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
  )
  for (const [key, value] of serviceEnv(checked)) {
    lines.push(`\t\t<key>${xmlText(key)}</key>`, `\t\t<string>${xmlText(value)}</string>`)
  }
  lines.push(
    '\t</dict>',
    '\t<key>StandardOutPath</key>',
    `\t<string>${xmlText(path.join(checked.stateDir, STDOUT_LOG_NAME))}</string>`,
    '\t<key>StandardErrorPath</key>',
    `\t<string>${xmlText(path.join(checked.stateDir, STDERR_LOG_NAME))}</string>`,
    '</dict>',
    '</plist>',
    '',
  )
  return lines.join('\n')
}
