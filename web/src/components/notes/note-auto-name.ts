/**
 * A new note is named by what its owner writes in it (2026-11-11, the user: "When we new a
 * file please immediately new the file ... name will be provided as the title, by default if
 * no name provided"). New note makes `Untitled.md` (`Untitled 1.md`, ... when taken) at once
 * and opens it; once the note's first line settles, the file takes that line's words as its
 * name, and keeps following them while the note is still auto-named. A name the user gives
 * it in the tree ends that. The pure parts live here; `useNoteAutoName` wires them to the
 * page, and `useNoteContent.renameOpenNote` moves the open note without reopening it.
 */

export const UNTITLED_BASE = 'Untitled';
/** How long the saved first line stays the same before the file is renamed after it. */
export const AUTO_NAME_SETTLE_MS = 1000;
/** A name longer than this is cut, at a word when one ends late enough. */
export const MAX_NAME_CHARS = 80;
/** File systems allow 255 bytes per name; this leaves room for ` 99.md`. */
const MAX_NAME_BYTES = 200;

function folderOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** The file's name without its folder and `.md`. */
export function noteBaseName(p: string): string {
  const name = p.slice(p.lastIndexOf('/') + 1);
  return name.replace(/\.md$/i, '');
}

export function joinNotePath(folder: string, base: string): string {
  return folder ? `${folder}/${base}.md` : `${base}.md`;
}

/**
 * Two names that the vault treats as one file: the Mac's file system ignores case and
 * Unicode normalization, so `Plan.md` and `plan.md` collide there.
 */
function nameKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/** `base`, else `base 1`, `base 2`, ...: the first path in `folder` no file in `existing` holds. */
function freePath(folder: string, base: string, existing: Iterable<string>, self?: string): string {
  const taken = new Set<string>();
  for (const p of existing) if (p !== self) taken.add(nameKey(p));
  for (let n = 0; n < 10_000; n++) {
    const candidate = joinNotePath(folder, n === 0 ? base : `${base} ${n}`);
    if (!taken.has(nameKey(candidate))) return candidate;
  }
  return joinNotePath(folder, `${base} ${Date.now().toString(36)}`);
}

/** Where New note puts its file: the first free `Untitled` name in `folder` ('' = vault root). */
export function pickUntitledPath(folder: string, existing: Iterable<string>): string {
  return freePath(folder, UNTITLED_BASE, existing);
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** One markdown line as the words a reader sees: block markers, links and emphasis gone. */
function plainLine(raw: string): string {
  let s = raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    // HTML tags before the entities, so a written `&lt;b&gt;` stays as words; a lone
    // `<` (as in `a <- b`) is no tag.
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
    .trim();
  // A code fence's marker line and a rule carry no title.
  if (/^(```|~~~)/.test(s) || /^([-*_]\s*){3,}$/.test(s)) return '';
  s = s
    .replace(/^(>\s*)+/, '')
    .replace(/^#{1,6}(\s+|$)/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '');
  s = s
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, target: string, alias?: string) =>
      alias?.trim() || target.slice(target.lastIndexOf('/') + 1))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~<])/g, '$1');
  return s.replace(/\s+/g, ' ').trim();
}

/** The note's title: the words of its first line that has any (its first heading, as a rule). */
export function noteTitleFromBody(body: string): string {
  for (const line of body.split('\n')) {
    const words = plainLine(line);
    if (words) return words;
  }
  return '';
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * A title as a file name: no path separators, nothing a file system refuses, and none of
 * `# ^ [ ] |`, which would break a `[[wiki link]]` to the note. '' when nothing is left.
 */
export function fileBaseFromTitle(title: string): string {
  let s = title
    .normalize('NFC')
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex -- control characters are what is removed
    .replace(/[<>:"|?*#^[\]\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Until nothing changes: `notes.md.` loses its dot, then its `.md`.
  const tidy = (t: string) => {
    for (let prev = ''; prev !== t;) {
      prev = t;
      t = t.replace(/(\.md)+$/i, '').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    }
    return t;
  };
  s = tidy(s);
  const chars = Array.from(s);
  if (chars.length > MAX_NAME_CHARS) {
    let cut = chars.slice(0, MAX_NAME_CHARS).join('');
    const space = cut.lastIndexOf(' ');
    if (space >= MAX_NAME_CHARS / 2) cut = cut.slice(0, space);
    s = tidy(cut);
  }
  while (s && utf8Length(s) > MAX_NAME_BYTES) s = tidy(Array.from(s).slice(0, -1).join(''));
  return s;
}

/**
 * The note at `currentPath` already is named `base`: it is `base`, or `base N` while `base`
 * itself is another note's (the number it got because the name was taken). A note titled
 * "Plan" in `Plan 3.md` with no `Plan.md` beside it is not, and becomes `Plan.md`.
 */
function namedAfter(currentPath: string, base: string, existing: readonly string[]): boolean {
  const c = nameKey(noteBaseName(currentPath));
  const b = nameKey(base);
  if (c === b) return true;
  if (!c.startsWith(`${b} `) || !/^\d+$/.test(c.slice(b.length + 1))) return false;
  const plain = nameKey(joinNotePath(folderOf(currentPath), base));
  return existing.some((p) => p !== currentPath && nameKey(p) === plain);
}

/**
 * Where an auto-named note should live for what `body` says now, or null to leave it: no
 * title yet, or its name already is the title (also when it differs only in case, which a
 * case-blind file system cannot rename). A taken name gets the first free number; the note's
 * own file is never counted as taken.
 */
export function autoNameTarget(currentPath: string, body: string, existing: Iterable<string>): string | null {
  const base = fileBaseFromTitle(noteTitleFromBody(body));
  if (!base) return null;
  const all = Array.from(existing);
  if (namedAfter(currentPath, base, all)) return null;
  return freePath(folderOf(currentPath), base, all, currentPath);
}

// ── Which notes are auto-named (this window, until reload) ──
// Only a note New note made here follows its title: an older note named `Untitled 3.md`
// (a Notion export, say, whose pictures sit beside it under that name) is never renamed.

const autoNamed = new Set<string>();
/** Renames that failed once, by note: never tried again for the same name. */
const failed = new Map<string, Set<string>>();

export function markAutoNamed(path: string): void {
  autoNamed.add(path);
}

export function isAutoNamed(path: string): boolean {
  return autoNamed.has(path);
}

/** The user named or removed the note: it no longer follows its title. */
export function forgetAutoName(path: string): void {
  autoNamed.delete(path);
  failed.delete(path);
}

/** The note was renamed after its title: it stays auto-named under its new path. */
export function followAutoName(from: string, to: string): void {
  if (!autoNamed.delete(from)) return;
  autoNamed.add(to);
  failed.delete(from);
}

export function noteAutoNameFailed(path: string, target: string): void {
  let set = failed.get(path);
  if (!set) failed.set(path, (set = new Set()));
  set.add(target);
}

export function autoNameFailedBefore(path: string, target: string): boolean {
  return failed.get(path)?.has(target) ?? false;
}

export function resetAutoNamesForTests(): void {
  autoNamed.clear();
  failed.clear();
}
