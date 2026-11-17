/**
 * Where the router sent given items, for a surface that shows them outside Mail (a Slack message):
 * the same route view Mail's rows carry (routeViews), keyed by each item's message id.
 */
import { WALNUT_HOME } from '../../constants.js';
import { allAreaItems, readRouterAreas, sourceArea, type RouterAreasFile } from './areas.js';
import { routerStore } from './runtime.js';
import { routeViews, type RouterRouteView } from './service.js';
import { routerKey } from './store.js';
import type { RouterSource } from './types.js';

export const ITEM_ROUTES_MAX = 200;

export interface ItemRoute { route?: RouterRouteView; area?: { id: string; name: string } }

/**
 * The item as the area lists it. A surface asks by message id alone, but every arrival is entered
 * with its delivery version (a mail's, an edited message's), and the area and the ledger both key
 * on it: without it nothing matched (2026-11-16, every real item read as unrouted). An unversioned
 * ask takes the newest delivery the area lists for that message.
 */
function listedSource(file: RouterAreasFile, source: RouterSource): RouterSource {
  if (source.version !== undefined) return source;
  const listed = allAreaItems(file).filter((item) =>
    item.source.kind === source.kind && item.source.account === source.account && item.source.message === source.message);
  return listed.at(-1)?.source ?? source;
}

/** Each asked item's route (none yet: only its area, when one takes it), by message id. */
export async function itemRoutes(sources: RouterSource[], home = WALNUT_HOME): Promise<Record<string, ItemRoute>> {
  const file = await readRouterAreas(home);
  const out: Record<string, ItemRoute> = {};
  const byArea = new Map<string, RouterSource[]>();
  for (const asked of sources.slice(0, ITEM_ROUTES_MAX)) {
    const source = listedSource(file, asked);
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
