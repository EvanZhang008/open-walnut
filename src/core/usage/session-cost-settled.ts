/**
 * Which session cost answer is a finished read (GET /api/sessions/:id/cost): one rule for the
 * server's cache (session-cost.ts) and the browser's (`@open-walnut/session-cost-settled`,
 * web/src/stores/session-cost-store.ts). A finished read answers later reads and stays on screen;
 * `pending` (a long first read still going) and `unavailable` (no answer in time, an older daemon)
 * never replace one. Pure and import-free.
 */
export function settledCost(payload: { status: string }): boolean {
  return payload.status !== 'pending' && payload.status !== 'unavailable';
}
