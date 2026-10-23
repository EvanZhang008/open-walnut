/**
 * The Mac's SSH for one fleet run: a throwaway key pair, an ssh config of its own,
 * and an `ssh` first on the Mac's PATH that always runs with that config.
 *
 * OpenSSH reads ~/.ssh from the passwd home, not $HOME, so a throwaway HOME alone
 * would still read the user's real config, keys and known_hosts. `-F <config>`
 * replaces the user AND the system config, and the config names everything else:
 * the key (IdentitiesOnly, no agent), a known_hosts file of this run's. So the
 * user's real ~/.ssh is never read or written, and nothing but this run's hosts
 * can be reached under their names.
 *
 * Each host is a Host block (its Walnut key is its ssh alias) pointing at
 * 127.0.0.1 and the port of the fault proxy in front of its container's sshd.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const FLEET_USER = 'walnut'

export interface SshIdentity {
  dir: string
  config: string
  key: string
  publicKey: string
  /** The bin dir whose `ssh` runs with this config (first on the Mac's PATH). */
  bin: string
  /** The real ssh binary the wrapper execs: what every ssh process of this run runs. */
  realSsh: string
  /** The command line every ssh process of this run starts with. */
  commandPrefix: string
  /** Rewrites the config with these hosts (alias to local port). */
  writeHosts(hosts: Record<string, number>): void
}

function findRealSsh(): string {
  for (const p of ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']) if (fs.existsSync(p)) return p
  throw new Error('fleet: no ssh binary in /usr/bin, /usr/local/bin or /opt/homebrew/bin')
}

export function makeSshIdentity(base: string): SshIdentity {
  const dir = path.join(base, 'ssh')
  const bin = path.join(base, 'bin')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 })
  const key = path.join(dir, 'id_ed25519')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'walnut-fleet', '-f', key], { stdio: 'ignore' })
  const publicKey = fs.readFileSync(`${key}.pub`, 'utf8').trim()
  const config = path.join(dir, 'config')
  const realSsh = findRealSsh()
  const knownHosts = path.join(dir, 'known_hosts')
  const writeHosts = (hosts: Record<string, number>) => {
    const blocks = Object.entries(hosts).map(([alias, port]) => [
      `Host ${alias}`, '  HostName 127.0.0.1', `  Port ${port}`, `  User ${FLEET_USER}`, '',
    ].join('\n'))
    fs.writeFileSync(config, [
      ...blocks,
      'Host *',
      `  IdentityFile ${key}`,
      '  IdentitiesOnly yes',
      '  IdentityAgent none',
      '  PasswordAuthentication no',
      '  KbdInteractiveAuthentication no',
      `  UserKnownHostsFile ${knownHosts}`,
      '  GlobalKnownHostsFile /dev/null',
      '  StrictHostKeyChecking no',
      '  ConnectTimeout 10',
      '  LogLevel ERROR',
      '',
    ].join('\n'), { mode: 0o600 })
  }
  writeHosts({})
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec ${q(realSsh)} -F ${q(config)} "$@"\n`, { mode: 0o755 })
  // Nothing in Walnut copies files with these, and nothing here may reach a real host.
  for (const name of ['scp', 'sftp']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} is disabled in the fleet" >&2\nexit 255\n`, { mode: 0o755 })
  return { dir, config, key, publicKey, bin, realSsh, commandPrefix: `${realSsh} -F ${config} `, writeHosts }
}
