import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const QWEN_MODEL =
  'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
const EMBEDDING_GEMMA_MODEL =
  'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf';
const BGE_M3_MODEL = 'hf:CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf';
const MODEL_DIMENSIONS: Readonly<Record<string, number>> = {
  [QWEN_MODEL]: 1024,
  [EMBEDDING_GEMMA_MODEL]: 768,
  [BGE_M3_MODEL]: 1024,
};
const originalModel = process.env.QMD_EMBED_MODEL;

interface FakeStore {
  update: ReturnType<typeof vi.fn>;
  embed: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  vectorDimensions: { value: number | null };
  internal: {
    clearAllEmbeddings: ReturnType<typeof vi.fn>;
    getHashesForEmbedding: ReturnType<typeof vi.fn>;
    db: {
      exec: ReturnType<typeof vi.fn>;
      prepare: ReturnType<typeof vi.fn>;
    };
  };
}

const mocks = vi.hoisted(() => ({
  createStore: vi.fn(),
  stores: new Map<string, FakeStore>(),
}));

vi.mock('@tobilu/qmd', () => ({
  createStore: mocks.createStore,
}));

vi.mock('../../src/constants.js', () => createMockConstants());

function makeStore(model: string | null, dimensions: number): FakeStore {
  let storedModel = model;
  let embedRun: {
    force: number;
    hashes_json: string;
    model: string;
    started_at: string;
  } | null = null;
  const vectorDimensions: { value: number | null } = { value: dimensions };
  const store: FakeStore = {
    update: vi.fn(async () => undefined),
    embed: vi.fn(async (options?: { force?: boolean; model?: string }) => {
      if (options?.force && options.model) {
        storedModel = options.model;
        vectorDimensions.value = MODEL_DIMENSIONS[options.model] ?? dimensions;
      }
      return {
        docsProcessed: 1,
        chunksEmbedded: 1,
        errors: 0,
        durationMs: 1,
      };
    }),
    close: vi.fn(async () => undefined),
    vectorDimensions,
    internal: {
      clearAllEmbeddings: vi.fn(() => {
        storedModel = null;
        vectorDimensions.value = null;
      }),
      getHashesForEmbedding: vi.fn(() => []),
      db: {
        exec: vi.fn(),
        prepare: vi.fn((sql: string) => ({
          get: () => {
            if (sql.includes('FROM walnut_qmd_embed_runs')) {
              return embedRun ?? undefined;
            }
            if (sql.includes('content_vectors')) {
              return storedModel ? { model: storedModel } : undefined;
            }
            if (sql.includes('sqlite_master')) {
              if (vectorDimensions.value === null) return undefined;
              return {
                sql: `CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${vectorDimensions.value}] distance_metric=cosine)`,
              };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          },
          run: (...args: unknown[]) => {
            if (sql.includes('INSERT OR REPLACE INTO walnut_qmd_embed_runs')) {
              embedRun = {
                model: String(args[0]),
                force: Number(args[1]),
                hashes_json: String(args[2]),
                started_at: String(args[3]),
              };
              return;
            }
            if (sql.includes('DELETE FROM walnut_qmd_embed_runs')) {
              embedRun = null;
              return;
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          },
        })),
      },
    },
  };
  return store;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.stores.clear();
  process.env.QMD_EMBED_MODEL = QWEN_MODEL;

  for (const name of ['memory', 'notes', 'task', 'session']) {
    mocks.stores.set(name, makeStore(QWEN_MODEL, 1024));
  }

  mocks.createStore.mockImplementation(async ({ dbPath }: { dbPath: string }) => {
    const name = dbPath.match(/(memory|notes|task|session)-search\.sqlite$/)?.[1];
    const store = name ? mocks.stores.get(name) : undefined;
    if (!store) throw new Error(`Unexpected QMD dbPath: ${dbPath}`);
    return store;
  });
});

afterEach(() => {
  if (originalModel === undefined) delete process.env.QMD_EMBED_MODEL;
  else process.env.QMD_EMBED_MODEL = originalModel;
  vi.resetModules();
});

describe('QMD vector schema compatibility', () => {
  it.each([
    ['Qwen3 Embedding', QWEN_MODEL, 768, 1024],
    ['EmbeddingGemma', EMBEDDING_GEMMA_MODEL, 1024, 768],
    ['BGE-M3', BGE_M3_MODEL, 768, 1024],
  ])('rebuilds %s indexes to the model dimension', async (
    _label,
    model,
    staleDimensions,
    expectedDimensions,
  ) => {
    process.env.QMD_EMBED_MODEL = model;
    for (const name of ['memory', 'notes', 'task', 'session']) {
      mocks.stores.set(name, makeStore(model, expectedDimensions));
    }
    mocks.stores.set('task', makeStore(model, staleDimensions));
    const { initQmdStores } = await import('../../src/core/qmd-store.js');

    await initQmdStores();

    expect(mocks.stores.get('task')!.embed).toHaveBeenCalledWith({
      force: true,
      model,
      onProgress: undefined,
    });
    expect(mocks.stores.get('task')!.vectorDimensions.value).toBe(expectedDimensions);
    expect(mocks.stores.get('notes')!.embed).not.toHaveBeenCalled();
    expect(mocks.stores.get('session')!.embed).not.toHaveBeenCalled();
  });

  it('migrates a legacy 768d EmbeddingGemma index to default Qwen 1024d', async () => {
    mocks.stores.set('task', makeStore(EMBEDDING_GEMMA_MODEL, 768));
    const { initQmdStores } = await import('../../src/core/qmd-store.js');

    await initQmdStores();

    expect(mocks.stores.get('task')!.embed).toHaveBeenCalledWith({
      force: true,
      model: QWEN_MODEL,
      onProgress: undefined,
    });
    expect(mocks.stores.get('task')!.vectorDimensions.value).toBe(1024);
  });

  it('keeps a correct Qwen 1024d index without force-rebuilding it', async () => {
    const { initQmdStores } = await import('../../src/core/qmd-store.js');

    await initQmdStores();

    expect(mocks.stores.get('task')!.embed).not.toHaveBeenCalled();
    expect(mocks.stores.get('task')!.vectorDimensions.value).toBe(1024);
  });

  it('clears partial vectors and fails initialization when forced embedding reports errors', async () => {
    const taskStore = makeStore(QWEN_MODEL, 768);
    mocks.stores.set('task', taskStore);
    taskStore.embed.mockImplementationOnce(async (options?: { force?: boolean }) => {
      if (options?.force) taskStore.vectorDimensions.value = 1024;
      return {
        docsProcessed: 1,
        chunksEmbedded: 1,
        errors: 1,
        durationMs: 1,
      };
    });
    const { initQmdStores } = await import('../../src/core/qmd-store.js');

    await expect(initQmdStores()).rejects.toThrow(
      'QMD task: embedding failed for 1 chunk(s); partial vectors cleared for retry',
    );
    expect(taskStore.internal.clearAllEmbeddings).toHaveBeenCalledOnce();
    expect(taskStore.vectorDimensions.value).toBeNull();
  });
});
