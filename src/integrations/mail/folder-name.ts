/**
 * Which folder a mail filter (`moveTo`) may file mail into. ONE rule set, read by the rules file
 * schema, the IMAP provider, the filter card and the Settings editor (web imports it as
 * `@open-walnut/mail-folder-name`), so a name one of them takes is never refused by another later,
 * batch after batch. Zero imports.
 *
 * Never a system folder: filing into Trash, Junk or Deleted Items is a deletion the server carries
 * out later (2026-11-09 review), Sent and Drafts are not where received mail lives, and a folder
 * named like the Inbox reads back as the Inbox, so the moved mail would be "moved" again. The leaf
 * is judged by the same English names the IMAP role guess uses (coords.ts BY_NAME), whatever the
 * hierarchy separator. The provider also refuses a folder the server itself marks as one of those.
 */
export const MAX_FOLDER_NAME = 200

const SYSTEM_LEAF = /^(inbox|sent|sent items|sent mail|sent messages|drafts|draft|trash|deleted|deleted items|deleted messages|bin|junk|spam|junk e-?mail|bulk mail|outbox|all mail|important|starred|chats)$/i

/** Why `folder` cannot be a filter's folder, or null. */
export function folderNameProblem(folder: string): string | null {
  const name = folder.trim()
  if (!name) return 'Name the folder.'
  if (name.length > MAX_FOLDER_NAME) return `A folder name is at most ${MAX_FOLDER_NAME} characters.`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f*%]/.test(name)) return 'A folder name cannot hold control characters, * or %.'
  if (/^\[(gmail|google mail)\]/i.test(name)) return 'Gmail keeps its own [Gmail] folders; name a folder of your own.'
  // "/" is the person's level separator; some servers use "." instead, so a dot at either end is
  // an empty level there ("Acme Inc." would make "Acme Inc" plus a nameless folder).
  if (name.split('/').some((part) => !part.trim())) return 'A folder name cannot have an empty level (two "/" in a row, or one at an end).'
  if (name.split('/').some((part) => /^\.|\.$|\.\./.test(part.trim()))) return 'A folder name cannot start or end with a dot, or hold two dots in a row.'
  if (/^inbox$/i.test(name)) return 'Mail cannot be filed into the Inbox it leaves.'
  const leaf = name.split(/[/.]/).map((part) => part.trim()).filter(Boolean).pop() ?? name
  if (SYSTEM_LEAF.test(leaf)) return `"${leaf}" is a folder your mail server keeps for itself (Trash, Junk, Sent and the like). Name a folder of your own.`
  return null
}
