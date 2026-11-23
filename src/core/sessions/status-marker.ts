/**
 * One marker line of a status answer ("FOR_USER_THREAD: ...", "**FOR_USER_THREAD_TITLE**： ..."): the
 * marker, markdown around it allowed, an ASCII or full-width colon, and the rest of the line as the
 * last group. `name` may hold groups of its own (FOR_USER_THREAD(_NEW)?), which come first. Pure.
 */
export function markerRe(name: string, flags: string): RegExp {
  return new RegExp(`^[^\\S\\n]*[*_\`]*${name}[*_\`]*[^\\S\\n]*[:\\uff1a][*_\`]*[^\\S\\n]*(.*)$`, flags);
}
