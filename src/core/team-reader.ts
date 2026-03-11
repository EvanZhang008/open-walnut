/**
 * Team Reader — read Claude Code team config, find teammate JSONL files, inbox operations.
 *
 * Claude Code Teams have two backends:
 * - tmux: each teammate is a separate `claude` process with own session JSONL
 * - in-process: teammates are subagents, JSONL at {leadSession}/subagents/agent-{hex}.jsonl
 *
 * Both use the same team config at ~/.claude/teams/{team}/config.json
 * and the same inbox protocol at ~/.claude/teams/{team}/inboxes/{agent}.json
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_HOME } from '../constants.js';
import { encodeProjectPath } from './session-file-reader.js';
import { log } from '../logging/index.js';

// ── Types ──

export interface TeamMember {
  agentId: string;
  name: string;
  agentType: string;
  model: string;
  prompt?: string;
  color?: string;
  backendType?: 'tmux' | string;
  tmuxPaneId?: string;
  cwd?: string;
  isActive?: boolean;
  joinedAt?: number;
}

export interface TeamConfig {
  name: string;
  description?: string;
  createdAt: number;
  leadAgentId: string;
  leadSessionId: string;
  members: TeamMember[];
}

export interface InboxMessage {
  from: string;
  text: string;
  summary: string;
  timestamp: string;
  read: boolean;
}

export interface TeamInfo {
  teamName: string;
  config: TeamConfig;
  /** Map from member name → resolved JSONL file path (or null if not found yet) */
  memberJsonlPaths: Map<string, string | null>;
}

// ── Team Config ──

/** Path to team config file */
function teamConfigPath(teamName: string): string {
  return path.join(CLAUDE_HOME, 'teams', teamName, 'config.json');
}

/** Read team config from local filesystem */
export function readTeamConfig(teamName: string): TeamConfig | null {
  try {
    const content = fs.readFileSync(teamConfigPath(teamName), 'utf-8');
    return JSON.parse(content) as TeamConfig;
  } catch {
    return null;
  }
}

// ── Find Teammate JSONL Files ──

/**
 * Determine if a team member uses tmux backend.
 * tmux members have backendType === 'tmux' and a non-empty tmuxPaneId.
 */
function isTmuxMember(member: TeamMember): boolean {
  return member.backendType === 'tmux' && !!member.tmuxPaneId;
}

/**
 * Find JSONL files for all teammates (local sessions only).
 * Returns a Map from member name → local JSONL path.
 */
export function findTeammateJsonlPaths(
  config: TeamConfig,
  leadSessionId: string,
  leadCwd?: string,
): Map<string, string | null> {
  const result = new Map<string, string | null>();

  for (const member of config.members) {
    if (member.agentId === config.leadAgentId) {
      // Lead agent — no separate JSONL needed
      result.set(member.name, null);
      continue;
    }

    if (isTmuxMember(member)) {
      const jsonlPath = findTmuxTeammateJsonl(member, config, leadCwd);
      result.set(member.name, jsonlPath);
    } else {
      const jsonlPath = findInProcessTeammateJsonl(member, config, leadSessionId, leadCwd);
      result.set(member.name, jsonlPath);
    }
  }

  return result;
}

/**
 * Find a tmux teammate's JSONL file.
 * tmux teammates have their own Claude session, writing JSONL in
 * ~/.claude/projects/{encodedCwd}/{sessionId}.jsonl
 *
 * Strategy: scan recent JSONL files in the teammate's project dir for ones
 * created after the team was created, whose init event has matching agent metadata.
 */
