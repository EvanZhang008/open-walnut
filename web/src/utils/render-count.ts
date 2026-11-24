/**
 * How often the page's largest components draw, for two readers:
 *  - the specs that guard it (tests/e2e/browser/app-responsiveness-budget.spec.ts): a background
 *    update (an agent's status write, about 13 a minute) must draw only what shows it, never
 *    Home's whole task list and every open chat again. Off unless a page sets
 *    `window.__walnutRenderCounts = {}`; then each counted component adds one per draw.
 *  - the main-thread tracer, which names the components that drew during a block it could not
 *    pin on a traced callback (`takeDrawsSinceLastTake`, called once per 100ms sample).
 * Costs one property read and one counter add per draw.
 */
type Counts = Record<string, number>;

let sinceTake: Counts = {};
let anySinceTake = false;

export function countRender(name: string): void {
  sinceTake[name] = (sinceTake[name] ?? 0) + 1;
  anySinceTake = true;
  const counts = (globalThis as { __walnutRenderCounts?: Counts }).__walnutRenderCounts;
  if (counts) counts[name] = (counts[name] ?? 0) + 1;
}

/** The draws counted since the previous call, or null when none (no allocation then). */
export function takeDrawsSinceLastTake(): Counts | null {
  if (!anySinceTake) return null;
  const taken = sinceTake;
  sinceTake = {};
  anySinceTake = false;
  return taken;
}
