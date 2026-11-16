/** The same JSON: a re-read that brought nothing new keeps the held object, so nothing redraws
 *  (2026-11-16, task 9bceb9f2: each re-read of a chat's session record redrew its panel). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
