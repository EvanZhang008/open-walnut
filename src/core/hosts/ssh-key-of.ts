/**
 * The SSH key this machine's ssh would sign in to a host with, read from ssh's own answer
 * (`ssh -G <alias>`: the config as ssh resolves it, Include and Match included), never from a
 * parse of our own. First-run setup's walkthrough names it in its commands (ssh-copy-id -i,
 * ssh-add, cat ...pub), so a host whose Host block names its own IdentityFile gets that key, not
 * the default one (2026-11-11 review: `ssh-copy-id lab-mac` copied a key the host never offers).
 *
 * Async with a deadline (a route calls it); any failure answers null and the walkthrough keeps
 * its default commands.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface SshKeyOf {
  /** The key file as ssh names it, `~/` for the home directory. */
  path: string
  /** The private key file exists. */
  exists: boolean
}

const TIMEOUT_MS = 3_000

export function identityFilesOf(sshG: string): string[] {
  return sshG.split('\n')
    .map((l) => /^identityfile\s+(.+)$/i.exec(l.trim())?.[1]?.trim())
    .filter((p): p is string => !!p && p.toLowerCase() !== 'none')
}

export function tildePath(file: string, home = os.homedir()): string {
  return file === home ? '~' : file.startsWith(home + path.sep) ? `~/${file.slice(home.length + 1)}` : file
}

function expand(file: string, home = os.homedir()): string {
  return file.startsWith('~/') ? path.join(home, file.slice(2)) : file
}

/** The first key ssh would offer that exists, else the first one it names (to be made). */
export async function sshKeyOf(alias: string): Promise<SshKeyOf | null> {
  if (!/^[A-Za-z0-9._@-]+$/.test(alias)) return null
  const out = await new Promise<string | null>((resolve) => {
    execFile('ssh', ['-G', alias], { encoding: 'utf-8', timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
  })
  if (!out) return null
  const files = identityFilesOf(out).map((f) => expand(f))
  if (files.length === 0) return null
  for (const f of files) {
    if (await fs.access(f).then(() => true, () => false)) return { path: tildePath(f), exists: true }
  }
  // None exists: the ed25519 default if ssh offers it (what ssh-keygen -t ed25519 makes), else the first.
  const made = files.find((f) => f.endsWith(`${path.sep}id_ed25519`)) ?? files[0]
  return { path: tildePath(made), exists: false }
}
