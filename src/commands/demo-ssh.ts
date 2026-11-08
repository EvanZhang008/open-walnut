import fs from 'node:fs/promises'
import path from 'node:path'
import type { DemoPaths } from './demo-home.js'
import { DEMO_SSH_TRANSLATE_AWK } from './demo-ssh-home-config.js'
import { demoAgentSockFile, demoRealSshConfigFile, demoRealSshFlag, prepareDemoRealSsh } from './demo-real-ssh.js'

// OpenSSH finds ~/.ssh from the OS account, never from $HOME, so a Demo child with its own HOME
// would still read the person's real SSH config, keys and known hosts. Every ssh and scp the Demo
// runs goes through PATH, so the Demo puts wrappers first there that name its own settings. The
// Demo HOME config itself is read through a copy whose ~/ names the Demo HOME (demo-ssh-home-config.ts),
// written again on every run so an edit to it counts at once. Once the person chose "Use my SSH
// hosts" (demo-real-ssh.ts), the wrappers run with the account's own settings behind Walnut's
// overrides instead, and with the agent the launcher was started with.

const WRAPPED = ['ssh', 'scp'] as const

export function demoSshBinDir(paths: DemoPaths): string {
  return path.join(paths.data, 'local', 'demo-ssh', 'bin')
}

export function demoSshConfigFile(paths: DemoPaths): string {
  return path.join(paths.data, 'local', 'demo-ssh', 'ssh_config')
}

/** The Demo HOME config as the wrapper last wrote it, with its ~/ naming the Demo HOME. */
export function demoSshHomeConfigFile(paths: DemoPaths): string {
  return path.join(paths.data, 'local', 'demo-ssh', 'home_config')
}

export function demoSshConfig(sshHome: string, homeConfig: string): string {
  const q = (value: string) => `"${value}"`
  return [
    '# Walnut Demo: the Demo HOME\'s own SSH settings (OpenSSH would read the account\'s ~/.ssh otherwise).',
    `Include ${q(homeConfig)}`,
    // The Demo HOME's default keys come with that copy (demo-ssh-home-config.ts), only the ones that exist.
    'Host *',
    `  UserKnownHostsFile ${q(path.join(sshHome, 'known_hosts'))}`,
    '  IdentityAgent none',
    '',
  ].join('\n')
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

async function findOnPath(name: string, searchPath: string, skip: string): Promise<string | null> {
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir) || path.resolve(dir) === skip) continue
    const file = path.join(dir, name)
    try {
      await fs.access(file, fs.constants.X_OK)
      if ((await fs.stat(file)).isFile()) return file
    } catch { /* not here */ }
  }
  return null
}

export async function prepareDemoSsh(paths: DemoPaths, searchPath = process.env.PATH ?? '', agentSock = process.env.SSH_AUTH_SOCK): Promise<void> {
  if (process.platform === 'win32') return
  for (const value of [paths.home, paths.data]) {
    if (/["\\\n\r]/.test(value)) throw new Error('The Demo directory cannot hold its own SSH settings; choose a plain path')
  }
  const bin = demoSshBinDir(paths)
  const sshHome = path.join(paths.home, '.ssh')
  await fs.mkdir(bin, { recursive: true, mode: 0o700 })
  await fs.mkdir(sshHome, { recursive: true, mode: 0o700 })
  const config = demoSshConfigFile(paths)
  const homeConfig = demoSshHomeConfigFile(paths)
  const dir = path.dirname(config)
  const program = path.join(dir, 'translate.awk')
  const copies = path.join(dir, 'included')
  await fs.mkdir(copies, { recursive: true, mode: 0o700 })
  await fs.writeFile(program, DEMO_SSH_TRANSLATE_AWK, { mode: 0o600 })
  await fs.writeFile(homeConfig, '', { flag: 'a', mode: 0o600 })
  await fs.writeFile(config, demoSshConfig(sshHome, homeConfig), { mode: 0o600 })
  await prepareDemoRealSsh(paths, undefined, agentSock)
  const awk = await findOnPath('awk', `/usr/bin${path.delimiter}/bin${path.delimiter}${searchPath}`, path.resolve(bin))
  for (const name of WRAPPED) {
    const wrapper = path.join(bin, name)
    const real = await findOnPath(name, searchPath, path.resolve(bin))
    if (!real || !awk) { await fs.rm(wrapper, { force: true }); continue }
    await fs.writeFile(wrapper, demoSshWrapper({
      real, awk, config, homeConfig, program, copies, home: paths.home, sshHome,
      realFlag: demoRealSshFlag(paths), realConfig: demoRealSshConfigFile(paths), agentSock: demoAgentSockFile(paths),
    }), { mode: 0o700 })
    await fs.chmod(wrapper, 0o700)
  }
  if (!awk) throw new Error('The Demo cannot hold its own SSH settings without awk on this computer')
  // A login shell (the daemon's PATH, a terminal) puts the system dirs first again (macOS
  // path_helper), so the Demo HOME's own profiles put the wrappers back in front. A profile the
  // person already edited in this generation is kept.
  for (const profile of DEMO_PROFILES) {
    try {
      await fs.writeFile(path.join(paths.home, profile), demoProfileLine(bin), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
}

interface WrapperParts {
  real: string; awk: string; config: string; homeConfig: string; program: string; copies: string; home: string; sshHome: string
  /** "Use my SSH hosts" (demo-real-ssh.ts): the flag, the settings it names, the launcher's agent socket file. */
  realFlag: string; realConfig: string; agentSock: string
}

/**
 * One ssh or scp run. Once the generation reads the account's ~/.ssh (demo-real-ssh.ts): the real tool with the account's
 * settings behind Walnut's overrides, and the launcher's agent (none when it had none). Otherwise,
 * as always: the Demo HOME config is written again (a refused write runs nothing), then the real
 * tool with the Demo's settings.
 */
export function demoSshWrapper(w: WrapperParts): string {
  const q = shellQuote
  const tmp = `${q(w.homeConfig)}.$$`
  return [
    '#!/bin/sh',
    `if [ -f ${q(w.realFlag)} ]; then`,
    `  SSH_AUTH_SOCK=$(cat ${q(w.agentSock)} 2>/dev/null) && [ -n "$SSH_AUTH_SOCK" ] && export SSH_AUTH_SOCK || unset SSH_AUTH_SOCK`,
    `  exec ${q(w.real)} -F ${q(w.realConfig)} "$@"`,
    'fi',
    `${q(w.awk)} -v home=${q(w.home)} -v sshhome=${q(w.sshHome)} -v out=${q(w.copies)} -v run="$$" -f ${q(w.program)} > ${tmp} && mv -f ${tmp} ${q(w.homeConfig)} || {`,
    `  rm -f ${tmp}; echo 'Walnut Demo: could not read its own SSH settings' >&2; exit 255`,
    '}',
    `exec ${q(w.real)} -F ${q(w.config)} "$@"`,
    '',
  ].join('\n')
}

export const DEMO_PROFILES = ['.zprofile', '.bash_profile', '.profile'] as const

export function demoProfileLine(bin: string): string {
  return `# Walnut Demo: its own ssh and scp come first (OpenSSH would read the account's ~/.ssh).\nexport PATH=${shellQuote(bin)}:"$PATH"\n`
}

export function demoSearchPath(paths: DemoPaths, parentPath: string | undefined): string | undefined {
  if (process.platform === 'win32') return parentPath
  return parentPath ? `${demoSshBinDir(paths)}${path.delimiter}${parentPath}` : demoSshBinDir(paths)
}
