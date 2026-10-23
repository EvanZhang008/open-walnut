/**
 * Directory entries in the order Node gives them. Node's readdir returns names
 * sorted (libuv sorts what scandir reads); bun returns them in the file
 * system's own order. Code whose result depends on that order (the first match
 * wins, a later entry overrides an earlier one, a list is shown as read, a cap
 * applies before any sort) sorts with these, so both runtimes pick the same.
 *
 * The daemon cores (src/providers/*-core.ts) cannot import this: their
 * functions are inlined into the daemon source by text, so they sort inline.
 */

/** Sort names in place, by UTF-16 code unit as `Array.prototype.sort` does, and return them. */
export function sortedNames<T extends string>(names: T[]): T[] {
  return names.sort()
}

/** Sort Dirents (or anything with a `name`) in place by name, and return them. */
export function sortedByName<T extends { name: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
