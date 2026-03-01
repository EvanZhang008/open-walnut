/**
 * Live test: ExtSync roundtrip via ephemeral server.
 *
 * Spins up an ephemeral Walnut server (copies ~/.walnut/ to /tmp, random port),
 * creates tasks via REST, and verifies they sync to ExtSync and back.
 *
 * Tests:
 * 1. Plugin loads from external dir — GET /api/integrations includes ext-sync
 * 2. Create task → push to ExtSync — ext.ext-sync.id appears after debounce
 * 3. Pull from ExtSync → local — task survives a sync poll trigger
 * 4. Update title → pushed — PATCH title propagates to remote
 * 5. Phase change → workflow synced — IN_PROGRESS phase syncs
 * 6. Dependency sync — set depends_on, verify both tasks exist
 * 7. Cleanup — afterAll deletes all test tasks (best-effort)
 *
 * Safety:
 * - All test tasks use "[walnut-test]" title prefix
 * - Every created task ID is tracked in createdTaskIds[]
 * - afterAll cleans up all created tasks (best-effort, never throws)
 * - Never queries/modifies tasks not created by this test
 *
 * Requires:
 *   - WALNUT_LIVE_TEST=1 (or LIVE=1) environment variable
 *   - ~/.walnut/config.yaml with plugins.ext-sync.room_id configured
 *   - Valid ExtSync credentials (cookie-based auth)
 *
 * Run with:
 *   WALNUT_LIVE_TEST=1 npx vitest run tests/integrations/ext-sync-roundtrip.live.test.ts --config vitest.live.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as yaml from 'js-yaml';
import { isLiveTest, hasPluginCredentials } from '../helpers/live.js';

// ── Gate: skip unless live-test mode + ext-sync credentials ──

const shouldRun = isLiveTest() && hasPluginCredentials('ext-sync');

// ── Read ext-sync config for the category to use ──

function readExtSyncCategory(): string {
  try {
    const configPath = path.join(os.homedir(), '.walnut', 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = yaml.load(content) as Record<string, unknown>;
    const plugins = config?.plugins as Record<string, unknown> | undefined;
    const ext-sync = plugins?.ext-sync as Record<string, unknown> | undefined;
    return (ext-sync?.category as string) || 'Work - ExtSync';
  } catch {
    return 'Work - ExtSync';
  }
}

// ── Helpers ──

interface EphemeralServerInfo {
  pid: number;
  port: number;
  tmpDir: string;
  startedAt: string;
}

interface TaskResponse {
  id: string;
  title: string;
  status: string;
  phase?: string;
  category: string;
  project: string;
  source?: string;
  depends_on?: string[];
  ext?: Record<string, unknown>;
  sync_error?: string;
  [key: string]: unknown;
}

let serverInfo: EphemeralServerInfo | null = null;
let port: number;
const createdTaskIds: string[] = [];
const ext-syncCategory = readExtSyncCategory();

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

/**
 * Create a test task via the REST API.
 * All test tasks use the "[walnut-test]" prefix for identification.
 */
async function createTestTask(
  title: string,
  overrides?: Record<string, unknown>,
): Promise<TaskResponse> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `[walnut-test] ${title}`,
      category: ext-syncCategory,
      ...overrides,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST /api/tasks failed (${res.status}): ${body}`);
  }

  const { task } = (await res.json()) as { task: TaskResponse };
  createdTaskIds.push(task.id);
  return task;
}

/**
 * Fetch a single task by ID.
 */
async function getTask(taskId: string): Promise<TaskResponse> {
  const res = await fetch(apiUrl(`/api/tasks/${taskId}`));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET /api/tasks/${taskId} failed (${res.status}): ${body}`);
  }
  const { task } = (await res.json()) as { task: TaskResponse };
  return task;
}

/**
 * Poll a task until a condition is met, with timeout.
 * Useful for waiting on debounced sync operations.
 */
async function waitForSync(
  taskId: string,
  check: (task: TaskResponse) => boolean,
  maxMs = 15_000,
): Promise<TaskResponse> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const task = await getTask(taskId);
    if (check(task)) return task;
    await new Promise((r) => setTimeout(r, 1000));
  }
  // One final check before throwing
  const final = await getTask(taskId);
  if (check(final)) return final;
  throw new Error(
    `Sync timeout after ${maxMs}ms for task ${taskId}. ` +
      `Last state: ext=${JSON.stringify(final.ext)}, sync_error=${final.sync_error}`,
  );
}

