import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('routine-queue-data-version'));
import { WALNUT_HOME } from '../../../src/constants.js';
import { closeDb, getDb, TASK_DB_PATH } from '../../../src/core/task-db.js';
import { ensureRoutineQueueDataVersion } from '../../../src/core/routines/capacity-data-version.js';
import { TASK_DB_SCHEMA_VERSION, TASK_DB_ROUTINE_QUEUE_VERSION } from '../../../src/core/task-db-version.js';
import { PluginDatabaseClient } from '../../../src/core/plugins/plugin-storage.js';
import { taskStoreVersion } from '../../helpers/router-task-store.js';

afterAll(async () => { closeDb(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('a routine wait cannot be misread by a previous build', () => {
  it('leaves ordinary data unchanged, stamps before queueing, and the previous reader refuses the newer data', async () => {
    getDb();
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(TASK_DB_SCHEMA_VERSION);
    await Promise.all([ensureRoutineQueueDataVersion(), ensureRoutineQueueDataVersion()]);
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(TASK_DB_ROUTINE_QUEUE_VERSION);
    const oldMax = TASK_DB_ROUTINE_QUEUE_VERSION - 1;
    // The same existing-file version gate older published task stores already execute.
    const old = new PluginDatabaseClient(path.join(WALNUT_HOME, 'tasks', 'tasks.sqlite'), undefined, { existingOnly: true });
    try {
      expect((await old.ensureUserVersion(TASK_DB_SCHEMA_VERSION, oldMax, oldMax)).status).toBe('newer');
    } finally { await old.dispose(); }
    closeDb();
    expect(getDb()).toBeTruthy();
    expect(taskStoreVersion(TASK_DB_PATH)).toBe(TASK_DB_ROUTINE_QUEUE_VERSION);
  });
});