function findTmuxTeammateJsonl(
  member: TeamMember,
  config: TeamConfig,
  leadCwd?: string,
): string | null {
  const cwd = member.cwd || leadCwd;
  if (!cwd) return null;

  const encoded = encodeProjectPath(cwd);
  const projectDir = path.join(CLAUDE_HOME, 'projects', encoded);

  try {
    if (!fs.existsSync(projectDir)) return null;
    const files = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
      .map(f => ({
        name: f,
        path: path.join(projectDir, f),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      // Only consider files created around/after team creation
      .filter(f => f.mtime >= config.createdAt - 5000)
      .sort((a, b) => b.mtime - a.mtime); // newest first

    for (const file of files) {
      // Read just the first few lines to check for matching agent info
      const content = readFileHead(file.path, 2048);
      if (!content) continue;

      // Check if this JSONL's init has the teammate's agentId
      // or if the first user message references this teammate
      const firstLine = content.split('\n')[0];
      if (!firstLine) continue;

      try {
        const init = JSON.parse(firstLine);
        // Check for parent session reference
        if (init.type === 'system' && init.session_id) {
          // The teammate's JSONL might reference the parent via prompt content
          // or the session might be identified by timestamp match
          // For now, check if any line contains the team name or agent name
          if (content.includes(member.name) || content.includes(config.name)) {
            return file.path;
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch (err) {
    log.session.debug('failed to scan for tmux teammate JSONL', {
      member: member.name, error: err instanceof Error ? err.message : String(err),
    });
  }

  return null;
}

/**
 * Find an in-process teammate's JSONL file.
 * In-process teammates write to {leadSessionDir}/subagents/agent-{hex}.jsonl
 *
 * Match by comparing the teammate's prompt with the first user message content.
 */
function findInProcessTeammateJsonl(
  member: TeamMember,
  config: TeamConfig,
  leadSessionId: string,
  leadCwd?: string,
): string | null {
  if (!leadCwd) return null;

  const encoded = encodeProjectPath(leadCwd);
  const subagentDir = path.join(CLAUDE_HOME, 'projects', encoded, leadSessionId, 'subagents');

  try {
    if (!fs.existsSync(subagentDir)) return null;
    const files = fs.readdirSync(subagentDir)
      .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(subagentDir, file);
      const content = readFileHead(filePath, 4096);
      if (!content) continue;

      // Match by looking for the member's name or prompt in the content
      if (matchSubagentToMember(content, member)) {
        return filePath;
      }
    }
  } catch (err) {
    log.session.debug('failed to scan for in-process teammate JSONL', {
      member: member.name, error: err instanceof Error ? err.message : String(err),
    });
  }

  return null;
}

/**
 * Match a subagent JSONL file to a team member.
 * Checks for teammate-message tags, member name references, or prompt fragments.
 */
function matchSubagentToMember(content: string, member: TeamMember): boolean {
  // Check for <teammate-message> with matching from= attribute
  const teammateTag = `from="${member.name}"`;
  if (content.includes(teammateTag)) return true;

  // Check for the agent name in the early content
  const namePattern = `"${member.name}"`;
  if (content.includes(namePattern)) return true;

  // Check for prompt fragment (first 100 chars)
  if (member.prompt) {
    const snippet = member.prompt.slice(0, 100);
    if (content.includes(snippet)) return true;
  }

  return false;
}

// ── Inbox Operations ──

/** Path to a teammate's inbox file */
function inboxPath(teamName: string, agentName: string): string {
  return path.join(CLAUDE_HOME, 'teams', teamName, 'inboxes', `${agentName}.json`);
}

/** Read inbox for a teammate (local only) */
export function readInbox(teamName: string, agentName: string): InboxMessage[] {
  try {
    const content = fs.readFileSync(inboxPath(teamName, agentName), 'utf-8');
    return JSON.parse(content) as InboxMessage[];
  } catch {
    return [];
  }
}

/** Write a message to a teammate's inbox (local only) */
export async function writeToInbox(
  teamName: string,
  agentName: string,
  message: string,
  from = 'user',
): Promise<void> {
  const filePath = inboxPath(teamName, agentName);
  let inbox: InboxMessage[] = [];

  try {
    const content = await fsp.readFile(filePath, 'utf-8');
    inbox = JSON.parse(content);
  } catch { /* new inbox */ }

  inbox.push({
    from,
    text: message,
    summary: message.slice(0, 60),
    timestamp: new Date().toISOString(),
    read: false,
  });

  // Ensure inbox directory exists before writing
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(inbox, null, 2));
}

// ── Helpers ──

/** Read the first N bytes of a file (for matching without reading entire JSONL) */
function readFileHead(filePath: string, bytes: number): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const bytesRead = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.toString('utf-8', 0, bytesRead);
  } catch {
    return null;
  }
}
