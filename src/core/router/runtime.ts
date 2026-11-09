import { WALNUT_HOME } from '../../constants.js';
import { RouterStore } from './store.js';

const host = globalThis as typeof globalThis & { __walnutRouterStores?: Map<string, RouterStore> };
const stores = host.__walnutRouterStores ??= new Map<string, RouterStore>();

export function routerStore(areaId: string, home = WALNUT_HOME): RouterStore {
  const key = JSON.stringify([home, areaId]);
  let store = stores.get(key);
  if (!store) { store = new RouterStore(home, areaId); stores.set(key, store); }
  return store;
}

export async function disposeRouterStores(): Promise<void> {
  const held = [...stores.values()];
  stores.clear();
  await Promise.all(held.map((store) => store.dispose()));
}
