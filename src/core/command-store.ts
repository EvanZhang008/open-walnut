/**
 * Core CRUD for markdown-based slash commands.
 *
 * Two storage layers:
 *   1. Built-in commands — shipped in dist/data/slash-commands/*.md (read-only)
 *   2. User commands    — stored in ~/.open-walnut/commands/*.md (read-write)
 *
 * Lookup: user dir first, then built-in. User commands override built-in by name.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { COMMANDS_DIR, BUILTIN_COMMANDS_DIR } from '../constants.js';

async function ensureCommandsDir(): Promise<void> {
  await fsp.mkdir(COMMANDS_DIR, { recursive: true });
}

export interface CommandDef {
  name: string;
  description: string;
  content: string;
  source: 'builtin' | 'user';
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Names reserved by hardcoded frontend commands — cannot be used for .md commands. */
const RESERVED_NAMES = new Set([
  'compact', 'help', 'plan', 'check-tasks', 'sessions', 'tasks',
]);

// ─── helpers ──────────────────────────────────────────────────────

function validateName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
    throw new Error(`Invalid command name: must be 1-64 characters.`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid command name "${name}". Must match ${NAME_PATTERN} (lowercase slug).`);
  }
  if (RESERVED_NAMES.has(name)) {
    throw new Error(`Command name "${name}" is reserved by a hardcoded frontend command.`);
  }
}

function toFilename(name: string): string {
  return `${name}.md`;
}

function nameFromFile(filename: string): string | null {
  if (!filename.endsWith('.md')) return null;
  return filename.slice(0, -3);
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

async function readCommandFile(filePath: string, source: 'builtin' | 'user'): Promise<CommandDef | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const name = nameFromFile(path.basename(filePath));
    if (!name) return null;
    const { frontmatter, body } = parseFrontmatter(raw);
    return {
      name,
      description: (frontmatter.description as string) ?? '',
      content: body,
      source,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function serializeCommand(content: string, description?: string): string {
  if (description) {
    const fm = yaml.dump({ description }, { lineWidth: -1 }).trimEnd();
    return `---\n${fm}\n---\n${content}\n`;
  }
  return `${content}\n`;
}

// ─── public API ──────────────────────────────────────────────────

/**
 * List all commands. User commands override built-in by name. Sorted by name.
 */
export async function listCommands(): Promise<CommandDef[]> {
  const seen = new Map<string, CommandDef>();

  // User commands first (highest priority)
  const userFiles = await readDir(COMMANDS_DIR);
  for (const file of userFiles) {
    const name = nameFromFile(file);
    if (!name) continue;
    const cmd = await readCommandFile(path.join(COMMANDS_DIR, file), 'user');
    if (cmd) seen.set(name, cmd);
  }

  // Built-in commands (lower priority — skip if user already has it)
  const builtinFiles = await readDir(BUILTIN_COMMANDS_DIR);
  for (const file of builtinFiles) {
    const name = nameFromFile(file);
    if (!name || seen.has(name)) continue;
    const cmd = await readCommandFile(path.join(BUILTIN_COMMANDS_DIR, file), 'builtin');
    if (cmd) seen.set(name, cmd);
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get a single command by name. User dir first, then built-in.
 */
export async function getCommand(name: string): Promise<CommandDef | null> {
  validateName(name);
  // Try user dir first
  const userPath = path.join(COMMANDS_DIR, toFilename(name));
  const userCmd = await readCommandFile(userPath, 'user');
  if (userCmd) return userCmd;

  // Try built-in
  const builtinPath = path.join(BUILTIN_COMMANDS_DIR, toFilename(name));
  return readCommandFile(builtinPath, 'builtin');
}

/**
 * Create a new user command. Rejects reserved names and existing user commands.
 * Creating a command with a builtin name creates a user override.
 */
export async function createCommand(
  name: string,
  content: string,
  description?: string,
): Promise<CommandDef> {
  validateName(name);

  // Check for collision with existing user command (builtins can be overridden)
  const userPath = path.join(COMMANDS_DIR, toFilename(name));
  try {
    await fsp.access(userPath);
    throw new Error(`Command "${name}" already exists (source: user).`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
    // File doesn't exist — OK to create
  }

  await ensureCommandsDir();
  const filePath = path.join(COMMANDS_DIR, toFilename(name));
  await fsp.writeFile(filePath, serializeCommand(content, description), 'utf-8');

  return { name, description: description ?? '', content, source: 'user' };
}

/**
 * Update an existing user command. Rejects if only builtin exists.
 */
export async function updateCommand(
  name: string,
  updates: { content?: string; description?: string },
): Promise<CommandDef> {
  validateName(name);
  const existing = await getCommand(name);
  if (!existing) {
    throw new Error(`Command "${name}" not found.`);
  }
  if (existing.source === 'builtin') {
    throw new Error(`Cannot modify built-in command "${name}". Create a user override instead.`);
  }

  const newContent = updates.content ?? existing.content;
  const newDescription = updates.description ?? existing.description;

  const filePath = path.join(COMMANDS_DIR, toFilename(name));
  await fsp.writeFile(filePath, serializeCommand(newContent, newDescription || undefined), 'utf-8');

  return { name, description: newDescription, content: newContent, source: 'user' };
}

/**
 * Delete a user command. Rejects if only builtin exists.
 */
export async function deleteCommand(name: string): Promise<void> {
  validateName(name);
  const userPath = path.join(COMMANDS_DIR, toFilename(name));
  try {
    await fsp.access(userPath);
  } catch {
    // Check if it's a builtin-only command
    const builtin = await readCommandFile(
      path.join(BUILTIN_COMMANDS_DIR, toFilename(name)),
      'builtin',
    );
    if (builtin) {
      throw new Error(`Cannot delete built-in command "${name}".`);
    }
    throw new Error(`Command "${name}" not found.`);
  }

  await fsp.unlink(userPath);
}
