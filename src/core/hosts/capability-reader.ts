/** Host placement reads the same durable facts as Fleet, without requiring a page visit or a network read. */
import { getConfig, isFallbackConfig } from '../config-manager.js';
import { hostCapabilities, type HostCapabilities } from './capabilities.js';
import { fleetCacheEntry, loadFleetCache } from './fleet-cache.js';
import { readHostProfile } from './host-profile.js';

export async function readHostCapabilities(host: string): Promise<HostCapabilities | null> {
  const config = await getConfig();
  if (isFallbackConfig(config)) return null;
  const local = host === '__local__';
  const def = config.hosts?.[host];
  if (!local && !def) return null;
  const [profile] = await Promise.all([readHostProfile(host).catch(() => null), loadFleetCache()]);
  const kept = fleetCacheEntry(host);
  const age = Date.now() - (kept?.vitals?.at ?? 0);
  // A seven-day observation is not evidence of current uptime forever.
  const windows = kept?.stale || age < 0 || age > 7 * 86_400_000 ? null : kept?.vitals?.value.history?.windows;
  const week = Array.isArray(windows) ? windows.find(w => w?.days === 7
    && Number.isFinite(w.minutes) && Number.isFinite(w.online) && w.online! >= 0 && w.online! <= 1) : null;
  return hostCapabilities({
    probed: profile?.probed, kind: profile?.kind, local,
    week: week ?? null,
    declared: local ? config.local_capabilities : def?.capabilities,
  });
}
