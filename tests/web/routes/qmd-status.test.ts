import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storeFactories = vi.hoisted(() => ({
  backgroundIndex: vi.fn(async () => undefined),
  configuredModel: vi.fn(async () => 'hf:test/configured/model.gguf'),
  memory: vi.fn(),
  notes: vi.fn(),
  tasks: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock('../../../src/core/qmd-store.js', () => ({
  DEFAULT_QMD_MODEL: 'test-model',
  getMemoryStore: storeFactories.memory,
  getNotesStore: storeFactories.notes,
  getTaskStore: storeFactories.tasks,
  getSessionStore: storeFactories.sessions,
}));

vi.mock('../../../src/core/qmd-background-indexer.js', () => ({
  runQmdBackgroundIndex: storeFactories.backgroundIndex,
}));

vi.mock('../../../src/core/qmd-model.js', () => ({
  resolveConfiguredQmdModel: storeFactories.configuredModel,
}));

import {
  qmdRouter,
  resetQmdRouteState,
  setQmdStoreStats,
} from '../../../src/web/routes/qmd.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';

function createApp() {
  const app = express();
  app.use('/api/qmd', qmdRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  storeFactories.configuredModel.mockResolvedValue('hf:test/configured/model.gguf');
  resetQmdRouteState();
  setQmdStoreStats({
    memory: null,
    notes: null,
    tasks: {
      collections: {
        tasks: { indexed: 3_546, embedded: 3_000, chunks: 4_000 },
      },
      totalIndexed: 3_546,
      totalEmbedded: 3_000,
      totalChunks: 4_000,
    },
    sessions: {
      collections: {
        sessions: { indexed: 5_136, embedded: 5_000, chunks: 8_000 },
      },
      totalIndexed: 5_136,
      totalEmbedded: 5_000,
      totalChunks: 8_000,
    },
  });
});

afterEach(() => {
  resetQmdRouteState();
  vi.useRealTimers();
});

describe('GET /api/qmd/status', () => {
  it('returns the worker snapshot without opening SQLite stores in the request', async () => {
    const response = await request(createApp()).get('/api/qmd/status');

    expect(response.status).toBe(200);
    expect(response.body.stores.tasks).toMatchObject({
      totalIndexed: 3_546,
      collections: {
        tasks: { indexed: 3_546 },
      },
    });
    expect(response.body.stores.sessions).toMatchObject({
      totalIndexed: 5_136,
      collections: {
        sessions: { indexed: 5_136 },
      },
    });
    expect(storeFactories.memory).not.toHaveBeenCalled();
    expect(storeFactories.notes).not.toHaveBeenCalled();
    expect(storeFactories.tasks).not.toHaveBeenCalled();
    expect(storeFactories.sessions).not.toHaveBeenCalled();
  });
});

describe('POST /api/qmd/download', () => {
  it('applies the configured model when download starts', async () => {
    const response = await request(createApp()).post('/api/qmd/download');

    expect(response.status).toBe(202);
    expect(storeFactories.backgroundIndex).toHaveBeenCalledWith({
      initialize: true,
      force: true,
      model: 'hf:test/configured/model.gguf',
      resetStores: true,
      onProgress: expect.any(Function),
      onStats: expect.any(Function),
    });
  });

  it('reports a model-resolution failure and permits a retry', async () => {
    storeFactories.configuredModel.mockRejectedValueOnce(
      new Error('configured model unavailable'),
    );

    const app = createApp();
    const failed = await request(app).post('/api/qmd/download');
    expect(failed.status).toBe(500);

    const status = await request(app).get('/api/qmd/status');
    expect(status.body).toMatchObject({
      status: 'error',
      error: 'configured model unavailable',
    });

    const retry = await request(app).post('/api/qmd/download');
    expect(retry.status).toBe(202);
    expect(storeFactories.backgroundIndex).toHaveBeenCalledOnce();
  });

  it('clears model polling timers as soon as background indexing settles', async () => {
    vi.useFakeTimers();
    let finishIndex!: () => void;
    storeFactories.backgroundIndex.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishIndex = resolve;
      }),
    );

    const response = await request(createApp()).post('/api/qmd/download');
    expect(response.status).toBe(202);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    finishIndex();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('POST /api/qmd/reindex', () => {
  it('reports a model-resolution failure and permits a retry', async () => {
    storeFactories.configuredModel.mockRejectedValueOnce(
      new Error('configured model unavailable'),
    );

    const app = createApp();
    const failed = await request(app).post('/api/qmd/reindex');
    expect(failed.status).toBe(500);

    const status = await request(app).get('/api/qmd/status');
    expect(status.body).toMatchObject({
      status: 'error',
      error: 'configured model unavailable',
    });

    const retry = await request(app).post('/api/qmd/reindex');
    expect(retry.status).toBe(202);
    expect(storeFactories.backgroundIndex).toHaveBeenCalledOnce();
  });
});
