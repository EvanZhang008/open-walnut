/**
 * SessionFileReader — unified file access for local and remote session data.
 *
 * Provides a single interface for reading session JSONL files and subagent
 * directories, whether the session ran locally or on a remote host via SSH.
 *
 * Local sessions:  fs.readFile / fs.readdir
 * Remote sessions: ssh cat / ssh ls (batched where possible)
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { CLAUDE_HOME } from '../constants.js';
import { getConfig } from './config-manager.js';
import { log } from '../logging/index.js';

// ── Path helpers ──

/**
 * Encode a working directory path the way Claude Code does.
 * /Users/foo/bar → -Users-foo-bar
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replaceAll('/', '-');
}

/** Build the canonical JSONL path for a session (local absolute path). */
export function canonicalJsonlPath(sessionId: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  return path.join(CLAUDE_HOME, 'projects', encoded, `${sessionId}.jsonl`);
}

/** Build the remote JSONL path (tilde-based, for SSH commands). */
export function remoteJsonlPath(sessionId: string, cwd?: string): string {
  if (cwd) {
    const encoded = encodeProjectPath(cwd);
    return `~/.claude/projects/${encoded}/${sessionId}.jsonl`;
  }
  return `~/.claude/projects/*/${sessionId}.jsonl`;
}

/** Build the subagents directory path (local absolute). */
export function subagentDirPath(sessionId: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  return path.join(CLAUDE_HOME, 'projects', encoded, sessionId, 'subagents');
}

/** Build the remote subagents directory path (tilde-based). */
export function remoteSubagentDirPath(sessionId: string, cwd?: string): string {
  if (cwd) {
    const encoded = encodeProjectPath(cwd);
    return `~/.claude/projects/${encoded}/${sessionId}/subagents`;
  }
  return `~/.claude/projects/*/${sessionId}/subagents`;
}

// ── Interface ──

export interface SessionFileReader {
  /** Read a file's contents. Returns null if the file doesn't exist or on error. */
  readFile(filePath: string): Promise<string | null>;
  /** List directory entries. Returns empty array if dir doesn't exist or on error. */
  listDir(dirPath: string): Promise<string[]>;
}

// ── Local implementation ──

export class LocalFileReader implements SessionFileReader {
  async readFile(filePath: string): Promise<string | null> {
    try {
      return await fsp.readFile(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  async listDir(dirPath: string): Promise<string[]> {
    try {
      return await fsp.readdir(dirPath);
    } catch {
      return [];
    }
  }
}

// ── Remote implementation ──

export class RemoteFileReader implements SessionFileReader {
  private sshTarget: string;
  private sshArgs: string[];

  constructor(private host: string) {
    // Resolved lazily on first use
    this.sshTarget = '';
    this.sshArgs = [];
  }

  private async resolve(): Promise<void> {
    if (this.sshTarget) return;
    const config = await getConfig();
    const hostConfig = config.hosts?.[this.host];
    if (!hostConfig) {
      throw new Error(`Unknown SSH host: ${this.host}`);
    }
    this.sshTarget = hostConfig.user
      ? `${hostConfig.user}@${hostConfig.hostname}`
      : hostConfig.hostname;
    this.sshArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no'];
    if (hostConfig.port) {
      this.sshArgs.push('-p', String(hostConfig.port));
    }
  }

  private execSsh(remoteCmd: string, timeout = 15000): string | null {
    try {
      return execSync(
        `ssh ${this.sshArgs.join(' ')} ${this.sshTarget} "${remoteCmd}"`,
        { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      return null;
    }
  }

  async readFile(remotePath: string): Promise<string | null> {
    await this.resolve();
    const useGlob = remotePath.includes('*');
    const cmd = useGlob
      ? `for f in ${remotePath}; do [ -f "$f" ] && cat "$f" && exit 0; done; exit 1`
      : `cat '${remotePath}'`;
    const result = this.execSsh(cmd);
    return result || null;
  }

  async listDir(remotePath: string): Promise<string[]> {
    await this.resolve();
    const result = this.execSsh(`ls '${remotePath}' 2>/dev/null`);
    if (!result) return [];
    return result.split('\n').filter(Boolean);
  }

  /**
   * Batch-read all subagent JSONL files from a remote directory.
   * Returns a Map<filename, content> to avoid N separate SSH calls.
   */
  async batchReadSubagents(remoteDirPath: string): Promise<Map<string, string>> {
    await this.resolve();
    // Use a single SSH command that prints each file with a delimiter
    const delimiter = '___WALNUT_FILE_BOUNDARY___';
    const cmd = `cd '${remoteDirPath}' 2>/dev/null && for f in agent-*.jsonl; do [ -f "$f" ] && echo "${delimiter}$f" && cat "$f"; done`;
    const result = this.execSsh(cmd, 30000);
    if (!result) return new Map();

    const fileMap = new Map<string, string>();
    const sections = result.split(delimiter).filter(Boolean);
    for (const section of sections) {
      const newlineIdx = section.indexOf('\n');
      if (newlineIdx === -1) continue;
      const filename = section.slice(0, newlineIdx).trim();
      const content = section.slice(newlineIdx + 1);
      if (filename && content) {
        fileMap.set(filename, content);
      }
    }
    return fileMap;
  }
}

// ── Factory ──

/** Create the appropriate file reader for local or remote sessions. */
export function createFileReader(host?: string): SessionFileReader {
  if (host) return new RemoteFileReader(host);
  return new LocalFileReader();
}

// ── High-level helpers ──

/**
 * Find the local JSONL file for a session.
 * If cwd provided, check the exact encoded path.
 * Fallback: search all project dirs for the session ID.
 */
export function findLocalJsonlPath(sessionId: string, cwd?: string): string | null {
  const projectsDir = path.join(CLAUDE_HOME, 'projects');

  if (cwd) {
    const filePath = canonicalJsonlPath(sessionId, cwd);
    if (fs.existsSync(filePath)) return filePath;
  }

  // Fallback: search all project directories
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const dir of dirs) {
      const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) return filePath;
    }
  } catch {
    // projects dir doesn't exist
  }

  return null;
}

/**
 * Read session JSONL content using the appropriate reader.
 * Tries local paths first, then falls back to remote if host is provided.
 *
 * Returns { content, source } where source indicates where data was read from,
 * or null if not found.
 */
export async function readSessionJsonlContent(
  sessionId: string,
  cwd?: string,
  host?: string,
  outputFile?: string,
): Promise<{ content: string; source: 'local' | 'stream' | 'outputFile' | 'remote' } | null> {
  const { SESSION_STREAMS_DIR } = await import('../constants.js');

  // 1. Local canonical path (~/.claude/projects/...)
  const localPath = findLocalJsonlPath(sessionId, cwd);
  if (localPath) {
    try {
      const content = fs.readFileSync(localPath, 'utf-8');
      if (content) return { content, source: 'local' };
    } catch {
      // Fall through
    }
  }

  // 2. Local streaming capture (SESSION_STREAMS_DIR)
  try {
    const files = fs.readdirSync(SESSION_STREAMS_DIR);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(SESSION_STREAMS_DIR, file);
      try {
        const firstLine = fs.readFileSync(filePath, 'utf-8').split('\n')[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          if (parsed.sessionId === sessionId || parsed.session_id === sessionId) {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content) return { content, source: 'stream' };
          }
        }
      } catch { /* Skip */ }
    }
  } catch { /* SESSION_STREAMS_DIR doesn't exist */ }