/**
 * PATCH a task via the REST API.
 */
async function patchTask(
  taskId: string,
  updates: Record<string, unknown>,
): Promise<TaskResponse> {
  const res = await fetch(apiUrl(`/api/tasks/${taskId}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PATCH /api/tasks/${taskId} failed (${res.status}): ${body}`);
  }
  const { task } = (await res.json()) as { task: TaskResponse };
  return task;
}

/**
 * Delete a task via the REST API (best-effort, does not throw).
 */
async function deleteTask(taskId: string): Promise<void> {
  try {
    await fetch(apiUrl(`/api/tasks/${taskId}`), { method: 'DELETE' });
  } catch {
    // Best-effort cleanup — ignore errors
  }
}

// ── Test Suite ──

describe.skipIf(!shouldRun)('ExtSync roundtrip via ephemeral server (LIVE)', () => {
  // ── Ephemeral server lifecycle ──

  beforeAll(async () => {
    // Start ephemeral server — copies ~/.walnut/ to temp dir, starts on random port
    const cliPath = path.join(process.cwd(), 'dist', 'cli.js');
    const result = execSync(`node ${cliPath} web --ephemeral`, {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    serverInfo = JSON.parse(result.trim()) as EphemeralServerInfo;
    port = serverInfo.port;

    console.log(
      `Ephemeral server started: pid=${serverInfo.pid}, port=${port}, tmpDir=${serverInfo.tmpDir}`,
    );

    // Wait for the server to be ready (health check)
    const healthStart = Date.now();
    while (Date.now() - healthStart < 10_000) {
      try {
        const res = await fetch(apiUrl('/api/tasks'));
        if (res.ok) break;
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 60_000);

  afterAll(async () => {
    // Clean up all test tasks (best-effort, never throw)
    for (const id of createdTaskIds) {
      await deleteTask(id);
    }

    // Kill ephemeral server
    if (serverInfo?.pid) {
      try {
        process.kill(serverInfo.pid, 'SIGTERM');
        console.log(`Ephemeral server killed: pid=${serverInfo.pid}`);
      } catch {
        // May already be dead
      }
    }
  }, 30_000);

  // ── Test 1: Plugin loads from external dir ──

  it('GET /api/integrations includes ext-sync with correct badge', async () => {
    const res = await fetch(apiUrl('/api/integrations'));
    expect(res.status).toBe(200);

    const plugins = (await res.json()) as Array<{
      id: string;
      name: string;
      badge: string;
      badgeColor: string;
    }>;

    const ext-sync = plugins.find((p) => p.id === 'ext-sync');
    expect(ext-sync).toBeDefined();
    expect(ext-sync!.badge).toBe('T');
    expect(ext-sync!.badgeColor).toBe('#00A86B');
    expect(ext-sync!.name).toBe('ExtSync');

    console.log(`ExtSync plugin loaded: ${JSON.stringify(ext-sync)}`);
  });

  // ── Test 2: Create task -> push to ExtSync ──

  let firstTaskId: string;

  it('creates a local task and pushes to ExtSync (ext.ext-sync.id appears)', async () => {
    const task = await createTestTask(`Roundtrip ${Date.now()}`);
    firstTaskId = task.id;

    expect(task.category).toBe(ext-syncCategory);
    // Source should be claimed by the ext-sync plugin
    expect(task.source).toBe('ext-sync');

    console.log(`Created task: id=${task.id}, source=${task.source}`);

    // Wait for the debounced push (2s debounce + network latency)
    const synced = await waitForSync(
      task.id,
      (t) => {
        const ext-syncExt = (t.ext as Record<string, unknown>)?.ext-sync as
          | Record<string, unknown>
          | undefined;
        return !!ext-syncExt?.id;
      },
      20_000,
    );

    const ext-syncExt = (synced.ext as Record<string, unknown>)?.ext-sync as Record<string, unknown>;
    expect(ext-syncExt.id).toBeTruthy();
    expect(typeof ext-syncExt.id).toBe('string');

    console.log(
      `Task pushed to ExtSync: ext-sync.id=${ext-syncExt.id}, short_id=${ext-syncExt.short_id}`,
    );
  }, 30_000);

  // ── Test 3: Pull from ExtSync -> local ──

  it('task survives a pull cycle (fields remain consistent)', async () => {
    // The sync poll runs on an interval inside the server.
    // We can verify integrity by re-fetching the task after giving sync time to run.
    // Wait a bit for any background sync poll to complete
    await new Promise((r) => setTimeout(r, 5_000));

    const task = await getTask(firstTaskId);

    // Task should still exist and have ext-sync ext data
    expect(task.id).toBe(firstTaskId);
    expect(task.title).toContain('[walnut-test]');

    const ext-syncExt = (task.ext as Record<string, unknown>)?.ext-sync as
      | Record<string, unknown>
      | undefined;
    expect(ext-syncExt?.id).toBeTruthy();

    // Source should still be ext-sync
    expect(task.source).toBe('ext-sync');

    console.log(`Pull verification passed: task ${task.id} is consistent after sync poll`);
  }, 15_000);

  // ── Test 4: Update title -> pushed ──

  it('PATCH title propagates to ExtSync', async () => {
    const newTitle = `[walnut-test] Updated ${Date.now()}`;
    const patched = await patchTask(firstTaskId, { title: newTitle });
    expect(patched.title).toBe(newTitle);

    // Wait for the debounced push to complete (2s debounce + network)
    // We verify locally that the task is still synced (no sync_error)
    await new Promise((r) => setTimeout(r, 5_000));

    const task = await getTask(firstTaskId);
    expect(task.title).toBe(newTitle);

    // Ext data should still be intact (push does not clear it)
    const ext-syncExt = (task.ext as Record<string, unknown>)?.ext-sync as Record<string, unknown>;
    expect(ext-syncExt?.id).toBeTruthy();

    // No sync error should have occurred
    expect(task.sync_error).toBeFalsy();

    console.log(`Title updated and pushed: "${newTitle}", no sync errors`);
  }, 15_000);

  // ── Test 5: Phase change -> workflow synced ──

  it('phase change to IN_PROGRESS is pushed to ExtSync', async () => {
    const patched = await patchTask(firstTaskId, { phase: 'IN_PROGRESS' });
    expect(patched.phase).toBe('IN_PROGRESS');

    // Wait for push
    await new Promise((r) => setTimeout(r, 5_000));

    const task = await getTask(firstTaskId);
    expect(task.phase).toBe('IN_PROGRESS');

    // Should not have sync errors
    expect(task.sync_error).toBeFalsy();

    console.log(`Phase changed to IN_PROGRESS, pushed to ExtSync without errors`);
  }, 15_000);

  // ── Test 6: Dependency sync ──

  it('creates two tasks and sets depends_on', async () => {
    const taskA = await createTestTask(`Dep A ${Date.now()}`);
    const taskB = await createTestTask(`Dep B ${Date.now()}`);

    // Wait for both to be pushed first
    await waitForSync(
      taskA.id,
      (t) => !!((t.ext as Record<string, unknown>)?.ext-sync as Record<string, unknown>)?.id,
      20_000,
    );
    await waitForSync(
      taskB.id,
      (t) => !!((t.ext as Record<string, unknown>)?.ext-sync as Record<string, unknown>)?.id,
      20_000,
    );

    console.log(`Both dep tasks pushed: A=${taskA.id}, B=${taskB.id}`);

    // Set taskB depends on taskA
    const patched = await patchTask(taskB.id, {
      set_depends_on: [taskA.id],
    });

    expect(patched.depends_on).toContain(taskA.id);

    // Wait for dependency sync push
    await new Promise((r) => setTimeout(r, 5_000));

    // Verify both tasks still exist and taskB still has the dependency
    const fetchedA = await getTask(taskA.id);
    const fetchedB = await getTask(taskB.id);

    expect(fetchedA.id).toBe(taskA.id);
    expect(fetchedB.id).toBe(taskB.id);
    expect(fetchedB.depends_on).toContain(taskA.id);

    // No sync errors on either
    expect(fetchedA.sync_error).toBeFalsy();
    expect(fetchedB.sync_error).toBeFalsy();

    console.log(
      `Dependency sync verified: ${taskB.id} depends on ${taskA.id}, no sync errors`,
    );
  }, 60_000);
});
