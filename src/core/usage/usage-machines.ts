import type { Config } from '../types.js';
import type { CostRollup } from './cost-rollup.js';

/**
 * Every name a usage row carries, read as its machine's (one machine, one host: hosts/joined-twins.ts). The rollup is told how to
 * keep one of the copies of a response stored under several names (cost-rollup.ts rankOf): the machine's own name, then a name
 * found in ~/.ssh/config, then another name of the machine, then a name Walnut no longer knows (an older alias, as `clouddev-net`).
 * The rank holds without the daemon's pairs too (a found row ranks below the row the person added), so a first read of the pairs
 * that failed never keeps a copy under the found name. `refresh`: read the pairs again first (a collection pass).
 */
export async function usageMachines(config: Pick<Config, 'hosts' | 'net'>, rollup?: CostRollup, opts: { refresh?: boolean } = {}): Promise<{ machineOf: (host: string) => string }> {
  const twins = await import('../hosts/daemon-twins.js');
  await (opts.refresh ? twins.refreshDaemonTwins(config as Config) : twins.daemonTwinsReady());
  const { joinedAliasOf } = await import('../hosts/joined-twins.js');
  const machineOf = joinedAliasOf(config.hosts ?? {}, config.net) as (alias: string) => string;
  const rows = (config.hosts ?? {}) as Record<string, { discovered?: unknown } | undefined>;
  rollup?.setHostRank(host => {
    if (host === '__local__') return 0;
    const row = rows[host];
    if (!row) return 4;
    return (machineOf(host) === host ? 0 : 2) + (row.discovered === true ? 1 : 0);
  });
  return { machineOf };
}