  // 3. Direct outputFile path (tmp file not yet renamed)
  if (outputFile) {
    try {
      if (fs.existsSync(outputFile)) {
        const content = fs.readFileSync(outputFile, 'utf-8');
        if (content) return { content, source: 'outputFile' };
      }
    } catch { /* Fall through */ }
  }

  // 4. Remote via SSH
  if (host) {
    const reader = new RemoteFileReader(host);
    const remotePath = remoteJsonlPath(sessionId, cwd);
    try {
      const content = await reader.readFile(remotePath);
      if (content) return { content, source: 'remote' };
    } catch (err) {
      log.session.debug('remote JSONL read failed', {
        host, sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return null;
}

/**
 * Read subagent JSONL files for a session.
 * For local sessions: reads from filesystem directly.
 * For remote sessions: uses batched SSH to read all subagent files in one call.
 *
 * Returns a Map<agentId, rawContent> (callers parse the content themselves).
 */
export async function readSubagentContents(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<Map<string, string>> {
  if (host) {
    return readRemoteSubagentContents(sessionId, cwd, host);
  }
  return readLocalSubagentContents(sessionId, cwd);
}

function readLocalSubagentContents(sessionId: string, cwd?: string): Map<string, string> {
  const result = new Map<string, string>();
  const projectsDir = path.join(CLAUDE_HOME, 'projects');

  const candidates: string[] = [];
  if (cwd) {
    candidates.push(subagentDirPath(sessionId, cwd));
  }
  // Fallback: search all project directories
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, sessionId, 'subagents');
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
  } catch { /* projects dir doesn't exist */ }

  for (const subDir of candidates) {
    if (!fs.existsSync(subDir)) continue;
    try {
      const files = fs.readdirSync(subDir);
      for (const file of files) {
        if (!file.startsWith('agent-') || !file.endsWith('.jsonl')) continue;
        const agentId = file.slice('agent-'.length, -'.jsonl'.length);
        try {
          const content = fs.readFileSync(path.join(subDir, file), 'utf-8');
          if (content) result.set(agentId, content);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    if (result.size > 0) break;
  }

  return result;
}

async function readRemoteSubagentContents(
  sessionId: string,
  cwd?: string,
  host?: string,
): Promise<Map<string, string>> {
  if (!host) return new Map();

  const reader = new RemoteFileReader(host);
  const remotePath = remoteSubagentDirPath(sessionId, cwd);

  try {
    const fileMap = await reader.batchReadSubagents(remotePath);
    // Convert filename → agentId
    const result = new Map<string, string>();
    for (const [filename, content] of fileMap) {
      if (!filename.startsWith('agent-') || !filename.endsWith('.jsonl')) continue;
      const agentId = filename.slice('agent-'.length, -'.jsonl'.length);
      result.set(agentId, content);
    }
    return result;
  } catch (err) {
    log.session.debug('remote subagent read failed', {
      host, sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}
