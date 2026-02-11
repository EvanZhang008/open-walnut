import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { PROJECTS_MEMORY_DIR } from '../constants.js';
import { formatDateKey } from './daily-log.js';

export interface ProjectMemoryHeader {
  name: string;
  description: string;
}

export interface ProjectMemoryLog {
  date: string;
  time: string;
  source: string;
  projectPath?: string;
  content: string;
}

export interface ParsedProjectMemory {
  name: string;
  description: string;
  logs: ProjectMemoryLog[];
}

export interface ProjectSummary {
  path: string;
  name: string;
  description: string;
}

export interface AppendResult {
  summary: ProjectMemoryHeader;
  tail: string[];
  parentSummaries: ProjectSummary[];
}

const DEFAULT_TEMPLATE = `---
name: Unnamed Project
description: ''
---
`;

/**
 * Parse a project MEMORY.md file into structured data.
 */
export function parseProjectMemory(content: string): ParsedProjectMemory {
  let name = 'Unnamed Project';
  let description = '';
  const logs: ProjectMemoryLog[] = [];

  // Extract YAML frontmatter between first --- pair
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    try {
      const parsed = yaml.load(fmMatch[1]) as Record<string, unknown> | null;
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.name === 'string') name = parsed.name;
        if (typeof parsed.description === 'string') description = parsed.description;
      }
    } catch {
      // Invalid YAML, use defaults
    }
  }

  // Parse log entries: split on ## headings
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;
  const sections = body.split(/^## /m).filter((s) => s.trim());

  for (const section of sections) {
    // Expected format: YYYY-MM-DD HH:MM — source [projectPath]\ncontent
    const headerEnd = section.indexOf('\n');
    if (headerEnd === -1) continue;

    const header = section.slice(0, headerEnd).trim();
    const logContent = section.slice(headerEnd + 1).trim();

    // Parse: "2025-01-15 14:30 — session [work/api]"
    const match = header.match(
      /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*—\s*(\S+)(?:\s+\[([^\]]+)\])?$/,
    );
    if (match) {
      logs.push({
        date: match[1],
        time: match[2],
        source: match[3],
        projectPath: match[4] || undefined,
        content: logContent,
      });
    }
  }

  return { name, description, logs };
}

/**
 * Ensure the project directory and MEMORY.md exist.
 * Validates max 3 levels of nesting.
 */
export function ensureProjectDir(projectPath: string): void {
  const parts = projectPath.split('/').filter(Boolean);
  if (parts.length > 3) {
    throw new Error(`Project path "${projectPath}" exceeds max depth of 3 levels.`);
  }

  const dirPath = path.join(PROJECTS_MEMORY_DIR, projectPath);
  fs.mkdirSync(dirPath, { recursive: true });

  const memFile = path.join(dirPath, 'MEMORY.md');
  if (!fs.existsSync(memFile)) {
    fs.writeFileSync(memFile, DEFAULT_TEMPLATE, 'utf-8');
  }
}

/**
 * Append a log entry to a project's MEMORY.md.
 */
export function appendProjectMemory(
  projectPath: string,
  content: string,
  source?: string,
): AppendResult {
  ensureProjectDir(projectPath);

  const dirPath = path.join(PROJECTS_MEMORY_DIR, projectPath);
  const memFile = path.join(dirPath, 'MEMORY.md');

  const now = new Date();
  const dateKey = formatDateKey(now);
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const time = `${hours}:${minutes}`;
  const sourceLabel = source ?? 'unknown';

  const entry = `## ${dateKey} ${time} — ${sourceLabel} [${projectPath}]\n${content}\n\n`;
  fs.appendFileSync(memFile, entry, 'utf-8');

  // Read back to get summary and tail
  const fullContent = fs.readFileSync(memFile, 'utf-8');
  const parsed = parseProjectMemory(fullContent);

  const tail = parsed.logs
    .slice(-5)
    .map((l) => l.content);

  const parentSummaries = getParentSummaries(projectPath);

  return {
    summary: { name: parsed.name, description: parsed.description },
    tail,
    parentSummaries,
  };
}

/**
 * Rewrite the YAML frontmatter of a project MEMORY.md, preserving all log entries.
 */
export function updateProjectSummary(
  projectPath: string,
  name: string,
  description: string,
): { parentSummaries: ProjectSummary[] } {
  ensureProjectDir(projectPath);

  const dirPath = path.join(PROJECTS_MEMORY_DIR, projectPath);
  const memFile = path.join(dirPath, 'MEMORY.md');

  const existing = fs.readFileSync(memFile, 'utf-8');

  // Remove existing frontmatter
  const fmMatch = existing.match(/^---\n[\s\S]*?\n---\n?/);
  const body = fmMatch ? existing.slice(fmMatch[0].length) : existing;

  const newFrontmatter = `---\n${yaml.dump({ name, description }, { lineWidth: -1 })}---\n`;
  fs.writeFileSync(memFile, newFrontmatter + body, 'utf-8');

  return { parentSummaries: getParentSummaries(projectPath) };
}

/**
 * Walk up the project path reading each ancestor MEMORY.md header.
 */
export function getParentSummaries(projectPath: string): ProjectSummary[] {
  const parts = projectPath.split('/').filter(Boolean);
  const summaries: ProjectSummary[] = [];

  // Walk from root to parent (exclude the project itself)
  for (let i = 1; i < parts.length; i++) {
    const ancestorPath = parts.slice(0, i).join('/');
    const header = getProjectSummary(ancestorPath);
    if (header) {
      summaries.push({
        path: ancestorPath,
        name: header.name,
        description: header.description,
      });
    }
  }

  return summaries;
}

/**
 * Read a single project's MEMORY.md header (name + description).
 */
export function getProjectSummary(projectPath: string): ProjectMemoryHeader | null {
  const memFile = path.join(PROJECTS_MEMORY_DIR, projectPath, 'MEMORY.md');
  try {
    const content = fs.readFileSync(memFile, 'utf-8');
    const parsed = parseProjectMemory(content);
    return { name: parsed.name, description: parsed.description };
  } catch {
    return null;
  }
}

/**
 * Recursively find all MEMORY.md files under PROJECTS_MEMORY_DIR and extract summaries.
 */
export function getAllProjectSummaries(): ProjectSummary[] {
  const summaries: ProjectSummary[] = [];

  function walk(dir: string, prefix: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const memFile = path.join(dir, entry.name, 'MEMORY.md');
        try {
          const content = fs.readFileSync(memFile, 'utf-8');
          const parsed = parseProjectMemory(content);
          summaries.push({
            path: subPath,
            name: parsed.name,
            description: parsed.description,
          });
        } catch {
          // No MEMORY.md in this directory
        }
        walk(path.join(dir, entry.name), subPath);
      }
    }
  }

  walk(PROJECTS_MEMORY_DIR, '');
  return summaries;
}

/**
 * Get the full content of a project's MEMORY.md.
 */
export function getProjectMemory(projectPath: string): string | null {
  const memFile = path.join(PROJECTS_MEMORY_DIR, projectPath, 'MEMORY.md');
  try {
    return fs.readFileSync(memFile, 'utf-8');
  } catch {
    return null;
  }
}
