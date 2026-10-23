/**
 * Component versions are `<package version>-<revision>` (4.2.0-1). Newer means a
 * higher package version, then a higher revision: a data home shared by two
 * Walnut builds keeps both of their versions, and an install only ever removes
 * the ones older than its own (install.ts).
 */

function parts(v: string): { main: string[]; rev: number } {
  const dash = v.lastIndexOf('-');
  const rev = dash > 0 ? Number(v.slice(dash + 1)) : Number.NaN;
  const main = (Number.isInteger(rev) ? v.slice(0, dash) : v).split('.');
  return { main, rev: Number.isInteger(rev) ? rev : 0 };
}

function comparePart(a: string | undefined, b: string | undefined): number {
  const na = Number(a ?? '0');
  const nb = Number(b ?? '0');
  if (Number.isInteger(na) && Number.isInteger(nb)) return Math.sign(na - nb);
  return (a ?? '').localeCompare(b ?? '');
}

/** Negative when `a` is older than `b`, positive when newer, 0 when equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.main.length, pb.main.length); i++) {
    const c = comparePart(pa.main[i], pb.main[i]);
    if (c !== 0) return c;
  }
  return Math.sign(pa.rev - pb.rev);
}
