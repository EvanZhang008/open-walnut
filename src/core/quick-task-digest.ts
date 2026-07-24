import { getStoreCategories, listTasksSlim } from './task-manager.js';

const MAX_CATEGORIES = 15;
const MAX_PROJECTS_PER_CATEGORY = 4;
const MAX_TITLES_PER_LINE = 3;
const MAX_TITLE_CHARS = 40;
const MAX_DIGEST_CHARS = 4000;

export interface CategoryDigest {
  digest: string;
  categories: string[];
  projectsByCategory: Record<string, string[]>;
}

interface CategoryDetails {
  name: string;
  openCount: number;
  defaultTitles: string[];
  projectTitles: Map<string, string[]>;
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

export async function buildCategoryDigest(): Promise<CategoryDigest> {
  // Both calls share task-manager initialization; keep them sequential so the
  // first cold request cannot race the category seeding transaction.
  const storeCategories = await getStoreCategories();
  const tasks = await listTasksSlim({ minimal: true });

  const categories: string[] = [];
  const canonicalCategories = new Map<string, string>();
  const detailsByCategory = new Map<string, CategoryDetails>();
  const allProjects = new Map<string, Map<string, string>>();

  const ensureCategory = (rawName: string): CategoryDetails => {
    const name = rawName.trim();
    const key = name.toLowerCase();
    const canonical = canonicalCategories.get(key) ?? name;
    if (!canonicalCategories.has(key)) {
      canonicalCategories.set(key, canonical);
      categories.push(canonical);
      allProjects.set(canonical, new Map());
    }
    let details = detailsByCategory.get(canonical);
    if (!details) {
      details = { name: canonical, openCount: 0, defaultTitles: [], projectTitles: new Map() };
      detailsByCategory.set(canonical, details);
    }
    return details;
  };

  for (const category of Object.keys(storeCategories)) {
    if (category.trim()) ensureCategory(category);
  }

  for (const task of tasks) {
    if (!task.category?.trim() || task.title.startsWith('.metadata')) continue;
    const category = ensureCategory(task.category);
    if (task.phase !== 'COMPLETE') category.openCount += 1;

    const project = task.project?.trim();
    const isDefaultProject = !project || project.toLowerCase() === category.name.toLowerCase();
    if (isDefaultProject) {
      addTitle(category.defaultTitles, task.title);
      continue;
    }

    const projects = allProjects.get(category.name)!;
    const projectKey = project.toLowerCase();
    const canonicalProject = projects.get(projectKey) ?? project;
    if (!projects.has(projectKey)) projects.set(projectKey, canonicalProject);

    let titles = category.projectTitles.get(canonicalProject);
    if (!titles && category.projectTitles.size < MAX_PROJECTS_PER_CATEGORY) {
      titles = [];
      category.projectTitles.set(canonicalProject, titles);
    }
    if (titles) addTitle(titles, task.title);
  }

  const projectsByCategory: Record<string, string[]> = {};
  for (const category of categories) {
    projectsByCategory[category] = [...(allProjects.get(category)?.values() ?? [])];
  }

  const ordered = [...detailsByCategory.values()]
    .sort((a, b) => b.openCount - a.openCount)
    .slice(0, MAX_CATEGORIES);
  const lines: string[] = [];
  for (const category of ordered) {
    lines.push(appendTitles(`- ${category.name} (${category.openCount} open tasks)`, category.defaultTitles));
    for (const [project, titles] of category.projectTitles) {
      lines.push(appendTitles(`  - ${project}`, titles));
    }
  }

  return { digest: capDigest(lines), categories, projectsByCategory };
}
