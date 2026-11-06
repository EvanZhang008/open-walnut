/**
 * One row per model in a model list.
 *
 * Claude Code's own list names one model several ways: its `default` row, its `opus` alias and
 * the raw id the session runs (`claude-opus-5-5`, which the CLI adds when the current model is
 * no row of its own) all resolve to Opus 5.5, so the picker read "Default (Opus 5.5)", "Opus 5.5"
 * and a ticked "Opus 5.5" (2026-11-06, the user: the model list shows Opus 5.5 three times). Rows
 * whose label names the same versioned model ("Opus 5.5", "Opus 5.5 1M": the 1M window stays its
 * own model) are one model to the user, and the list keeps one of them: the row the session runs
 * on, else the first enabled one that is not `default` in the catalog's order, else `default`. A row whose
 * label names no version (a custom proxy model, a bare alias) is never folded. The iOS twin is
 * `ModelCatalogRowLabel.menuRows`.
 */
import { formatModelName } from '@/utils/model-name';
import type { SessionModelCatalogEntry } from '@open-walnut/core';

/** The model a row names (the versioned name `catalogRowLabel` derives), or null when it names
 *  no version. */
export function modelIdentity(m: SessionModelCatalogEntry): string | null {
  const named = versionedName(m.resolvedModel ?? m.value);
  // A row whose value asks for the 1M window is the 1M model, even when its resolvedModel drops the
  // marker (the CLI lists `…claude-fable-5-1[1m]` resolving to `…claude-fable-5-1`).
  return named && /\[1m\]/i.test(m.value) && !named.endsWith(' 1M') ? `${named} 1M` : named;
}

function versionedName(model: string): string | null {
  const named = formatModelName(model);
  return /^(Opus|Sonnet|Haiku|Fable) \d/.test(named) ? named : null;
}

/**
 * The row of a model by the name it reads as, for a model no row matches by id: a session that
 * runs `claude-fable-5[1m]` against a catalog row `global.anthropic.claude-fable-5[1m]` runs that
 * row, and drew a second "Fable 5 1M" row of its own before. The row kept is the one
 * `oneRowPerModel` keeps with no active row.
 */
export function rowNamedLike(models: SessionModelCatalogEntry[], model?: string | null): SessionModelCatalogEntry | null {
  const named = model ? versionedName(model) : null;
  if (!named) return null;
  const same = models.filter((m) => modelIdentity(m) === named);
  return same.reduce<SessionModelCatalogEntry | null>((held, m) => (held && !better(m, held) ? held : m), null);
}

/** Which of two rows naming one model the list keeps: an enabled row over a disabled one, then a
 *  row that is not `default` over `default`, else the first. */
function better(m: SessionModelCatalogEntry, held: SessionModelCatalogEntry): boolean {
  if (!!held.disabled !== !!m.disabled) return !m.disabled;
  return held.value === 'default' && m.value !== 'default';
}

/** The catalog with one row per model. `activeValue` is the row the session runs on. */
export function oneRowPerModel(models: SessionModelCatalogEntry[], activeValue?: string | null): SessionModelCatalogEntry[] {
  const keep = new Map<string, SessionModelCatalogEntry>();
  for (const m of models) {
    const id = modelIdentity(m);
    if (!id) continue;
    const held = keep.get(id);
    if (!held) { keep.set(id, m); continue; }
    if (held.value === activeValue) continue;
    if (m.value === activeValue || better(m, held)) keep.set(id, m);
  }
  return models.filter((m) => {
    const id = modelIdentity(m);
    return !id || keep.get(id) === m;
  });
}
