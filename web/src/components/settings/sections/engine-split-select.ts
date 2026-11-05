/**
 * Settings, Sessions: "Share new tasks" (EngineSplitRow), the engines new task work takes
 * turns between (`defaults.engine_split`, core/agents/engine-split.ts).
 *
 * The row toggles plain engine entries; an entry the config gives a weight or a model keeps
 * them, and an entry with a model (Claude Code on another company's model) is never touched
 * here. Like the default engine's save, every sibling of `defaults` is spread back.
 */
import type { Config, EngineSplitEntry, SessionEngine } from '@open-walnut/core';

type Defaults = Pick<Config, 'defaults'>;

function entries(config: Defaults | undefined): EngineSplitEntry[] {
  const raw = (config?.defaults as { engine_split?: unknown } | undefined)?.engine_split;
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => (typeof e === 'string' ? { engine: e as SessionEngine } : e as EngineSplitEntry))
    .filter((e) => e && typeof e.engine === 'string');
}

/** The engines checked now (plain entries), in `order`, as one comparable string. */
export function splitChecked(config: Defaults | undefined, order: readonly string[]): string {
  const plain = new Set(entries(config).filter((e) => !e.model).map((e) => e.engine as string));
  return [...order.filter((id) => plain.has(id)), ...[...plain].filter((id) => !order.includes(id))].join(',');
}

/** The entries the config keeps that the row does not show (they name a model). */
export function splitModelEntries(config: Defaults | undefined): EngineSplitEntry[] {
  return entries(config).filter((e) => !!e.model);
}

/** The write for a new set of checked engines. */
export function engineSplitSave(config: Defaults, checked: string, order: readonly string[]): Partial<Config> {
  const want = new Set(checked ? checked.split(',') : []);
  const current = entries(config);
  const kept = new Map(current.filter((e) => !e.model).map((e) => [e.engine as string, e]));
  const plain = [...order.filter((id) => want.has(id)), ...[...want].filter((id) => !order.includes(id))]
    .map((id) => kept.get(id) ?? { engine: id as SessionEngine });
  return { defaults: { ...config.defaults, engine_split: [...plain, ...splitModelEntries(config)] } } as Partial<Config>;
}

/** How many entries the split would have: two or more turn it on. */
export function splitSize(checked: string, config: Defaults | undefined): number {
  return (checked ? checked.split(',').length : 0) + splitModelEntries(config).length;
}
