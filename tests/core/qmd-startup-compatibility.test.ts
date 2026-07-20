import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const QWEN_MODEL =
  'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf';
const GEMMA_MODEL =
  'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf';

vi.mock('../../src/constants.js', () =>
  createMockConstants('qmd-startup-compatibility'));

import { WALNUT_HOME } from '../../src/constants.js';
import { qmdStoresRequireModelReset } from '../../src/core/qmd-store.js';

function seedStoredModel(model: string): void {
  const db = new Database(path.join(WALNUT_HOME, 'task-search.sqlite'));
  db.exec('CREATE TABLE content_vectors (model TEXT NOT NULL)');
  db.prepare('INSERT INTO content_vectors (model) VALUES (?)').run(model);
  db.close();
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('QMD startup compatibility inspection', () => {
  it('requires an exclusive reset when the persisted model changed', () => {
    seedStoredModel(GEMMA_MODEL);

    expect(qmdStoresRequireModelReset(QWEN_MODEL)).toBe(true);
  });

  it('keeps normal WAL reads available for a same-model store', () => {
    seedStoredModel(QWEN_MODEL);

    expect(qmdStoresRequireModelReset(QWEN_MODEL)).toBe(false);
  });
});
