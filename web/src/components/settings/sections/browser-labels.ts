/**
 * Display names for signed-in browsers: the kind recorded at sign-in
 * ("iPhone Safari", src/core/browser-kind.ts), numbered " 2", " 3" by sign-in
 * order when it repeats. The credential id (browser-<6 hex>) is never a label (N2-21).
 */
export function browserRowLabels(
  rows: ReadonlyArray<{ name: string; createdAt: string; info?: { deviceName?: string } }>,
): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const r of [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const kind = r.info?.deviceName?.trim() || 'Browser';
    const n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    out.set(r.name, n > 1 ? `${kind} ${n}` : kind);
  }
  return out;
}
