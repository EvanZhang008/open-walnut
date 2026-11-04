/** Small wording helpers shared by the panels. */

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** A notes folder as the person reads it: `Notes / Archive / Notion 2024`. */
export function inNotes(folder: string): string {
  return ['Notes', ...folder.split('/').filter(Boolean)].join(' / ')
}
