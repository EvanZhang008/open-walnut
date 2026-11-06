/**
 * Settings, Sessions: "Share new tasks" (EngineSplitRow), the engines new task work takes
 * turns between (`defaults.engine_split`, core/agents/engine-split.ts).
 *
 * Every entry is one checkbox, keyed as the split keys it: the engine id, or `engine:model` for
 * an entry that names a model (Claude Code on another model). An entry the config gives a weight
 * keeps it. Like the default engine's save, every sibling of `defaults` is spread back.
 */
import type { Config, EngineSplitEntry, SessionEngine } from '@open-walnut/core';

type Defaults = Pick<Config, 'defaults'>;

/** The split's switch is off: its entries are kept, nothing is shared (`defaults.engine_split_off`). */
export function splitIsOff(config: Defaults | undefined): boolean {
  return (config?.defaults as { engine_split_off?: unknown } | undefined)?.engine_split_off === true;
}

/** The write for the switch: off keeps every entry, on clears the flag. */
export function engineSplitSwitchSave(config: Defaults, on: boolean): Partial<Config> {
  const { engine_split_off: _off, ...rest } = config.defaults as Config['defaults'] & { engine_split_off?: boolean };
  return { defaults: on ? rest : { ...rest, engine_split_off: true } } as Partial<Config>;
}

function entries(config: Defaults | undefined): EngineSplitEntry[] {
  const raw = (config?.defaults as { engine_split?: unknown } | undefined)?.engine_split;
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => (typeof e === 'string' ? { engine: e as SessionEngine } : e as EngineSplitEntry))
    .filter((e) => e && typeof e.engine === 'string');
}

/** An entry's key, as the split names it: `claude`, or `claude:sonnet`. */
export function entryKey(e: { engine: string; model?: string }): string {
  return e.model ? `${e.engine}:${e.model}` : e.engine;
}

/** The entry a key names (an engine id holds no colon; a model id may). */
export function entryOfKey(key: string): EngineSplitEntry {
  const at = key.indexOf(':');
  return at < 0 ? { engine: key as SessionEngine } : { engine: key.slice(0, at) as SessionEngine, model: key.slice(at + 1) };
}

/** The entries checked now, as one comparable string: plain engines in `order`, then the model entries in config order. */
export function splitChecked(config: Defaults | undefined, order: readonly string[]): string {
  const all = entries(config);
  const plain = new Set(all.filter((e) => !e.model).map((e) => e.engine as string));
  const keys = [...order.filter((id) => plain.has(id)), ...[...plain].filter((id) => !order.includes(id)),
    ...all.filter((e) => !!e.model).map(entryKey)];
  return [...new Set(keys)].join(',');
}

/** The entries that name a model, as the config keeps them. */
export function splitModelEntries(config: Defaults | undefined): EngineSplitEntry[] {
  return entries(config).filter((e) => !!e.model);
}

/** The write for a new set of checked entries (keys, in the order they should take turns). */
export function engineSplitSave(config: Defaults, checked: string, _order: readonly string[]): Partial<Config> {
  const current = new Map(entries(config).map((e) => [entryKey(e), e]));
  const want = [...new Set(checked ? checked.split(',') : [])];
  const next = want.map((key) => current.get(key) ?? entryOfKey(key));
  return { defaults: { ...config.defaults, engine_split: next } } as Partial<Config>;
}

/**
 * How many entries the split would really have: two or more turn it on. As the server reads them
 * (core/agents/engine-split.ts): a model on an engine in `noModel` (an ACP engine) is ignored, so
 * "Codex" and "Codex on gpt-x" are one entry.
 */
export function splitSize(checked: string, noModel: ReadonlySet<string> = new Set()): number {
  if (!checked) return 0;
  return new Set(checked.split(',').map((k) => {
    const e = entryOfKey(k);
    return e.model && !noModel.has(e.engine) ? k : e.engine;
  })).size;
}
