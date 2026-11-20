/**
 * Settings, Sessions: "Engines in the model picker" (PickerEnginesGroup). Pure, like the
 * default engine row's logic: what is checked, and what each save writes.
 *
 * `updateConfig` replaces a whole top-level key, so every save spreads the section back:
 * `session` holds every session setting, and `engines` every engine's env and provider.
 */
import type { Config, SessionEngine } from '@open-walnut/core';
import { shownInPicker, type EngineCatalog } from '@/utils/engines';

/** The engines checked now: the saved list, else the ones the catalog shows (the defaults). */
export function pickerChecked(config: Pick<Config, 'session'>, catalog: EngineCatalog): SessionEngine[] {
  const saved = config.session?.picker_engines;
  if (Array.isArray(saved)) return catalog.filter((e) => saved.includes(e.id)).map((e) => e.id);
  return catalog.filter((e) => shownInPicker(e)).map((e) => e.id);
}

/** The save of one checkbox: the whole list, in catalog (registry) order. */
export function pickerEnginesSave(config: Config, checked: readonly SessionEngine[], catalog: EngineCatalog): Partial<Config> {
  const order = catalog.map((e) => e.id);
  const next = [...new Set(checked)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { session: { ...(config.session ?? {}), picker_engines: next } } as Partial<Config>;
}

/** A command line as argv: spaces split it, single or double quotes keep a part whole. */
export function commandArgv(text: string): string[] {
  const parts: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) parts.push(m[1] ?? m[2] ?? m[3]);
  return parts.filter((p) => p.length > 0);
}

/** argv back as the line the field shows: a part with a space is quoted. */
export function argvText(argv: unknown): string {
  if (!Array.isArray(argv)) return '';
  return argv.filter((p): p is string => typeof p === 'string')
    .map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');
}

/** The custom ACP engine's command: `engines.custom.adapter_cmd`; an empty line removes it. */
export function customAdapterSave(config: Config, text: string): Partial<Config> {
  const engines = { ...(config.engines ?? {}) };
  const { adapter_cmd: _old, ...rest } = engines.custom ?? {};
  const argv = commandArgv(text);
  engines.custom = argv.length > 0 ? { ...rest, adapter_cmd: argv } : rest;
  return { engines } as Partial<Config>;
}
