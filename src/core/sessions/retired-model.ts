/**
 * A session record keeps the exact `--model` it was started with. When that
 * version later leaves the host's menu (Fable 5 → 5.1, 2026-09-28), a cold
 * --resume still passes the old id, and Claude Code swaps it for the first
 * allowed model with "Model … is restricted by your organization's settings.
 * Using … instead." — so a Fable session silently came back as Opus.
 *
 * modelOverrides cannot fix this: the CLI ignores a full provider id used as
 * an override key. The host's own catalog (the rows its CLI offers today) is
 * the authority, so a retired Claude version moves to the ONE row of the same
 * family there. Anything we cannot decide safely is left to the CLI.
 */
import { matchSessionModelCatalogEntry, type SessionModelCatalogEntry } from '../types.js'

// family + version, e.g. "fable-5-1", "opus-5", "haiku-4-5" (the minor part is
// 1-2 digits so a dated suffix like -20251001 is not read as a version).
const CLAUDE_VERSION_RE = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+(?:-\d{1,2})?)(?=$|[-[@:.])/i

function familyVersion(model: string | undefined): { family: string; version: string } | null {
  const m = model ? CLAUDE_VERSION_RE.exec(model) : null
  return m ? { family: m[1].toLowerCase(), version: m[2] } : null
}

/** The catalog value to use instead of `stored`, or null to keep `stored`. */
export function successorForRetiredModel(
  models: SessionModelCatalogEntry[],
  stored: string | undefined,
): string | null {
  if (!stored || models.length === 0) return null
  if (matchSessionModelCatalogEntry(models, stored)) return null
  const want = familyVersion(stored)
  if (!want) return null
  const sameFamily = models.filter((row) => {
    if (row.disabled || row.value === 'default') return false
    const fv = familyVersion(row.resolvedModel) ?? familyVersion(row.value)
    return fv?.family === want.family
  })
  if (sameFamily.length !== 1) return null
  const row = sameFamily[0]
  const have = familyVersion(row.resolvedModel) ?? familyVersion(row.value)
  // Same version under another spelling (claude-opus-5-5 vs the global [1m]
  // row) is still allowed; only a different version is retired.
  return have && have.version !== want.version ? row.value : null
}
