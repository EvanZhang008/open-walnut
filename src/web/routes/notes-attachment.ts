/**
 * Notes attachment path resolution — turns an Obsidian `![[...]]` inner path
 * into an absolute file under NOTES_DIR for the `/api/notes-v2/attachment`
 * route (defined in notes-v2.ts) to stream.
 *
 * Why a notes-owned endpoint (not /api/local-image): local-image.ts is owned by
 * another session and only allows png/jpg/jpeg/gif/webp (no PDF). The notes
 * attachment route serves ONE contract for all attachment types so the editor's
 * embed node never has to branch on file type or know where files physically
 * live — it just sends the raw `![[...]]` inner text.
 *
 * Resolution mirrors Obsidian's three embed forms:
 *   1. Bare shortest-unique name  `![[Foo.png]]`            → search the vault for
 *      a file whose basename matches (files inside an `_attachment/` folder win).
 *   2. Vault-relative path        `![[Areas/x/_attachment/Foo.png]]` → resolve
 *      directly under NOTES_DIR.
 *   3. Legacy Obsidian-root path  `![[Notion/Areas/.../Foo.png]]` → strip the
 *      leading `Notion/` segment (the old vault root that no longer exists on
 *      disk) then resolve as vault-relative (falling back to a basename search).
 *
 * Security: a resolved file MUST stay strictly inside NOTES_DIR (no `..`
 * escape); only an existing regular file is returned. The route applies the
 * extension allowlist + size cap on top.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { NOTES_DIR } from '../../constants.js'

// The attachment-type allowlist lives in notes-v2.ts (ATTACHMENT_EXTS) —
// single source of truth; this module only resolves paths.

/**
 * Resolve a raw `![[...]]` inner path to an absolute file under NOTES_DIR, or
 * null if it can't be resolved safely to an existing regular file. Handles the
 * three Obsidian forms above. Bare-name resolution walks the vault once and
 * matches on basename (the vault stays small — the notes index + the catch-all
 * fs.watch already bound it).
 */
export async function resolveAttachmentPath(raw: string): Promise<string | null> {
  let cleaned = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return null
  // Strip a leading legacy Obsidian vault root that no longer exists on disk.
  cleaned = cleaned.replace(/^Notion\//, '')

  // Reject any traversal up-front; '..' must never appear in a vault path.
  if (cleaned.split('/').some((seg) => seg === '..')) return null

  if (cleaned.includes('/')) {
    // Vault-relative form — resolve directly and confirm containment.
    const resolved = path.resolve(NOTES_DIR, cleaned)
    if (!resolved.startsWith(NOTES_DIR + path.sep)) return null
    try {
      const stat = await fsp.stat(resolved)
      if (stat.isFile()) return resolved
    } catch { /* fall through to a basename search below */ }
    // The vault-relative path didn't exist (e.g. a stale folder prefix); fall
    // back to a basename search so the right attachment still resolves.
    return findByBasename(path.basename(cleaned))
  }

  // Bare name — search by basename across the vault (`_attachment/` preferred).
  return findByBasename(cleaned)
}

/** Find the first file whose basename matches `name`, preferring `_attachment/`. */
async function findByBasename(name: string): Promise<string | null> {
  const want = name.toLowerCase()
  let fallback: string | null = null
  const stack: string[] = [NOTES_DIR]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.name.toLowerCase() === want) {
        // Prefer a hit inside an `_attachment/` folder (Obsidian's convention);
        // otherwise remember the first match as a fallback.
        if (path.basename(dir).toLowerCase() === '_attachment') return full
        if (!fallback) fallback = full
      }
    }
  }
  return fallback
}
