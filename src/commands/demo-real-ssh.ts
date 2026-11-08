/**
 * Walnut Demo reads the person's real ~/.ssh/config (the OS account's home) and connects with their
 * own keys and agent, so the hosts they already have are listed on the first run.
 *
 * The Demo HOME has SSH settings of its own (demo-ssh.ts). At start (startDemoRealSsh, called by
 * demo-server.ts) a generation whose account has a ~/.ssh/config writes a flag file in its data
 * dir; from then on:
 *   - the ssh and scp wrappers run with `real_config` (written here at prepare time): Walnut's own
 *     overrides first, then the account's ~/.ssh/config. OpenSSH keeps the first value of an
 *     option, so the overrides hold: new host keys go to the Demo HOME's known_hosts (the
 *     account's is only read), no agent or X11 forwarding, no ControlMaster socket of the person's
 *     config, no host key rotation written into the account's known_hosts;
 *   - the server's scanner and credential checks read the account's ~/.ssh (lib/ssh-home.ts);
 *   - ssh is given the agent socket the launcher was started with (captured at prepare time).
 *
 * Nothing here reads a key's contents or writes into the account's ~/.ssh. One limit: a
 * ProxyCommand or LocalCommand of the person's own config runs as they wrote it, and an inner
 * `ssh` it starts reads their plain config without these overrides, so it may write their
 * known_hosts or a ControlMaster socket as it does outside the Demo. The flag file is not a
 * security boundary either: a process of the same user in the Demo could create it. Every file
 * route of a Demo server refuses the person's ~/.ssh, flag or not (web/routes/file-content.ts).
 * No host is dialled by reading the config: each found host still waits for its own Add/Connect.
 * Walnut's data and daemon dirs, here and on every remote host (remote-isolation.ts with demo),
 * stay the Demo's. A reset starts a new data dir, and that generation's start reads the config again.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { accountInfo } from '../lib/account.js'
import { setAccountSsh } from '../lib/ssh-home.js'
import type { DemoPaths } from './demo-home.js'

function demoSshDir(paths: DemoPaths): string {
  return path.join(paths.data, 'local', 'demo-ssh')
}

/** The flag: present once the person chose "Use my SSH hosts" in this generation. */
export function demoRealSshFlag(paths: DemoPaths): string {
  return path.join(demoSshDir(paths), 'use-real-ssh')
}

/** The settings the wrappers name once the flag is set. */
export function demoRealSshConfigFile(paths: DemoPaths): string {
  return path.join(demoSshDir(paths), 'real_config')
}

/** The agent socket the launcher was started with (a path, never a key), read only once the flag is set. */
export function demoAgentSockFile(paths: DemoPaths): string {
  return path.join(demoSshDir(paths), 'agent_sock')
}

const PLAIN = /^[^"\\\n\r]+$/

/**
 * Walnut's overrides FIRST (options before any Host line apply to every host, and OpenSSH keeps
 * the first value it reads), then the account's own settings. No `~` translation: OpenSSH reads
 * `~` and `%d` from the OS account, which is the home these settings belong to.
 */
export function demoRealSshConfig(demoSshHome: string, realHome: string): string {
  const q = (value: string) => `"${value}"`
  return [
    '# Walnut Demo, "Use my SSH hosts": your own SSH settings with Walnut\'s overrides first.',
    `UserKnownHostsFile ${q(path.join(demoSshHome, 'known_hosts'))} ${q(path.join(realHome, '.ssh', 'known_hosts'))}`,
    'UpdateHostKeys no',
    'ForwardAgent no',
    'ForwardX11 no',
    'ControlPath none',
    `Include ${q(path.join(realHome, '.ssh', 'config'))}`,
    'Include /etc/ssh/ssh_config',
    '',
  ].join('\n')
}

/**
 * Write `real_config` and the launcher's agent socket path. Runs in the launcher (the person's own
 * environment) every time the Demo starts; nothing is used until the flag is set.
 */
export async function prepareDemoRealSsh(
  paths: DemoPaths,
  realHome: string = accountInfo().homedir,
  agentSock: string | undefined = process.env.SSH_AUTH_SOCK,
): Promise<void> {
  const config = demoRealSshConfigFile(paths)
  const sock = demoAgentSockFile(paths)
  await fs.mkdir(path.dirname(config), { recursive: true, mode: 0o700 })
  if (path.isAbsolute(realHome) && PLAIN.test(realHome) && path.resolve(realHome) !== path.resolve(paths.home)) {
    await fs.writeFile(config, demoRealSshConfig(path.join(paths.home, '.ssh'), path.resolve(realHome)), { mode: 0o600 })
  } else {
    await fs.rm(config, { force: true })
  }
  if (agentSock && path.isAbsolute(agentSock) && PLAIN.test(agentSock)) await fs.writeFile(sock, agentSock, { mode: 0o600 })
  else await fs.rm(sock, { force: true })
}

const exists = (file: string) => fs.access(file).then(() => true, () => false)

/** Has the person chosen "Use my SSH hosts" in this generation? */
export function demoRealSshOn(paths: DemoPaths): Promise<boolean> {
  return exists(demoRealSshFlag(paths))
}

/** Can the opt-in work here: its settings were prepared and the account has a ~/.ssh/config. */
export async function demoRealSshAvailable(paths: DemoPaths, realHome: string = accountInfo().homedir): Promise<boolean> {
  return await exists(demoRealSshConfigFile(paths)) && await exists(path.join(realHome, '.ssh', 'config'))
}

async function readAgentSock(paths: DemoPaths): Promise<string | undefined> {
  const value = (await fs.readFile(demoAgentSockFile(paths), 'utf8').catch(() => '')).trim()
  return value && path.isAbsolute(value) && PLAIN.test(value) ? value : undefined
}

/** At server start and after the opt-in: point this process's ~/.ssh reads at the account when the flag is set. */
export async function applyDemoRealSsh(paths: DemoPaths, realHome: string = accountInfo().homedir): Promise<boolean> {
  if (!await demoRealSshOn(paths)) { setAccountSsh(null); return false }
  setAccountSsh({ home: path.resolve(realHome), agentSock: await readAgentSock(paths) })
  return true
}

/**
 * At Demo start: every generation reads the account's ~/.ssh/config on its own, so its hosts are
 * listed at once with no click (2026-11-12, the user: "the detection is automatic, no need a click").
 * Sets the flag when the account has a config, then applies it. Still nothing is dialled: each
 * found host waits for its own Add.
 */
export async function startDemoRealSsh(paths: DemoPaths, realHome: string = accountInfo().homedir): Promise<boolean> {
  if (!await demoRealSshOn(paths) && await demoRealSshAvailable(paths, realHome)) {
    await fs.writeFile(demoRealSshFlag(paths), `${new Date().toISOString()}\n`, { mode: 0o600 })
  }
  return applyDemoRealSsh(paths, realHome)
}

/** POST /api/demo/ssh-hosts (an older Demo page's button): set the flag (0600), then use the account's ~/.ssh in this process. */
export async function enableDemoRealSsh(paths: DemoPaths, realHome: string = accountInfo().homedir): Promise<void> {
  if (!await demoRealSshAvailable(paths, realHome)) {
    throw new Error('Walnut Demo found no ~/.ssh/config in your account to read.')
  }
  await fs.writeFile(demoRealSshFlag(paths), `${new Date().toISOString()}\n`, { mode: 0o600 })
  await applyDemoRealSsh(paths, realHome)
}
