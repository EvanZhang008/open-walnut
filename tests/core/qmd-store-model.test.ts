import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const DEFAULT_MODEL =
  'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
const originalModel = process.env.QMD_EMBED_MODEL;

const mocks = vi.hoisted(() => ({
  createStore: vi.fn(),
  getConfig: vi.fn(),
}));

vi.mock('@tobilu/qmd', () => ({
  createStore: mocks.createStore,
}));

vi.mock('../../src/constants.js', () =>
  createMockConstants('qmd-store-model-test'));

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: mocks.getConfig,
}));

function fakeStore() {
  return {
    close: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  delete process.env.QMD_EMBED_MODEL;
  vi.resetModules();
  mocks.createStore.mockReset().mockResolvedValue(fakeStore());
  mocks.getConfig.mockReset().mockResolvedValue({ search: {} });
});

afterEach(() => {
  if (originalModel === undefined) delete process.env.QMD_EMBED_MODEL;
  else process.env.QMD_EMBED_MODEL = originalModel;
  vi.resetModules();
});

describe('QMD process model', () => {
  it('uses Qwen3 Embedding by default before creating a store', async () => {
    const { DEFAULT_QMD_MODEL, getTaskStore } =
      await import('../../src/core/qmd-store.js');

    await getTaskStore();

    expect(DEFAULT_QMD_MODEL).toBe(DEFAULT_MODEL);
    expect(process.env.QMD_EMBED_MODEL).toBe(DEFAULT_MODEL);
    expect(mocks.createStore).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        models: { embed: DEFAULT_MODEL },
      }),
    }));
  });

  it('uses the model saved in Walnut config', async () => {
    const configuredModel = 'hf:test/configured/model.gguf';
    mocks.getConfig.mockResolvedValue({
      search: { qmd_model: configuredModel },
    });
    const { getSessionStore } = await import('../../src/core/qmd-store.js');

    await getSessionStore();

    expect(process.env.QMD_EMBED_MODEL).toBe(configuredModel);
    expect(mocks.createStore).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        models: { embed: configuredModel },
      }),
    }));
  });

  it('preserves an explicit environment override over Walnut config', async () => {
    process.env.QMD_EMBED_MODEL = 'hf:test/environment/model.gguf';
    mocks.getConfig.mockResolvedValue({
      search: { qmd_model: 'hf:test/configured/model.gguf' },
    });
    vi.resetModules();
    const { getMemoryStore } = await import('../../src/core/qmd-store.js');

    await getMemoryStore();

    expect(process.env.QMD_EMBED_MODEL).toBe('hf:test/environment/model.gguf');
    expect(mocks.createStore).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        models: { embed: 'hf:test/environment/model.gguf' },
      }),
    }));
  });
});
