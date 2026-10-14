/** How many rows of `pageKey` sit before raw index `end` (the hidden ones). */
export function pageRowsBefore(end: number, keyAt: (i: number) => string, pageKey: string): number {
  let n = 0;
  for (let i = 0; i < end; i++) if (keyAt(i) === pageKey) n += 1;
  return n;
}
