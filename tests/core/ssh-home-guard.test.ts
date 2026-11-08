/**
 * Every read of ~/.ssh goes through ONE helper (src/lib/ssh-home.ts).
 *
 * Walnut Demo runs under a HOME of its own and, after "Use my SSH hosts", reads the account's
 * ~/.ssh instead (src/commands/demo-real-ssh.ts). A place that builds its ~/.ssh from
 * os.homedir() or $HOME by itself keeps reading the other one: the scanner would list the Demo's
 * hosts while ssh connects with the account's, a credential check would ask the wrong agent, and a
 * secrets denylist would let the account's keys through the file routes.
 *
 * Enumerated from the source: (1) no code line builds a `.ssh` path from os.homedir() or $HOME;
 * (2) a file that reads ssh's own settings or keys (a `, '.ssh'` path, `ssh -G`, `ssh-add`) takes
 * no home of its own at all. Only the helper itself may.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '../..')
const SRC = path.join(ROOT, 'src')
const HELPER = 'src/lib/ssh-home.ts'

/** Files allowed a home of their own beside an ssh read, with why. */
const OWN_HOME_ALLOWED: Record<string, string> = {
  [HELPER]: 'the helper: $HOME, else os.homedir(), unless the account is in use',
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) sources(p, out)
    else if (/\.(ts|mts|cts)$/.test(entry.name) && !/\.test\./.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Code without comments (block comments keep their line breaks, so line numbers hold). */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n')
}

const HOME = /\bos\.homedir\(\)|\bhomedir\(\)|\benv\.HOME\b/
const SSH_PATH = /['"`]\.ssh['"`/]|\/\.ssh\b/
const SSH_READER = /,\s*['"]\.ssh['"]|['"]ssh-add['"]|\[\s*['"]-G['"]/

const files = sources(SRC).map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), text: code(f) }))

describe('~/.ssh is read through src/lib/ssh-home.ts', () => {
  it('finds the ssh readers it guards (the scan still sees them)', () => {
    const readers = files.filter((f) => SSH_READER.test(f.text) || f.rel === 'src/core/ssh-config-scanner.ts').map((f) => f.rel)
    for (const known of [
      'src/core/ssh-config-scanner.ts', 'src/core/hosts/ssh-key-of.ts', 'src/core/hosts/host-credential-signal.ts',
      'src/providers/ssh-credential-evidence.ts',
    ]) expect(readers, known).toContain(known)
    for (const user of ['src/core/ssh-config-scanner.ts', 'src/core/hosts/ssh-key-of.ts', 'src/core/hosts/host-credential-signal.ts',
      'src/providers/ssh-credential-evidence.ts', 'src/web/routes/file-content.ts', 'src/web/routes/files.ts']) {
      expect(files.find((f) => f.rel === user)?.text, user).toMatch(/lib\/ssh-home\.js/)
    }
  })

  it('no code line builds a .ssh path from os.homedir() or $HOME', () => {
    const hits: string[] = []
    for (const f of files) {
      if (OWN_HOME_ALLOWED[f.rel]) continue
      f.text.split('\n').forEach((line, i) => {
        if (HOME.test(line) && SSH_PATH.test(line)) hits.push(`${f.rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits, 'use sshDir()/sshDirs()/sshHome() from src/lib/ssh-home.ts').toEqual([])
  })

  it('a file that reads ssh settings or keys takes no home of its own', () => {
    const hits = files
      .filter((f) => !OWN_HOME_ALLOWED[f.rel] && (SSH_READER.test(f.text) || f.rel === 'src/core/ssh-config-scanner.ts') && HOME.test(f.text))
      .map((f) => f.rel)
    expect(hits, 'take the home from src/lib/ssh-home.ts (sshHome), or list the file in OWN_HOME_ALLOWED with why').toEqual([])
  })

  it('every allowance still exists', () => {
    for (const rel of Object.keys(OWN_HOME_ALLOWED)) expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true)
  })
})
