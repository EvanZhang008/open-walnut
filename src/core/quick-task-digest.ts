import { getStoreProjects, listTasksSlim, getProjectMetadata } from './task-manager.js';

const MAX_PROJECTS = 20;
const MAX_TITLES_PER_LINE = 3;
const MAX_TITLE_CHARS = 40;
const MAX_DIGEST_CHARS = 4000;
const MAX_SUMMARY_CHARS = 200;

/** Inbox is rendered under this label; it is NOT a selectable project name. */
export const INBOX_LABEL = 'Inbox';

export interface ProjectDigest {
  digest: string;
  /** Canonical project names the model may pick from. Never includes Inbox. */
  projects: string[];
}

interface ProjectDetails {
  name: string;
  openCount: number;
  titles: string[];
}

function truncateTitle(title: string): string {
  return Array.from(title).slice(0, MAX_TITLE_CHARS).join('');
}

function addTitle(titles: string[], title: string): void {
  if (titles.length < MAX_TITLES_PER_LINE) titles.push(truncateTitle(title));
}

function appendTitles(prefix: string, titles: string[]): string {
  return titles.length > 0
    ? `${prefix}: ${titles.map((title) => `"${title}"`).join('; ')}`
    : prefix;
}

function capDigest(lines: string[]): string {
  const output: string[] = [];
  for (const line of lines) {
    const candidate = [...output, line].join('\n');
    if (candidate.length > MAX_DIGEST_CHARS) {
      while (output.length > 0 && `${output.join('\n')}\n…`.length > MAX_DIGEST_CHARS) {
        output.pop();
      }
      output.push('…');
      break;
    }
    output.push(line);
  }
  return output.join('\n');
}

/**
 * Flat project digest for the fast-model placement prompts (quick-task parse,
 * session-organize): one line per project — name, open count, up to 3 example
 * titles, plus the maintained project summary when present.
 *
 * Inbox (tasks with no project) is rendered LAST and is deliberately absent from
 * `projects`: it's the default, never something the model "picks".
 */
export async function buildProjectDigest(): Promise<ProjectDigest> {
  // Both calls share task-manager initialization; keep them sequential so the
  // first cold request cannot race the project seeding transaction.
  const storeProjects = await getStoreProjects();
  const tasks = await listTasksSlim({ minimal: true });

  const projects: string[] = [];
  const canonicalNames = new Map<string, string>();
  const detailsByProject = new Map<string, ProjectDetails>();

  const ensureProjectEntry = (rawName: string): ProjectDetails => {
    const name = rawName.trim();
    const key = name.toLowerCase();
    const canonical = canonicalNames.get(key) ?? name;
    if (!canonicalNames.has(key)) {
      canonicalNames.set(key, canonical);
      projects.push(canonical);
    }
    let details = detailsByProject.get(canonical);
    if (!details) {
      details = { name: canonical, openCount: 0, titles: [] };
      detailsByProject.set(canonical, details);
    }
    return details;
  };

  // Registry rows first, so a claimed-but-quiet project still gets listed with
  // its canonical spelling (the registry is the source of truth for spelling).
  for (const name of Object.keys(storeProjects)) {
    if (name.trim()) ensureProjectEntry(name);
  }

  const inbox: ProjectDetails = { name: INBOX_LABEL, openCount: 0, titles: [] };

  for (const task of tasks) {
    if (task.title.startsWith('.metadata')) continue;
    const name = task.project?.trim();
    const details = name ? ensureProjectEntry(name) : inbox;
    if (task.phase !== 'COMPLETE') details.openCount += 1;
    addTitle(details.titles, task.title);
  }

  const ordered = [...detailsByProject.values()]
    .sort((a, b) => b.openCount - a.openCount || a.name.localeCompare(b.name))
    .slice(0, MAX_PROJECTS);

  const lines: string[] = [];
  for (const project of ordered) {
    lines.push(appendTitles(`- ${project.name} (${project.openCount} open tasks)`, project.titles));
    // The maintained project summary (project-summary.ts) beats raw titles
    // for "does this note/session belong here?" judgment — ride it along.
    try {
      const meta = await getProjectMetadata(project.name);
      const summary = typeof meta?.summary === 'string' ? meta.summary.trim() : '';
      if (summary) {
        lines.push(`  about: ${Array.from(summary).slice(0, MAX_SUMMARY_CHARS).join('')}`);
      }
    } catch { /* summary is enrichment only — digest works without it */ }
  }
  if (inbox.openCount > 0) {
    lines.push(appendTitles(`- ${INBOX_LABEL} — no project (${inbox.openCount} open tasks)`, inbox.titles));
  }

  return { digest: capDigest(lines), projects };
}
