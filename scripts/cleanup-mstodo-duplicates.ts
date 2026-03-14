#!/usr/bin/env npx tsx
/**
 * Cleanup script: delete duplicate MS To-Do tasks.
 *
 * For each MS To-Do list, groups tasks by title (case-insensitive).
 * For groups with >1 item, keeps the most recently modified and deletes the rest.
 * Then reconciles local ext['ms-todo'].id to point to the surviving remote item.
 *
 * Usage:
 *   npx tsx scripts/cleanup-mstodo-duplicates.ts --dry-run   # Preview only
 *   npx tsx scripts/cleanup-mstodo-duplicates.ts              # Actually delete
 */

import path from 'node:path';

// Resolve WALNUT_HOME before importing anything
const WALNUT_HOME = process.env.OPEN_WALNUT_HOME ?? path.join(process.env.HOME!, '.open-walnut');
const TASKS_FILE = path.join(WALNUT_HOME, 'tasks', 'tasks.json');

// Guard: refuse to run in a test environment against production data
const isTestEnv = !!(process.env.VITEST || process.env.VITEST_WORKER_ID || process.env.NODE_ENV === 'test');
if (isTestEnv && WALNUT_HOME === path.join(process.env.HOME!, '.open-walnut')) {
  console.error('SAFETY: refusing to run cleanup script against production ~/.open-walnut/ in test environment');
  process.exit(1);
}

interface MSTodoTask {
  id: string;
  title: string;
  status: string;
  lastModifiedDateTime: string;
  createdDateTime: string;
}

interface MSTodoList {
  id: string;
  displayName: string;
}

interface LocalTask {
  id: string;
  title: string;
  source: string;
  ext?: Record<string, unknown>;
  [key: string]: unknown;
}

interface TaskStore {
  version: number;
  tasks: LocalTask[];
  [key: string]: unknown;
}

const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`\n=== MS To-Do Duplicate Cleanup ${dryRun ? '(DRY RUN)' : '(LIVE)'} ===\n`);

  // 1. Load auth token
  const { getAccessToken, graphRequest } = await import('../src/integrations/microsoft-todo.js');
  const token = await getAccessToken();
  console.log('✓ Authenticated with MS Graph');

  // 2. Fetch all lists
  const listsResp = await graphRequest<{ value: MSTodoList[] }>(token, 'GET', '/me/todo/lists');
  const lists = listsResp.value;
  console.log(`✓ Found ${lists.length} lists`);

  let totalDeleted = 0;
  let totalKept = 0;
  const survivorMap = new Map<string, { listId: string; taskId: string }>(); // title-key → surviving remote

  // 3. For each list, fetch all tasks and find duplicates
  for (const list of lists) {
    // Fetch all tasks in this list (paginate)
    let allTasks: MSTodoTask[] = [];
    let nextLink: string | undefined = `/me/todo/lists/${list.id}/tasks?$top=100`;

    while (nextLink) {
      const resp = await graphRequest<{ value: MSTodoTask[]; '@odata.nextLink'?: string }>(
        token, 'GET', nextLink,
      );
      allTasks = allTasks.concat(resp.value);
      nextLink = resp['@odata.nextLink'];
    }

    if (allTasks.length === 0) continue;

    // Group by title (case-insensitive)
    const groups = new Map<string, MSTodoTask[]>();
    for (const task of allTasks) {
      const key = task.title.toLowerCase().trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(task);
    }

    // Find groups with duplicates
    let listDupes = 0;
    for (const [key, tasks] of groups) {
      if (tasks.length <= 1) {
        // No duplicate — record survivor for reconciliation
        survivorMap.set(`${list.id}::${key}`, { listId: list.id, taskId: tasks[0].id });
        continue;
      }

      // Sort by lastModifiedDateTime desc — keep the most recently modified
      tasks.sort((a, b) =>
        new Date(b.lastModifiedDateTime).getTime() - new Date(a.lastModifiedDateTime).getTime(),
      );

      const [survivor, ...toDelete] = tasks;
      survivorMap.set(`${list.id}::${key}`, { listId: list.id, taskId: survivor.id });

      console.log(`\n  [${list.displayName}] "${survivor.title}" — ${tasks.length} copies, deleting ${toDelete.length}`);
      console.log(`    Keep: ${survivor.id} (modified ${survivor.lastModifiedDateTime})`);

      for (const dup of toDelete) {
        console.log(`    Delete: ${dup.id} (modified ${dup.lastModifiedDateTime})`);
        if (!dryRun) {
          try {
            await graphRequest<Record<string, never>>(
              token, 'DELETE', `/me/todo/lists/${list.id}/tasks/${dup.id}`,
            );
          } catch (err) {
            console.error(`    ✗ Failed to delete ${dup.id}: ${err instanceof Error ? err.message : err}`);
          }
        }
        totalDeleted++;
      }
      totalKept++;
      listDupes += toDelete.length;
    }

    if (listDupes > 0) {
      console.log(`  [${list.displayName}] total: ${allTasks.length} tasks, ${listDupes} duplicates ${dryRun ? 'would be' : ''} deleted`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Groups with duplicates: ${totalKept}`);
  console.log(`Duplicates ${dryRun ? 'to delete' : 'deleted'}: ${totalDeleted}`);

  // 4. Reconcile local tasks — point ext['ms-todo'].id to the surviving remote item
  if (!dryRun && totalDeleted > 0) {
    console.log('\nReconciling local task store...');
    const { readJsonFile, writeJsonFile } = await import('../src/utils/fs.js');
    const store = await readJsonFile<TaskStore>(TASKS_FILE, { version: 1, tasks: [] });
    let reconciled = 0;

    for (const task of store.tasks) {
      if (task.source !== 'ms-todo') continue;
      const msExt = task.ext?.['ms-todo'] as Record<string, unknown> | undefined;
      if (!msExt?.id) continue;

      const listId = (msExt.list_id ?? msExt.list) as string | undefined;
      if (!listId) continue;

      const key = `${listId}::${task.title.toLowerCase().trim()}`;
      const survivor = survivorMap.get(key);
      if (survivor && survivor.taskId !== msExt.id) {
        console.log(`  Reconcile: "${task.title}" — ${msExt.id} → ${survivor.taskId}`);
        msExt.id = survivor.taskId;
        msExt.list_id = survivor.listId;
        reconciled++;
      }
    }

    if (reconciled > 0) {
      await writeJsonFile(TASKS_FILE, store);
      console.log(`✓ Reconciled ${reconciled} local tasks`);
    } else {
      console.log('No local reconciliation needed');
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
