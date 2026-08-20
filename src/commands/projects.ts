import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiGet, reportApiError } from '../utils/api-client.js';
import { requireDirectRunners } from './direct-registry.js';
import type { GlobalOptions } from '../core/types.js';

export interface ProjectInfo {
  name: string;
  taskCount: number;
  activeTasks: number;
  doneTasks: number;
  sessions: string[];
  /** Absent on the HTTP path — no v1 endpoint carries project memory files. */
  memoryFiles?: string[];
}

/** buildProjectsPayload's shape (src/web/routes/projects.ts). */
interface ProjectsPayload {
  projects: Array<{
    name: string;
    source?: string;
    favorite?: boolean;
    counts: { todo: number; active: number; done: number };
  }>;
  inbox: { counts: { todo: number; active: number; done: number } };
}

/** ProjectedSession fields this command needs (src/core/session-projection.ts). */
interface ProjectedSessionSlim {
  id: string;
  project?: string;
}

export async function runProjects(globals: GlobalOptions): Promise<void> {
  if (process.env.WALNUT_CLI_DIRECT === '1') {
    // In-process legacy path, installed only by the full CLI entry — see
    // direct-registry.ts.
    await requireDirectRunners().projects(globals);
    return;
  }

  try {
    const payload = await apiGet<ProjectsPayload>('/api/v1/projects');
    // The registry payload has no session linkage — join it in from the
    // sessions projection so the "Sessions: N" line the CLI has always printed
    // stays real. Best-effort: a projection hiccup degrades to no session
    // lines, never to a failed `projects` command.
    const sessionsByProject = new Map<string, string[]>();
    try {
      const { sessions } = await apiGet<{ sessions: ProjectedSessionSlim[] }>('/api/v1/sessions');
      for (const s of sessions) {
        if (!s.project) continue;
        const list = sessionsByProject.get(s.project) ?? [];
        list.push(s.id);
        sessionsByProject.set(s.project, list);
      }
    } catch { /* degrade: counts only */ }

    // Map the registry payload onto the CLI's long-standing shape. `counts`
    // splits open work into todo+active, which the CLI has always shown as one
    // "active" number. memoryFiles is deliberately ABSENT here (not an empty
    // array): the v1 surface has no project-memory endpoint, and a
    // shape-preserving lie is worse than a missing field.
    const rows = [...payload.projects];
    // Inbox has no registry row, so the payload carries its counts separately.
    // Listed under the CLI's historical "no project" placeholder, and only when
    // it actually holds tasks (an empty store must still print nothing).
    const inbox = payload.inbox.counts;
    if (inbox.todo + inbox.active + inbox.done > 0) {
      rows.push({ name: '(none)', counts: inbox });
    }
    const projects: ProjectInfo[] = rows
      .map((p) => ({
        name: p.name,
        taskCount: p.counts.todo + p.counts.active + p.counts.done,
        activeTasks: p.counts.todo + p.counts.active,
        doneTasks: p.counts.done,
        sessions: sessionsByProject.get(p.name) ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    printProjects(projects, globals);
  } catch (err) {
    reportApiError(err, globals);
  }
}

export function printProjects(projects: ProjectInfo[], globals: GlobalOptions): void {
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
    if (p.memoryFiles && p.memoryFiles.length > 0) {
      for (const f of p.memoryFiles) {
        console.log(`    ${chalk.dim(f)}`);
      }
    }
    console.log();
  }
}

// The WALNUT_CLI_DIRECT=1 implementation lives in direct-commands.ts.
