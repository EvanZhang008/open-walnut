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
 * Resolution, in order (each step only runs if the previous found nothing):
 *   1. Exact vault-relative path       `![[Areas/x/_attachment/Foo.png]]`
 *   2. Same, after stripping a legacy `Notion/` vault root that no longer exists
 *   3. LONGEST MATCHING PATH SUFFIX    `![[Notion/Areas/Records/_attachment/Untitled 5.png]]`
 *      → the file whose vault path ends with `Records/_attachment/Untitled 5.png`,
 *      else `_attachment/Untitled 5.png`, else the bare `Untitled 5.png`.
 *   4. Ambiguity tiebreak: prefer the candidate physically NEAREST the embedding
 *      note (longest shared directory prefix with `noteDir`), then a hit inside
 *      an `_attachment/` folder, then the shallowest path, then lexicographic
 *      (so the answer is deterministic run to run).
 *
 * Why suffix matching and not basename matching (the 2026-08 bug): this vault
 * has 51 image basenames that exist in more than one folder (`Untitled 5.png`
 * lives in SEVEN different `_attachment/` dirs, all different pictures). The old
 * code threw away every path segment and matched the basename alone, so an embed
 * naming its folder explicitly still got whichever copy the directory walk
 * happened to reach first — 67 embeds resolved to a picture from an unrelated
 * note. Keeping the segments means the folder in the embed actually counts.
 *
 * Security: a resolved file MUST stay strictly inside NOTES_DIR (no `..`
 * escape); only an existing regular file is returned. The route applies the
 * extension allowlist + size cap on top.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { NOTES_DIR } from '../../constants.js'

// The attachment-type allowlist lives in notes-v2.ts (ATTACHMENT_MIME) —
// single source of truth; this module only resolves paths.

/**
 * Cached vault file index (vault-relative POSIX paths). Resolving used to walk
 * the whole vault PER REQUEST, and one image-heavy note fires 20-40 requests at
 * once — measured 167-217ms each under that fan-out, all of it re-listing the
 * same 200 directories. The index is rebuilt on a short TTL, and any miss forces
 * one immediate rebuild before answering 404, so a just-uploaded attachment is
 * never reported missing because of staleness.
 */
const INDEX_TTL_MS = 5_000
let cachedIndex: string[] | null = null
let cachedAt = 0
let buildInFlight: Promise<string[]> | null = null

async function buildIndex(): Promise<string[]> {
  const files: string[] = []
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
      } else if (entry.isFile()) {
        files.push(path.relative(NOTES_DIR, full).split(path.sep).join('/'))
      }
    }
  }
  return files
}

async function vaultIndex(forceRebuild = false): Promise<string[]> {
  if (!forceRebuild && cachedIndex && Date.now() - cachedAt < INDEX_TTL_MS) return cachedIndex
  // Coalesce concurrent rebuilds: an image-heavy note opens 20+ requests in the
  // same tick, and each one racing its own full walk is exactly the fan-out this
  // cache exists to remove.
  if (!buildInFlight) {
    buildInFlight = buildIndex()
      .then((files) => {
        cachedIndex = files
        cachedAt = Date.now()
        return files
      })
      .finally(() => { buildInFlight = null })
  }
  return buildInFlight
}

/** Drop the cached index — call after writing/deleting a vault attachment. */
export function invalidateAttachmentIndex(): void {
  cachedIndex = null
  cachedAt = 0
}

/**
 * Normalize a raw `![[...]]` inner path: unify slashes, drop a leading `/`,
 * strip an Obsidian size suffix (`|300`), and strip the legacy `Notion/` vault
 * root. Returns null for anything containing a `..` traversal segment.
 */
