import { getConfig } from './config-manager.js';

export const QWEN3_EMBEDDING_MODEL =
  'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
export const EMBEDDING_GEMMA_MODEL =
  'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf';
export const BGE_M3_EMBEDDING_MODEL =
  'hf:CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf';

export const DEFAULT_QMD_MODEL =
  QWEN3_EMBEDDING_MODEL;

// Capture the process-level override before Walnut writes the selected runtime
// model back to the environment for QMD and its worker children.
const ENV_MODEL_OVERRIDE = process.env.QMD_EMBED_MODEL?.trim() || null;

let runtimeModel: string | null = null;
let runtimeModelPromise: Promise<string> | null = null;

/** Resolve the model selected by the user without changing the running stores. */
export async function resolveConfiguredQmdModel(): Promise<string> {
  if (ENV_MODEL_OVERRIDE) return ENV_MODEL_OVERRIDE;
  const config = await getConfig();
  return config.search?.qmd_model?.trim() || DEFAULT_QMD_MODEL;
}

/**
 * Pin one model for this process. All stores and child workers use this value
 * until an explicit Download/Re-index operation applies another model.
 */
export async function initializeQmdRuntimeModel(): Promise<string> {
  if (runtimeModel) return runtimeModel;
  if (!runtimeModelPromise) {
    runtimeModelPromise = resolveConfiguredQmdModel()
      .then((model) => {
        setQmdRuntimeModel(model);
        return model;
      })
      .finally(() => {
        runtimeModelPromise = null;
      });
  }
  return runtimeModelPromise;
}

export function setQmdRuntimeModel(model: string): void {
  const normalized = model.trim();
  if (!normalized) throw new Error('QMD embedding model must not be empty');
  runtimeModel = normalized;
  process.env.QMD_EMBED_MODEL = normalized;
}

/** Clear process-local state after a server lifecycle ends. */
export function resetQmdRuntimeModel(): void {
  runtimeModel = null;
  runtimeModelPromise = null;
  if (ENV_MODEL_OVERRIDE) process.env.QMD_EMBED_MODEL = ENV_MODEL_OVERRIDE;
  else delete process.env.QMD_EMBED_MODEL;
}
