import type { NoteTreeNode } from '@/api/notes-v2';

/**
 * Folder notes (the Obsidian convention): a folder `X/` that holds a note named
 * after itself, `X/X.md`, is a page with sub-pages. The notes importers write
 * pages with children this way, and a hand-made vault may too.
 *
 * The tree shows such a folder as ONE row: the folder row opens `X/X.md` and the
 * note is not listed again among the folder's children (a `Child A` folder with
 * a `Child A` note directly under it reads as two things to pick from).
 *
 * The match is exact and case-sensitive, like every other path comparison the
 * tree makes (paths are compared as strings; `.md` is matched literally by the
 * server's tree walk). `Foo/foo.md` is an ordinary note inside `Foo/`. A folder
 * holds at most one child with a given exact name, so there is never more than
 * one candidate.
 */
export function folderNoteOf(folder: NoteTreeNode): NoteTreeNode | null {
  if (folder.type !== 'folder' || !folder.children) return null;
  const want = `${folder.name}.md`;
  for (const c of folder.children) {
    if (c.type === 'file' && c.kind !== 'attachment' && c.name === want) return c;
  }
  return null;
}

/** The folder's children as the tree lists them: its folder note left out. */
export function visibleFolderChildren(folder: NoteTreeNode, folderNote: NoteTreeNode | null): NoteTreeNode[] {
  const all = folder.children ?? [];
  const children = folderNote ? all.filter((c) => c !== folderNote) : all;
  // The folder's index note (`Index`, or `<folder> index`) comes first, so it is found before what
  // it lists; the files of the notes beside it come after the notes.
  const index = children.filter((c) => isIndexNoteOf(folder, c));
  const files = children.filter(isAttachmentFolder);
  if (!index.length && !files.length) return children;
  return [...index, ...children.filter((c) => !isAttachmentFolder(c) && !index.includes(c)), ...files];
}

/** A note named `Index` or `<folder name> index` in `folder` (any case): the folder's index. */
export function isIndexNoteOf(folder: NoteTreeNode, node: NoteTreeNode): boolean {
  if (node.type !== 'file' || !/\.md$/i.test(node.name)) return false;
  const stem = node.name.slice(0, -'.md'.length).toLowerCase();
  return stem === 'index' || stem === `${folder.name.toLowerCase()} index`;
}

/** `_attachment`: the folder that holds the images and files of the notes beside it. */
export function isAttachmentFolder(node: NoteTreeNode): boolean {
  return node.type === 'folder' && node.name === '_attachment';
}

/**
 * Path-only check: is `notePath` the folder note of its parent folder
 * (`a/X/X.md`)? Returns that folder's path, else null. Used where only a path is
 * known (reveal-in-tree), so the folder row can stand in for the hidden note row.
 */
export function folderOfFolderNote(notePath: string): string | null {
  if (!notePath.endsWith('.md')) return null;
  const slash = notePath.lastIndexOf('/');
  if (slash <= 0) return null;
  const folder = notePath.slice(0, slash);
  const folderName = folder.slice(folder.lastIndexOf('/') + 1);
  const stem = notePath.slice(slash + 1, -'.md'.length);
  return stem === folderName ? folder : null;
}

/**
 * What a click on a folder row's NAME does. A plain folder toggles, as it always
 * has. A folder with a folder note opens that note and unfolds the folder when it
 * is folded, but never folds it: folding is the chevron's job, so clicking the
 * name of the page you are reading does not hide its sub-pages.
 */
export function folderRowClickAction(
  folderNote: NoteTreeNode | null,
  isExpanded: boolean,
): { open: string | null; expand: 'toggle' | 'expand' | 'none' } {
  if (!folderNote) return { open: null, expand: 'toggle' };
  return { open: folderNote.path, expand: isExpanded ? 'none' : 'expand' };
}
