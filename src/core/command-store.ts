/**
 * Core CRUD for markdown-based slash commands.
 *
 * Three layers:
 *   1. Built-in commands — dist/data/slash-commands/*.md (read-only). EMPTY since
 *      2026-07: every built-in descriptive command was migrated to a skill
 *      (src/data/skills/<name>/SKILL.md) — skills are the one mental model for
 *      "instructions the Personal AI follows", surfaced in the / palette by
 *      skill-bridge. The layer is kept for back-compat with user-created files.
 *   2. Plugin commands  — registered in-process by an active plugin, always named
 *      `<pluginId>:<localId>` (see plugins/command-registry.ts). Read-only: they
 *      live in the plugin's code, not on disk, so update/delete refuse with the
 *      same "Cannot modify/Cannot delete" contract built-ins use (HTTP 403).
 *   3. User commands    — stored in ~/.open-walnut/commands/*.md (read-write)
 *
 * Priority is strict: user > plugin > builtin. Lookup by an ordinary slug name is
 * unchanged (user dir, then built-in) — a plugin command is never reachable that
 * way because its name always carries the `pluginId:` namespace.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { log } from '../logging/index.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { COMMANDS_DIR, BUILTIN_COMMANDS_DIR } from '../constants.js';
import {
  getOwnedCommand,
  isPluginCommandName,
  listOwnedCommands,
} from './plugins/command-registry.js';

async function ensureCommandsDir(): Promise<void> {
  await fsp.mkdir(COMMANDS_DIR, { recursive: true });
}

export interface CommandDef {
  name: string;
  description: string;
  content: string;
  source: 'builtin' | 'user' | 'plugin';
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
  } catch (err) {
    log.task.debug('command-store: readDir failed', {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
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
 * List all commands. Priority is strict: user > plugin > builtin. Sorted by name.
 */
export async function listCommands(): Promise<CommandDef[]> {
  const seen = new Map<string, CommandDef>();

  // User commands first (highest priority)
  const userFiles = await readDir(COMMANDS_DIR);
  for (const file of userFiles) {
    const name = nameFromFile(file);
    if (!name || isPluginCommandName(name)) continue;
    const cmd = await readCommandFile(path.join(COMMANDS_DIR, file), 'user');
    if (cmd) seen.set(name, cmd);
  }

  // Plugin commands (middle priority) — in-process, no disk read
  for (const cmd of listOwnedCommands()) {
    if (seen.has(cmd.name)) continue;
    seen.set(cmd.name, cmd);
  }

  // Built-in commands (lowest priority — skip if user or a plugin already has it)
  const builtinFiles = await readDir(BUILTIN_COMMANDS_DIR);
  for (const file of builtinFiles) {
    const name = nameFromFile(file);
    if (!name || isPluginCommandName(name) || seen.has(name)) continue;
    const cmd = await readCommandFile(path.join(BUILTIN_COMMANDS_DIR, file), 'builtin');
    if (cmd) seen.set(name, cmd);
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Get a single command by name. User dir first, then built-in.
 *
 * A `pluginId:localId` name is resolved from the plugin registry BEFORE the slug
 * validation runs — that pattern has no `:`, so validating first would reject every
 * plugin command as an invalid name.
 */
export async function getCommand(name: string): Promise<CommandDef | null> {
  if (isPluginCommandName(name)) return getOwnedCommand(name);
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
  if (isPluginCommandName(name)) {
    if (!getOwnedCommand(name)) throw new Error(`Command "${name}" not found.`);
    throw new Error(`Cannot modify plugin command "${name}". Edit the plugin that registers it.`);
  }
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
  if (isPluginCommandName(name)) {
    if (!getOwnedCommand(name)) throw new Error(`Command "${name}" not found.`);
    throw new Error(`Cannot delete plugin command "${name}". Disable the plugin that registers it.`);
  }
  validateName(name);
  const userPath = path.join(COMMANDS_DIR, toFilename(name));
  try {
    await fsp.access(userPath);
  } catch (err) {
    log.task.debug('command-store: user command file not found, checking builtin', {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
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
