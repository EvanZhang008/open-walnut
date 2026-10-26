/**
 * Rows in the order `held` names (the order they had when the pointer came over the list),
 * then any row that arrived since, in its own order. `null` = no hold.
 */
export function holdOrder<T extends { key: string }>(rows: readonly T[], held: readonly string[] | null): readonly T[] {
  if (!held) return rows;
  const at = new Map(held.map((k, i) => [k, i]));
  const kept = rows.filter((r) => at.has(r.key)).sort((a, b) => at.get(a.key)! - at.get(b.key)!);
  return [...kept, ...rows.filter((r) => !at.has(r.key))];
}
