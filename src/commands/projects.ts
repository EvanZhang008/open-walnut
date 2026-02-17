import chalk from 'chalk';
import { listTasks } from '../core/task-manager.js';
import { listMemories } from '../core/memory.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';

interface ProjectInfo {
  name: string;
  taskCount: number;
  activeTasks: number;
  doneTasks: number;
  sessions: string[];
  memoryFiles: string[];
}

export async function runProjects(globals: GlobalOptions): Promise<void> {
  const tasks = await listTasks();
  const projectMap = new Map<string, ProjectInfo>();

  for (const task of tasks) {
    const name = task.project ?? '(none)';
    let info = projectMap.get(name);
    if (!info) {
      info = {
        name,
        taskCount: 0,
        activeTasks: 0,
        doneTasks: 0,
        sessions: [],
        memoryFiles: [],
      };
      projectMap.set(name, info);
    }
    info.taskCount++;
    if (task.status === 'done') {
      info.doneTasks++;
    } else {
      info.activeTasks++;
    }
    for (const sid of task.session_ids) {
      if (!info.sessions.includes(sid)) {
        info.sessions.push(sid);
      }
    }
  }

  // Add project memory files
  const projectMemories = listMemories('project');
  for (const mem of projectMemories) {
    const name = mem.title;
    let info = projectMap.get(name);
    if (!info) {
      info = {
        name,
        taskCount: 0,
        activeTasks: 0,
        doneTasks: 0,
        sessions: [],
        memoryFiles: [],
      };
      projectMap.set(name, info);
    }
    info.memoryFiles.push(mem.path);
  }

  const projects = Array.from(projectMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  if (globals.json) {
    outputJson(projects);
    return;
  }

  if (projects.length === 0) {
    console.log(chalk.dim('No projects found.'));
    return;
  }

  for (const p of projects) {
    console.log(`  ${chalk.bold(p.name)}`);
    console.log(
      `    Tasks: ${p.taskCount} total, ${chalk.green(String(p.activeTasks) + ' active')}, ${chalk.dim(String(p.doneTasks) + ' done')}`,
    );
    if (p.sessions.length > 0) {
      console.log(`    Sessions: ${p.sessions.length}`);
    }
    if (p.memoryFiles.length > 0) {
      for (const f of p.memoryFiles) {
        console.log(`    ${chalk.dim(f)}`);
      }
    }
    console.log();
  }
}
