/**
 * Whether a CSS background value lets a reader see what lies under it. Shared by the
 * opaque-overlay guards (org-overlays-opaque.test.ts, overlays-opaque.test.ts,
 * overlay-chrome-opaque.test.ts).
 */

/** A background a reader sees through: transparent, an alpha under 1, or the shared glass. */
export function seeThrough(value: string): boolean {
  if (/transparent|--overlay-glass-bg|--glass-bg/.test(value)) return true;
  for (const m of value.matchAll(/(?:rgba|hsla)\(([^)]*)\)/g)) {
    const parts = m[1].split(/[,/]/).map((s) => s.trim());
    const a = parseFloat(parts[3] ?? '1');
    if (a < 1) return true;
  }
  for (const m of value.matchAll(/(?:rgb|hsl)\([^)]*\/\s*([\d.]+%?)\)/g)) {
    const a = m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
    if (a < 1) return true;
  }
  for (const m of value.matchAll(/#([0-9a-f]{8}|[0-9a-f]{4})\b/gi)) {
    const h = m[1];
    if (!/^f+$/i.test(h.length === 8 ? h.slice(6) : h.slice(3))) return true;
  }
  return false;
}
