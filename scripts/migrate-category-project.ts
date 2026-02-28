#!/usr/bin/env npx tsx
/**
 * One-time migration: split task.category ("Work / HomeLab") into
 * task.category = "Work" and task.project = "HomeLab".
 *
 * Usage: npx tsx scripts/migrate-category-project.ts
 *
 * Safe to run multiple times — already-migrated tasks (those without " / "
 * in category and with a project field) are left unchanged.
 */
import fs from 'node:fs';
import path from 'node:path';

const WALNUT_HOME = process.env.WALNUT_HOME ?? path.join(process.env.HOME ?? '', '.walnut'); // safe: production-path
const TASKS_FILE = path.join(WALNUT_HOME, 'tasks.json');

interface TaskStore {
  version: number;
  tasks: Array<{
    category: string;
    project?: string;
    [key: string]: unknown;
  }>;
}

function parseGroupFromCategory(category: string): { group: string; listName: string } {
  const sep = ' / ';
  const idx = category.indexOf(sep);
  if (idx === -1) {
    return { group: category, listName: category };
  }
  return {
    group: category.slice(0, idx),
    listName: category.slice(idx + sep.length),
  };
}

function main(): void {
  if (!fs.existsSync(TASKS_FILE)) {
    console.log('No tasks.json found at', TASKS_FILE);
    process.exit(0);
  }

  const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
  const store: TaskStore = JSON.parse(raw);

  let migrated = 0;
  for (const task of store.tasks) {
    const { group, listName } = parseGroupFromCategory(task.category);
    const oldCategory = task.category;
    task.category = group;
    task.project = listName;
    if (oldCategory !== group || !task.project) {
      migrated++;
    }
  }

  // Write back
  fs.writeFileSync(TASKS_FILE, JSON.stringify(store, null, 2) + '\n');
  console.log(`Migrated ${migrated} of ${store.tasks.length} tasks.`);
  console.log(`Tasks file: ${TASKS_FILE}`);
}

main();