function cleanRawPath(raw: string): string | null {
  // An embed may carry a display size (`![[x.png|300]]`); callers usually strip
  // it, but a raw `![[...]]` inner string reaching here must not be treated as
  // part of the filename.
  let cleaned = raw.split('|')[0].trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return null
  cleaned = cleaned.replace(/^Notion\//, '')
  if (!cleaned) return null
  if (cleaned.split('/').some((seg) => seg === '..')) return null
  return cleaned
}

/** An existing regular file at `relative` under NOTES_DIR, or null. */
async function statFile(relative: string): Promise<string | null> {
  const resolved = path.resolve(NOTES_DIR, relative)
  // Containment guard: `path.resolve` collapses any traversal, so this catches
  // an escape even if the segment check above were bypassed.
  if (resolved !== NOTES_DIR && !resolved.startsWith(NOTES_DIR + path.sep)) return null
  try {
    const stat = await fsp.stat(resolved)
    return stat.isFile() ? resolved : null
  } catch {
    return null
  }
}

/**
 * Rank ambiguous candidates: nearest the note first, then `_attachment/` hits,
 * then shallowest, then lexicographic. Higher tuple sorts first.
 */
function candidateRank(candidate: string, noteDirSegments: string[]): [number, number, number, string] {
  const dir = path.posix.dirname(candidate)
  const dirSegments = dir === '.' ? [] : dir.split('/')
  let shared = 0
  for (let i = 0; i < Math.min(noteDirSegments.length, dirSegments.length); i++) {
    if (noteDirSegments[i] !== dirSegments[i]) break
    shared++
  }
  const inAttachmentDir = dirSegments[dirSegments.length - 1]?.toLowerCase() === '_attachment' ? 1 : 0
  // Negative depth so a shallower path ranks higher under a plain descending sort.
  return [shared, inAttachmentDir, -dirSegments.length, candidate]
}

function pickBest(candidates: string[], noteDir: string | undefined): string {
  if (candidates.length === 1) return candidates[0]
  const noteDirSegments = noteDir ? noteDir.split('/').filter(Boolean) : []
  let best = candidates[0]
  let bestRank = candidateRank(best, noteDirSegments)
  for (const candidate of candidates.slice(1)) {
    const rank = candidateRank(candidate, noteDirSegments)
    for (let i = 0; i < 4; i++) {
      const a = rank[i]
      const b = bestRank[i]
      if (a === b) continue
      // Lexicographic tiebreak (index 3) sorts ASCENDING; the numeric ranks
      // sort descending.
      const better = i === 3 ? String(a) < String(b) : (a as number) > (b as number)
      if (better) { best = candidate; bestRank = rank }
      break
    }
  }
  return best
}

/**
 * Every file in the index whose vault path equals `suffix` or ends with
 * `/${suffix}` (case-insensitive — macOS vaults are case-preserving but not
 * case-sensitive, and hand-typed embeds don't match case).
 */
function matchSuffix(index: string[], suffix: string): string[] {
  const want = suffix.toLowerCase()
  const wantWithSep = '/' + want
  const hits: string[] = []
  for (const candidate of index) {
    const lower = candidate.toLowerCase()
    if (lower === want || lower.endsWith(wantWithSep)) hits.push(candidate)
  }
  return hits
}

/**
 * Resolve a raw `![[...]]` inner path to an absolute file under NOTES_DIR, or
 * null if it can't be resolved safely to an existing regular file.
 *
 * `notePath` is the vault-relative path of the note doing the embedding, when
 * the caller knows it. It only breaks TIES: with 51 duplicated image basenames
 * in a real vault, "the copy sitting nearest this note" is the only signal that
 * distinguishes them, and without it an embed can render a stranger's picture.
 */
export async function resolveAttachmentPath(
  raw: string,
  notePath?: string,
): Promise<string | null> {
  const cleaned = cleanRawPath(raw)
  if (!cleaned) return null

  // 1) Exact vault-relative path — the cheap, unambiguous case (no vault walk).
  const direct = await statFile(cleaned)
  if (direct) return direct

  const noteDir = notePath ? path.posix.dirname(cleanRawPath(notePath) || '') : undefined
  const segments = cleaned.split('/')

  // 2) Longest matching path suffix. A miss retries ONCE against a force-rebuilt
  //    index, so a just-written attachment is never 404ed by a stale cache — but
  //    only when the first pass could actually have been stale (a cold/expired
  //    cache already walked the vault, and repeating that walk finds nothing new).
  const firstPassWasFresh = !cachedIndex || Date.now() - cachedAt >= INDEX_TTL_MS
  const passes: boolean[] = firstPassWasFresh ? [false] : [false, true]
  for (const forceRebuild of passes) {
    const index = await vaultIndex(forceRebuild)
    for (let start = 0; start < segments.length; start++) {
      const hits = matchSuffix(index, segments.slice(start).join('/'))
      if (!hits.length) continue
      const chosen = pickBest(hits, noteDir === '.' ? undefined : noteDir)
      const resolved = await statFile(chosen)
      if (resolved) return resolved
    }
  }
  return null
}
