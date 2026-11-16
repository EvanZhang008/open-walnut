/**
 * How often the page's largest components draw, for the specs that guard it
 * (tests/e2e/browser/app-responsiveness-budget.spec.ts): a background update (an agent's
 * status write, about 13 a minute) must draw only what shows it, never Home's whole task
 * list and every open chat again. Off unless a page sets `window.__walnutRenderCounts = {}`;
 * then each counted component adds one per draw. Costs one property read per draw.
 */
type Counts = Record<string, number>;

export function countRender(name: string): void {
  const counts = (globalThis as { __walnutRenderCounts?: Counts }).__walnutRenderCounts;
  if (counts) counts[name] = (counts[name] ?? 0) + 1;
}
