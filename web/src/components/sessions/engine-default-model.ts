/**
 * The model an engine runs when a launch names none, named as the model picker names it in its
 * "Codex default (GPT Best)" row (ModelPicker.tsx: shortAcpModelName of the engine's current model).
 * The fallback engine's words use it wherever the setting names no model, so Settings, the draft,
 * the banner and the row's hover all say the same "Codex (GPT Best)" (2026-11-09 review: three names
 * for one model). Claude Code needs none: its fallback always names a model.
 */
import { useEffect, useState } from 'react';
import type { EngineFallbackNote } from '@open-walnut/core';
import { fetchEngineModelCatalog } from '@/api/sessions';
import { getCachedEngineModelCatalog } from '@/api/engine-model-cache';
import { shortAcpModelName } from './acp-model-id';

export interface EngineDefaultModel { id: string; name: string }

/** One catalog read per engine at a time: every Home row with a fallback tag asks at mount. */
const reading = new Map<string, Promise<EngineDefaultModel | undefined>>();

function readDefault(engine: string): Promise<EngineDefaultModel | undefined> {
  let p = reading.get(engine);
  if (!p) {
    p = fetchEngineModelCatalog(engine)
      .then((c) => (c.currentModelId ? { id: c.currentModelId, name: shortAcpModelName(c.currentModelId) } : undefined))
      // A failed read keeps the last catalog this app saw.
      .catch(() => fromCatalog(engine))
      .finally(() => { reading.delete(engine); });
    reading.set(engine, p);
  }
  return p;
}

function fromCatalog(engine: string): EngineDefaultModel | undefined {
  const id = getCachedEngineModelCatalog(engine)?.currentModelId;
  return id ? { id, name: shortAcpModelName(id) } : undefined;
}

/** The engine's default model, read once from its model catalog (cached across the app). */
export function useEngineDefaultModel(engine: string | undefined): EngineDefaultModel | undefined {
  const [read, setRead] = useState<{ engine: string; model: EngineDefaultModel | undefined } | null>(null);
  const wanted = engine && engine !== 'claude' ? engine : undefined;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void readDefault(wanted).then((model) => { if (live) setRead({ engine: wanted, model }); });
    return () => { live = false; };
  }, [wanted]);
  if (!wanted) return undefined;
  return read?.engine === wanted ? read.model : fromCatalog(wanted);
}

/** The note with the engine's default model named, when the note names none. */
export function withDefaultModel<T extends Pick<EngineFallbackNote, 'model' | 'model_label'>>(note: T, model: EngineDefaultModel | undefined): T {
  return note.model || !model ? note : { ...note, model: model.id, model_label: model.name };
}
