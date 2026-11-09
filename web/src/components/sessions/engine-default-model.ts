/**
 * The model an engine runs when a launch names none, named as the composer names a running
 * session's model (acpModelDisplayName: the name the engine lists it by) and as Settings lists it.
 * The fallback engine's words use it wherever the setting names no model, so Settings, the draft,
 * the banner and the row's hover all say the same "Codex (Mock GPT Best)" (2026-11-09 review: three
 * names for one model). Claude Code needs none: its fallback always names a model.
 */
import { useEffect, useState } from 'react';
import type { EngineFallbackNote } from '@open-walnut/core';
import { fetchEngineModelCatalog } from '@/api/sessions';
import { getCachedEngineModelCatalog } from '@/api/engine-model-cache';
import { acpModelDisplayName } from './acp-model-id';

export interface EngineDefaultModel { id: string; name: string }

/** One catalog read per engine at a time: every Home row with a fallback tag asks at mount. */
const reading = new Map<string, Promise<EngineDefaultModel | undefined>>();

/** `again`: a retry after a read with no answer, past the server's cached failure. */
function readDefault(engine: string, again = false): Promise<EngineDefaultModel | undefined> {
  let p = reading.get(engine);
  if (!p) {
    p = fetchEngineModelCatalog(engine, undefined, again ? { refresh: true } : undefined)
      .then((c) => named(c))
      // A failed read keeps the last catalog this app saw.
      .catch(() => fromCatalog(engine))
      .finally(() => { reading.delete(engine); });
    reading.set(engine, p);
  }
  return p;
}

function named(c: { currentModelId?: string; models: Array<{ modelId: string; name?: string }> } | null | undefined): EngineDefaultModel | undefined {
  const id = c?.currentModelId;
  if (!id) return undefined;
  const name = acpModelDisplayName(id, c.models.find((m) => m.modelId === id)?.name || undefined);
  return name ? { id, name } : undefined;
}

function fromCatalog(engine: string): EngineDefaultModel | undefined {
  return named(getCachedEngineModelCatalog(engine));
}

/** The engine's default model, read once from its model catalog (cached across the app). */
export function useEngineDefaultModel(engine: string | undefined): EngineDefaultModel | undefined {
  const [read, setRead] = useState<{ engine: string; model: EngineDefaultModel | undefined } | null>(null);
  const wanted = engine && engine !== 'claude' ? engine : undefined;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    const read = (left: number): void => {
      void readDefault(wanted, left < 2).then((model) => {
        if (!live) return;
        setRead({ engine: wanted, model });
        // No answer yet (the engine's probe failed or timed out): ask again in a moment.
        if (!model && left > 0) again = setTimeout(() => read(left - 1), 4_000);
      });
    };
    read(2);
    return () => { live = false; if (again) clearTimeout(again); };
  }, [wanted]);
  if (!wanted) return undefined;
  return read?.engine === wanted ? read.model : fromCatalog(wanted);
}

/** The note with the engine's default model named, when the note names none. */
export function withDefaultModel<T extends Pick<EngineFallbackNote, 'model' | 'model_label'>>(note: T, model: EngineDefaultModel | undefined): T {
  return note.model || !model ? note : { ...note, model: model.id, model_label: model.name };
}
