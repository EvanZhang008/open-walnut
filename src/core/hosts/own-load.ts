/**
 * The load a start gate judges by: over its line, only the share our own processes hold
 * (2026-11-08: Walnut started no session on the Mac for an hour at a load near 98 on 14 cores,
 * mostly a music app and a security agent, with a third of the CPU idle; lane B and the test
 * gates had the same fault, tests/setup/cpu-idle.ts). Ours: a process that is, or descends from,
 * Walnut, an agent CLI, bun, node, a test browser, Xcode's tools or a simulator
 * (HostLoad.ownThreads, read by the host's daemon). What other processes take of the CPU and of
 * memory still counts through each gate's CPU-busy and memory caps. With no share (Linux, a daemon
 * older than the field, a share with no other process in it) the whole load counts.
 */
import type { HostLoad } from '../../providers/host-facts-core.js';

export interface OwnLoad {
  /** The load per CPU to judge by. */
  perCpu: number;
  /** The whole load per CPU, set only when perCpu is our share of it. */
  rawPerCpu?: number;
}

export function ownLoadPerCpu(load: Pick<HostLoad, 'load' | 'cpus' | 'ownThreads'>, line: number): OwnLoad {
  const cpus = Math.max(1, load.cpus || 1);
  const perCpu = Math.round(((load.load[0] ?? 0) / cpus) * 100) / 100;
  const t = load.ownThreads;
  if (perCpu < line || !t || !(t.others > 0) || !(t.ours >= 0)) return { perCpu };
  return { perCpu: Math.round(((perCpu * t.ours) / (t.ours + t.others)) * 100) / 100, rawPerCpu: perCpu };
}
