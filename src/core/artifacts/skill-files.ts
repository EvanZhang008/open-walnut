/**
 * A skill as a file: `<skills dir>/<name>/SKILL.md`, the common format Claude Code and Codex read
 * (front matter, then the text). Walnut's fields sit in the front matter, each value a JSON string
 * (valid YAML too), so a description with a colon or a quote reads back the same; a value a person
 * typed bare is taken as it is. The folder's name is the skill's name.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeTextFile } from '../../utils/fs.js';

export interface SkillFile {
  name: string;
  description: string;
  text: string;
  at: string;
  by?: string;
  by_name?: string;
}

const FIELDS = ['description', 'at', 'by', 'by_name'] as const;

export function renderSkillFile(s: SkillFile, scope: 'own' | 'org'): string {
  const head = [
    `name: ${JSON.stringify(s.name)}`,
    ...FIELDS.filter((k) => s[k] !== undefined).map((k) => `${k}: ${JSON.stringify(s[k])}`),
    `kind: "skill"`,
    `scope: ${JSON.stringify(scope)}`,
  ];
  return `---\n${head.join('\n')}\n---\n\n${s.text.trim()}\n`;
}

function value(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try { const s = JSON.parse(v); if (typeof s === 'string') return s; } catch { /* a bare value */ }
  }
  return v.replace(/^'(.*)'$/, '$1');
}

/** One SKILL.md read back, or null when it has no description (not a skill Walnut can list). Pure. */
export function parseSkillFile(name: string, text: string, fallbackAt: string): SkillFile | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields: Record<string, string> = {};
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const kv = /^([a-z_]+):\s?(.*)$/.exec(line);
    if (kv) fields[kv[1]] = value(kv[2]);
  }
  const body = (m ? m[2] : text).trim();
  if (!fields.description || !body) return null;
  return {
    name, description: fields.description.replace(/\s+/g, ' ').trim(), text: body, at: fields.at || fallbackAt,
    ...(fields.by ? { by: fields.by } : {}), ...(fields.by_name ? { by_name: fields.by_name } : {}),
  };
}

/**
 * Written after a scope's change: the release before this one reads a scope's folder only when it
 * holds this mark (it reads its old JSON file otherwise), so a folder this release wrote reads the
 * same there after a roll back.
 */
const MOVED_MARK = '.moved';

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * Every skill of a folder, by name; null when there is no folder. Any error but a missing file
 * throws, so a read that fails for a moment (too many open files, a permission) never reads as
 * fewer skills, which a write would then make true. A folder of a name with no SKILL.md, or one
 * without a description, is no skill.
 */
export async function readSkillDir(dir: string, nameRe: RegExp): Promise<SkillFile[] | null> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
  const out: SkillFile[] = [];
  for (const name of names.filter((n) => nameRe.test(n)).sort()) {
    const file = path.join(dir, name, 'SKILL.md');
    let text: string;
    let at: string;
    try {
      [text, at] = await Promise.all([fsp.readFile(file, 'utf-8'), fsp.stat(file).then((st) => st.mtime.toISOString())]);
    } catch (err) {
      if (missing(err)) continue;
      throw err;
    }
    const skill = parseSkillFile(name, text, at);
    if (skill) out.push(skill);
  }
  return out;
}

/** Mark a scope's folder for the release before (MOVED_MARK). */
export async function markSkillDirMoved(dir: string): Promise<void> {
  await writeTextFile(path.join(dir, MOVED_MARK), `${new Date().toISOString()}\n`);
}

export async function writeSkillFile(dir: string, s: SkillFile, scope: 'own' | 'org'): Promise<void> {
  await writeTextFile(path.join(dir, s.name, 'SKILL.md'), renderSkillFile(s, scope));
}

export async function removeSkillFile(dir: string, name: string): Promise<void> {
  await fsp.rm(path.join(dir, name), { recursive: true, force: true });
}
