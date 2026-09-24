/**
 * Fold records for rows that can show in more than one place at once: a project's
 * run shows in every tier holding its tasks, and a folder shows in each tier and in
 * the Projects list wherever its members are. A fold belongs to the (place, id)
 * pair that was clicked, so folding Walnut in Satellite leaves Walnut in Focus alone.
 *
 * Both records used to be one set of ids shared by every place. Folding a row folded
 * its copies ABOVE the click too, and the clicked row jumped up (2026-09-23: "it
 * should stay where it was clicked, the below collapses").
 *
 * An old record converts on first read: each id it held becomes an every-place
 * fold (`*`), so nothing that was folded springs open. The first click on one of
 * those rows spells it out per place, keeping the other places folded. The old key
 * is left as it is for older builds still reading it on another device.
 */
const SEP = '\u001f';
const EVERY_PLACE = '*';

export function foldKey(place: string, id: string): string {
  return `${place}${SEP}${id}`;
}

/** The id a fold key belongs to (a project name, '' = Inbox, or a folder id). */
export function foldedId(key: string): string {
  const i = key.indexOf(SEP);
  return i < 0 ? key : key.slice(i + 1);
}

export function isFoldedAt(folds: ReadonlySet<string>, place: string, id: string): boolean {
  return folds.has(foldKey(place, id)) || folds.has(foldKey(EVERY_PLACE, id));
}

/** Folds or unfolds one place's row. `places` = every place, needed only to split an
 *  every-place fold so the other places stay folded. */
export function toggleFold(folds: ReadonlySet<string>, place: string, id: string, places: readonly string[]): Set<string> {
  const next = new Set(folds);
  if (next.delete(foldKey(EVERY_PLACE, id))) {
    for (const p of places) if (p !== place) next.add(foldKey(p, id));
    next.delete(foldKey(place, id));
    return next;
  }
  const key = foldKey(place, id);
  if (!next.delete(key)) next.add(key);
  return next;
}

/** Opens a row in one place. Returns the same set when it was not folded there, so a
 *  state setter can bail out. */
export function unfold(folds: ReadonlySet<string>, id: string, place: string, places: readonly string[]): ReadonlySet<string> {
  return isFoldedAt(folds, place, id) ? toggleFold(folds, place, id, places) : folds;
}

/** Keeps only the folds `keep` accepts. Same set back when it drops none. */
export function pruneFolds(folds: ReadonlySet<string>, keep: (key: string) => boolean): ReadonlySet<string> {
  const doomed = [...folds].filter((key) => !keep(key));
  if (doomed.length === 0) return folds;
  const next = new Set(folds);
  for (const key of doomed) next.delete(key);
  return next;
}

function readArray(storage: Pick<Storage, 'getItem'>, key: string): string[] | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function readFolds(key: string, legacyKey: string, storage?: Pick<Storage, 'getItem'>): Set<string> {
  try {
    const store = storage ?? localStorage;
    const saved = readArray(store, key);
    if (saved) return new Set(saved);
    return new Set((readArray(store, legacyKey) ?? []).map((id) => foldKey(EVERY_PLACE, id)));
  } catch {
    return new Set();
  }
}

export function saveFolds(key: string, folds: ReadonlySet<string>, storage?: Pick<Storage, 'setItem'>): void {
  try { (storage ?? localStorage).setItem(key, JSON.stringify([...folds])); } catch { /* Storage off: folds last this visit. */ }
}
