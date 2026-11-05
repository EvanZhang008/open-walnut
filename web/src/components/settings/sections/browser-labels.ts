/**
 * Display names for signed-in browsers: the name recorded at sign-in ("iPhone
 * Safari", "iPhone Safari 2": src/web/routes/browser-pair.ts numbers it then, so a
 * row keeps its name when another is removed). Records from before that all hold
 * the bare kind; only those repeats are numbered here, by sign-in order, with a
 * number no recorded name holds. The credential id (browser-<6 hex>) is never a
 * label (N2-21).
 */
export function browserRowLabels(
  rows: ReadonlyArray<{ name: string; createdAt: string; info?: { deviceName?: string } }>,
): Map<string, string> {
  const out = new Map<string, string>();
  const recorded = (r: { info?: { deviceName?: string } }) => r.info?.deviceName?.trim() || 'Browser';
  const held = new Set(rows.map(recorded));
  const used = new Set<string>();
  for (const r of [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    let label = recorded(r);
    if (used.has(label)) {
      const kind = label.replace(/ \d+$/, '');
      let n = 2;
      while (used.has(`${kind} ${n}`) || held.has(`${kind} ${n}`)) n += 1;
      label = `${kind} ${n}`;
    }
    used.add(label);
    out.set(r.name, label);
  }
  return out;
}
