/**
 * Where the router sent given items, for a surface that shows them outside Mail (a Slack message):
 * the same route view Mail's rows carry (routeViews), keyed by each item's message id.
 */
import { WALNUT_HOME } from '../../constants.js';
import { readRouterAreas, sourceArea } from './areas.js';
import { routerStore } from './runtime.js';
import { routeViews, type RouterRouteView } from './service.js';
import { routerKey } from './store.js';
import type { RouterSource } from './types.js';

export const ITEM_ROUTES_MAX = 200;

export interface ItemRoute { route?: RouterRouteView; area?: { id: string; name: string } }

/** Each asked item's route (none yet: only its area, when one takes it), by message id. */
export async function itemRoutes(sources: RouterSource[], home = WALNUT_HOME): Promise<Record<string, ItemRoute>> {
  const file = await readRouterAreas(home);
  const out: Record<string, ItemRoute> = {};
  const byArea = new Map<string, RouterSource[]>();
  for (const source of sources.slice(0, ITEM_ROUTES_MAX)) {
    const area = sourceArea(file, source);
    if (!area) continue;
    out[source.message] = { area: { id: area.id, name: area.name || area.id } };
    byArea.set(area.id, [...(byArea.get(area.id) ?? []), source]);
  }
  await Promise.all([...byArea].map(async ([areaId, group]) => {
    const ledger = await routerStore(areaId, home).getSources(group);
    const views = new Map((await routeViews([...ledger.values()], { home })).map((view) => [view.key, view]));
    for (const source of group) {
      const route = ledger.get(routerKey(source));
      const view = route ? views.get(route.key) : undefined;
      if (view) out[source.message] = { ...out[source.message], route: view };
    }
  }));
  return out;
}
