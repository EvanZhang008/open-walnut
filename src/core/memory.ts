import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, SESSIONS_DIR, PROJECTS_DIR } from '../constants.js';

export interface MemoryEntry {
  path: string;
  title: string;
  category: 'session' | 'project' | 'knowledge';
  content: string;
  createdAt: string;
  updatedAt: string;
}

const KNOWLEDGE_DIR = path.join(MEMORY_DIR, 'knowledge');

const CATEGORY_DIRS: Record<string, string> = {
  session: SESSIONS_DIR,
  project: PROJECTS_DIR,
  knowledge: KNOWLEDGE_DIR,
};

function ensureDirSync(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function getMemoryPath(category: string, slug: string): string {
  const base = CATEGORY_DIRS[category] ?? path.join(MEMORY_DIR, category);
  return path.join(base, `${slug}.md`);
}

function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return filename.replace(/\.md$/, '');
}

function resolveCategory(relativePath: string): 'session' | 'project' | 'knowledge' {
  if (relativePath.startsWith('sessions/')) return 'session';
  if (relativePath.startsWith('projects/')) return 'project';
  if (relativePath.startsWith('knowledge/')) return 'knowledge';
  return 'knowledge';
}

export function saveMemory(category: string, slug: string, content: string): string {
  const filePath = getMemoryPath(category, slug);
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function getMemory(relativePath: string): MemoryEntry | null {
  const fullPath = path.join(MEMORY_DIR, relativePath);
  try {
    const content = fs.readFileSync(fullPath, 'utf-8');
    const stat = fs.statSync(fullPath);
    return {
      path: relativePath,
      title: extractTitle(content, path.basename(fullPath)),
      category: resolveCategory(relativePath),
      content,
      createdAt: stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function collectMarkdownFiles(dir: string, prefix: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(rel);
    }
  }
  return results;
}

export function listMemories(category?: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  let searchDirs: { dir: string; prefix: string }[];
  if (category) {
    const base = CATEGORY_DIRS[category];
    if (!base) return entries;
    const prefixMap: Record<string, string> = {
      session: 'sessions',
      project: 'projects',
      knowledge: 'knowledge',
    };
    searchDirs = [{ dir: base, prefix: prefixMap[category] ?? category }];
  } else {
    searchDirs = [
      { dir: SESSIONS_DIR, prefix: 'sessions' },
      { dir: PROJECTS_DIR, prefix: 'projects' },
      { dir: KNOWLEDGE_DIR, prefix: 'knowledge' },
    ];
  }

  for (const { dir, prefix } of searchDirs) {
    const files = collectMarkdownFiles(dir, prefix);
    for (const relativePath of files) {
      const entry = getMemory(relativePath);
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

export function getRecentMemories(limit: number = 10): MemoryEntry[] {
  const all = listMemories();
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return all.slice(0, limit);
}

export function deleteMemory(relativePath: string): boolean {
  const fullPath = path.join(MEMORY_DIR, relativePath);
  try {
    fs.unlinkSync(fullPath);
    return true;
  } catch {
    return false;
  }
}
