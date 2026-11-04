/**
 * The Overview's last answer, kept in this browser (utils/last-good.ts) so a reopened page
 * paints every card at once, before the server's cached read comes back. Each card still says
 * how old it is (`readAt`), and the server's answer replaces it whole.
 */
import type { FleetHost } from './hosts-fleet';
import { keepLastGood, readLastGood } from '@/utils/last-good';

export const FLEET_LAST_KEY = 'walnut:last-good:host-fleet:v1';

const isCard = (h: unknown): h is FleetHost => !!h && typeof h === 'object'
  && typeof (h as FleetHost).host === 'string' && !!(h as FleetHost).sessions && !!(h as FleetHost).connection;
const isFleet = (v: unknown): v is FleetHost[] => Array.isArray(v) && v.length > 0 && v.every(isCard);

/** Every card of the last answer, never one marked as being read (that read is long over). */
export function lastFleet(): FleetHost[] | null {
  return readLastGood(FLEET_LAST_KEY, isFleet)?.value.map((h) => ({ ...h, refreshing: false })) ?? null;
}

export function keepFleet(hosts: FleetHost[]): void {
  if (hosts.length) keepLastGood(FLEET_LAST_KEY, hosts);
}
