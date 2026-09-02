/**
 * Pure helpers for the file explorer's inline create / rename / duplicate rows.
 *
 * Dep-free on purpose (same reason as reveal-ancestors.ts): the component that
 * uses these drags in markdown/highlight deps that can't load under the node-env
 * test config, so the rules live here where a plain vitest file can import them.
 */

/** Longest name any mainstream filesystem accepts, in BYTES (not chars). */
const MAX_NAME_BYTES = 255;

/**
 * Validate one tree entry name against its siblings. Returns null when the name
 * is usable, otherwise a short sentence to render under the edit row.
 *
 * `opts.current` is the item's OWN current name during a rename — it must not
 * count as a collision, or renaming `a.ts` → `a.ts` (or just fixing its case on
 * a case-insensitive volume) would be rejected as already existing.
 */
export function validateEntryName(
  name: string,
  siblings: string[],
  opts: { current?: string } = {},
): string | null {
  if (!name || name.trim() === '') return "Name can't be empty";
  if (name.includes('/') || name.includes('\\')) return "Name can't contain slashes";
  if (name === '.' || name === '..') return 'That name is reserved';
  if (name.includes('\0')) return "Name can't contain that character";
  if (byteLength(name) > MAX_NAME_BYTES) return 'Name is too long';
  if (name !== opts.current && siblings.includes(name)) {
    return 'Something with that name already exists';
  }
  return null;
}

function byteLength(s: string): number {
  // TextEncoder exists in every browser we target and in node ≥11.
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length;
}

/**
 * Split a name into stem + extension the way a duplicate should treat it:
 * a LEADING dot is part of the stem (`.env` has no extension), so duplicating a
 * dotfile gives `.env copy` rather than the nonsense ` copy.env`.
 */
function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

const COPY_SUFFIX = /^(.*?) copy(?: (\d+))?$/;

/**
 * VS Code's duplicate naming: `foo.ts` → `foo copy.ts` → `foo copy 2.ts` → …
 *
 * Duplicating a copy CONTINUES the series instead of nesting ("foo copy copy"),
 * and the returned name is guaranteed absent from `siblings`.
 */
export function nextCopyName(name: string, siblings: string[]): string {
  const taken = new Set(siblings);
  const { stem, ext } = splitName(name);
  const m = COPY_SUFFIX.exec(stem);
  const base = m ? m[1]! : stem;
  let n = m ? (m[2] ? Number(m[2]) : 1) : 0;
  // Each iteration proposes a distinct name, so |siblings|+1 tries always find
  // a free one — the bound is a guard against an accidental infinite loop only.
  for (let i = 0; i <= taken.size + 1; i++) {
    n += 1;
    const candidate = `${base}${n === 1 ? ' copy' : ` copy ${n}`}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} copy ${n + 1}${ext}`;
}

/**
 * Rewrite `p` after `from` was renamed to `to`: used to carry the open file, the
 * expanded-dir set and the cached listings across a rename instead of dropping
 * them (which reads as "the tree collapsed and my file closed itself").
 */
export function remapPathPrefix(p: string, from: string, to: string): string {
  if (p === from) return to;
  if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  return p;
}

/**
 * `p` expressed relative to `root` (both absolute, '/'-separated). A path
 * outside `root` is returned unchanged — a relative path that climbs out with
 * `../..` is worse than the absolute one it replaced.
 */
export function relativeTo(root: string, p: string): string {
  const rootNorm = root.replace(/\/+$/, '');
  const pNorm = p.replace(/\/+$/, '');
  if (pNorm === rootNorm) return '.';
  if (pNorm.startsWith(`${rootNorm}/`)) return pNorm.slice(rootNorm.length + 1);
  return p;
}
