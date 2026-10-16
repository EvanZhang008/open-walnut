/**
 * The cloud replica's own copy of a file in the PRIMARY's Walnut data dir.
 *
 * The primary's `~/.open-walnut` is git-synced to the replica's WALNUT_HOME, so
 * a path like `/Users/<me>/.open-walnut/notes/x/_attachment/a.pdf` exists here
 * as `<WALNUT_HOME>/notes/x/_attachment/a.pdf`. The file-content relay asks the
 * primary first (its copy is the freshest); this copy answers when the primary
 * cannot (asleep, offline, an old daemon) or will not send the bytes over the
 * bridge (over the 2 MB relay cap). A primary that answers "not there" or
 * "refused" stays the authority: this module is never consulted for those.
 * Only files git tracks in the data repo count as the primary's copy.
 */

import path from 'node:path'
import fsp from 'node:fs/promises'
import { WALNUT_HOME } from '../../constants.js'
import { isSecretPath } from './file-content.js'

/** The data dir's name, directly under a home dir. */
const DATA_DIR_NAME = '.open-walnut'

/** Index of the data dir segment when it sits right under a home dir
 *  (`~/`, `/Users/<u>/`, `/home/<u>/`, `/root/`), else -1: a test or
 *  ephemeral server's temp data dir is not the primary's. */
function dataDirIndex(parts: string[], tilde: boolean): number {
  if (tilde) return parts[1] === DATA_DIR_NAME ? 1 : -1
  if ((parts[0] === 'Users' || parts[0] === 'home') && parts[2] === DATA_DIR_NAME) return 2
  if (parts[0] === 'root' && parts[1] === DATA_DIR_NAME) return 1
  return -1
}

// Same refusals the daemon's bounded read applies host-side, so the copy never
// serves what the primary itself would refuse.
const DENIED_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.git', 'walnut-secrets'])
const DENIED_BASENAMES = new Set([
  '.netrc', '.npmrc', '.git-credentials', 'credentials', 'auth.json', 'bridge-tokens.json',
])
const DENIED_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'ppk', 'jks', 'keystore'])

function deniedName(rel: string): boolean {
  const parts = rel.split('/')
  if (parts.some((p) => DENIED_SEGMENTS.has(p))) return true
  const base = parts[parts.length - 1] ?? ''
  if (DENIED_BASENAMES.has(base)) return true
  if (base === '.env' || base.startsWith('.env.')) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true
  if (/^config\.ya?ml$/.test(base)) return true
  return DENIED_EXTENSIONS.has(base.slice(base.lastIndexOf('.') + 1).toLowerCase())
}

/** The path inside the data dir (`notes/a.pdf`) for a primary path, or null. */
export function primaryDataDirRelPath(requestPath: string): string | null {
  if (requestPath.includes('..') || requestPath.includes('\0')) return null
  const tilde = requestPath === '~' || requestPath.startsWith('~/')
  if (!tilde && !requestPath.startsWith('/')) return null
  const parts = requestPath.split('/').filter((p) => p.length > 0 && p !== '.')
  const idx = dataDirIndex(parts, tilde)
  if (idx < 0 || idx === parts.length - 1) return null
  return parts.slice(idx + 1).join('/')
}

/** A regular file of this replica's synced copy, or null. Never throws. */
export async function resolveReplicaCopy(requestPath: string): Promise<{ localPath: string; size: number } | null> {
  const rel = primaryDataDirRelPath(requestPath)
  if (rel === null || deniedName(rel)) return null
  try {
    const root = await fsp.realpath(WALNUT_HOME)
    const real = await fsp.realpath(path.join(WALNUT_HOME, rel))
    // A symlink in the copy must not lead out of the data dir.
    if (!real.startsWith(root + path.sep)) return null
    // Judge secrets by the place INSIDE the data dir: a realpath'd root
    // (/var → /private/var) no longer shares a prefix with WALNUT_HOME.
    const realRel = path.relative(root, real).split(path.sep).join('/')
    if (isSecretPath(path.join(WALNUT_HOME, realRel)) || deniedName(realRel)) return null
    const st = await fsp.stat(real)
    if (!st.isFile()) return null
    // Only what git-sync brought over is the primary's file. This box also
    // keeps its own untracked files here (auth.json.bak, config backups,
    // plugin data), which no name rule can be trusted to catch.
    if (!(await isTracked(root, realRel))) return null
    return { localPath: real, size: st.size }
  } catch {
    return null
  }
}

async function isTracked(repoRoot: string, rel: string): Promise<boolean> {
  const { execGitArgsGroup } = await import('../../integrations/git-sync.js')
  try {
    await execGitArgsGroup(['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', rel], { cwd: repoRoot, timeout: 5_000 })
    return true
  } catch {
    return false
  }
}
