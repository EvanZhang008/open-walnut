/**
 * Team Reader — read Claude Code team config, find teammate JSONL files, inbox operations.
 *
 * ## Two Backends
 * - **tmux**: each teammate is a separate `claude` process with own session JSONL.
 *   Messages delivered in real-time (separate OS processes).
 * - **in-process**: teammates are subagents under the lead session.
 *   JSONL at {leadSession}/subagents/agent-{hex}.jsonl
 *
 * Both use the same team config at ~/.claude/teams/{team}/config.json
 * and the same inbox protocol at ~/.claude/teams/{team}/inboxes/{agent}.json
 *
 * ## In-Process Inbox Delivery (key architecture)
 *
 * When a message is sent to a teammate's inbox (writeToInbox), Claude Code
 * delivers it **between rounds only** — not mid-tool-call. The delivery creates
 * a BRAND NEW JSONL file with a new agentId. The new file's first entry has
 * `parentUuid` pointing to the last UUID of the agent's previous JSONL file,
 * forming a linked chain:
 *
 *   [main conversation] ← parentUuid ← [inbox response 1] ← parentUuid ← [inbox response 2] ...
 *
 * This means an agent receiving N inbox messages has N+1 JSONL files total.
 * Each file has a distinct agentId but shares the same conversation context
 * (Claude Code carries forward the full history).
 *
 * Implications for Walnut:
 * - findAllSubagentJsonlsForAgent() must trace parentUuid chains to discover all files
 * - The poller must periodically re-discover new files (not just tail one file)
 * - Messages sent to busy agents are queued — delivered only after current turn ends
 * - The "response" comes from a continuation process, not the original running process
 *
 * ## TeamDelete Fallback
 *
 * TeamDelete removes ~/.claude/teams/{name}/ at session end. When config is gone,
 * extractTeamsFromLeadJsonl() reconstructs member info from Agent tool calls in
 * the lead session JSONL, and findSubagentJsonlByPrompt() matches JSONL files
 * by comparing the full prompt text.
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

  // Check for the agent name in the early content (both literal and JSON-escaped quotes)
  const namePattern = `"${member.name}"`;
  const escapedPattern = `\\"${member.name}\\"`;
  if (content.includes(namePattern) || content.includes(escapedPattern)) return true;

  // Check for @agentName in shutdown requestIds (e.g., "@reader-alpha")
  if (content.includes(`@${member.name}`)) return true;

  return false;
}

// ── Inbox Operations ──
//
// The inbox is a JSON file per agent at ~/.claude/teams/{team}/inboxes/{agent}.json.
// Claude Code polls this file between rounds. When a new message is found:
// - In-process mode: spawns a NEW subagent (new agentId, new JSONL file) with
//   parentUuid linking to the previous file. The original running agent is NOT
//   interrupted — delivery happens only after the current round completes.
// - Tmux mode: sends to the running tmux pane directly (real-time delivery).

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

// ── Fallback: Extract Team Info from Lead Session JSONL ──
// When TeamDelete removes the config from disk, we can still reconstruct
// team member info and find JSONL files by parsing the lead session's JSONL.

export interface ExtractedTeamAgent {
  name: string;
  teamName: string;
  agentType: string;
  model: string;
  /** First ~80 chars of the prompt sent to this agent (for JSONL matching) */
  promptSnippet: string;
  /** Full prompt for precise matching */
  fullPrompt: string;
  /** Status from tool result ('done' if result exists) */
  status: 'calling' | 'done';
}

/**
 * Extract team info directly from the lead session JSONL.
 * This is the FALLBACK when TeamDelete has removed the config from disk.
 *
 * Parses Agent tool calls to find: team names, agent names, prompts, models.
 * Returns a map: teamName → list of agents.
 */
export function extractTeamsFromLeadJsonl(
  sessionJsonlPath: string,
): Map<string, ExtractedTeamAgent[]> {
  const teams = new Map<string, ExtractedTeamAgent[]>();

  try {
    const content = fs.readFileSync(sessionJsonlPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    // First pass: collect Agent tool_use calls
    const agentCalls = new Map<string, { name: string; teamName: string; prompt: string; model: string; agentType: string }>();

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant') {
          const blocks = obj.message?.content;
          if (!Array.isArray(blocks)) continue;
          for (const block of blocks) {
            if (block.type === 'tool_use' && block.name === 'Agent') {
              const input = block.input || {};
              const teamName = input.team_name;
              const agentName = input.name;
              if (teamName && agentName) {
                agentCalls.set(block.id, {
                  name: agentName,
                  teamName,
                  prompt: typeof input.prompt === 'string' ? input.prompt : '',
                  model: typeof input.model === 'string' ? input.model : 'sonnet',
                  agentType: typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose',
                });
              }
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }

    // Second pass: check tool_results to determine status
    const completedToolUseIds = new Set<string>();
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user') {
          const blocks = obj.message?.content;
          if (!Array.isArray(blocks)) continue;
          for (const block of blocks) {
            if (block.type === 'tool_result' && agentCalls.has(block.tool_use_id)) {
              completedToolUseIds.add(block.tool_use_id);
            }
          }
        }
      } catch { /* skip */ }
    }

    // Build team map
    for (const [toolId, call] of agentCalls) {
      if (!teams.has(call.teamName)) {
        teams.set(call.teamName, []);
      }
      teams.get(call.teamName)!.push({
        name: call.name,
        teamName: call.teamName,
        agentType: call.agentType,
        model: call.model,
        promptSnippet: call.prompt.slice(0, 80),
        fullPrompt: call.prompt,
        status: completedToolUseIds.has(toolId) ? 'done' : 'calling',
      });
    }

    log.session.debug('extracted teams from lead JSONL', {
      path: sessionJsonlPath.slice(-60),
      teams: [...teams.keys()],
      agentCount: [...teams.values()].reduce((n, a) => n + a.length, 0),
    });
  } catch (err) {
    log.session.warn('failed to extract teams from lead JSONL', {
      path: sessionJsonlPath.slice(-60),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return teams;
}

/**
 * Extract text content from the first user message in a subagent JSONL file.
 * The teammate-message prompt appears here (Claude Code wraps Agent tool prompts
 * in <teammate-message> tags). Returns null if no user message found.
 */
function extractFirstUserMessage(filePath: string): string | null {
  const head = readFileHead(filePath, 8192);
  if (!head) return null;

  const lines = head.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'user') continue;
      const content = obj.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
        }
      }
    } catch { /* skip malformed */ }
  }
  return null;
}

/**
 * Scan the subagent directory once and return a mapping of each file's
 * first user message text → file path. Larger files (actual conversations)
 * are preferred over small files (shutdown messages, user chats).
 */
function buildSubagentIndex(
  leadSessionId: string,
  leadCwd: string,
): Array<{ filePath: string; firstMessage: string; size: number }> {
  const encoded = encodeProjectPath(leadCwd);
  const subagentDir = path.join(CLAUDE_HOME, 'projects', encoded, leadSessionId, 'subagents');

  const result: Array<{ filePath: string; firstMessage: string; size: number }> = [];

  try {
    if (!fs.existsSync(subagentDir)) return result;
    const files = fs.readdirSync(subagentDir)
      .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'));

    for (const file of files) {
      const filePath = path.join(subagentDir, file);
      const size = fs.statSync(filePath).size;
      const firstMsg = extractFirstUserMessage(filePath);
      if (firstMsg) {
        result.push({ filePath, firstMessage: firstMsg, size });
      }
    }
  } catch (err) {
    log.session.debug('buildSubagentIndex failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/**
 * Find a subagent JSONL file by matching the full prompt from the Agent tool call.
 * Parses JSONL properly to avoid JSON escaping mismatches.
 *
 * When multiple files match (e.g., conversation file + shutdown file both contain
 * the prompt), prefers the larger file (actual conversation).
 */
export function findSubagentJsonlByPrompt(
  leadSessionId: string,
  leadCwd: string,
  fullPrompt: string,
): string | null {
  const index = buildSubagentIndex(leadSessionId, leadCwd);

  // Find all files whose first user message contains the full prompt
  const matches = index
    .filter(entry => entry.firstMessage.includes(fullPrompt))
    .sort((a, b) => b.size - a.size); // largest first (prefer actual conversations)

  if (matches.length > 0) {
    return matches[0].filePath;
  }

  // Fallback: try matching with just the first 200 chars of prompt
  // (in case wrapping slightly modified the prompt)
  const promptHead = fullPrompt.slice(0, 200);
  if (promptHead.length > 50) {
    const fallbackMatches = index
      .filter(entry => entry.firstMessage.includes(promptHead))
      .sort((a, b) => b.size - a.size);
    if (fallbackMatches.length > 0) {
      return fallbackMatches[0].filePath;
    }
  }

  return null;
}

/**
 * Parse the first JSONL line to extract parentUuid (for chain traversal).
 */
function extractParentUuid(filePath: string): string | null {
  const head = readFileHead(filePath, 1024);
  if (!head) return null;
  const firstLine = head.split('\n')[0];
  if (!firstLine) return null;
  try {
    const obj = JSON.parse(firstLine);
    return obj.parentUuid ?? null;
  } catch { return null; }
}

/**
 * Collect all UUIDs from a JSONL file (for parentUuid chain matching).
 */
function collectUuids(filePath: string): Set<string> {
  const uuids = new Set<string>();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.uuid) uuids.add(obj.uuid);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return uuids;
}

/**
 * Find ALL subagent JSONL files belonging to a specific agent.
 *
 * In-process teammates accumulate multiple JSONL files over their lifetime:
 *
 *   agent-abc.jsonl  (initial spawn — main conversation, matched by prompt)
 *       ↓ parentUuid chain
 *   agent-def.jsonl  (inbox response #1 — new agentId, linked via parentUuid)
 *       ↓ parentUuid chain
 *   agent-ghi.jsonl  (inbox response #2 — e.g., shutdown acknowledgment)
 *
 * Discovery uses two phases:
 * 1. Name matching: find files with @agentName or "agentName" in first 8KB
 * 2. parentUuid chain: collect all UUIDs from matched files, iteratively find
 *    children whose parentUuid is in the set (handles inbox responses that
 *    have NO agent name — only a parentUuid link)
 *
 * Returns paths sorted by file mtime (oldest first) for chronological ordering.
 * Called both at subscription time (initial load) and periodically by the poller
 * to discover newly created inbox response files.
 */
export function findAllSubagentJsonlsForAgent(
  leadSessionId: string,
  leadCwd: string,
  agentName: string,
  mainJsonlPath?: string | null,
): string[] {
  const encoded = encodeProjectPath(leadCwd);
  const subagentDir = path.join(CLAUDE_HOME, 'projects', encoded, leadSessionId, 'subagents');

  const result: Array<{ filePath: string; mtime: number }> = [];
  const includedPaths = new Set<string>();

  try {
    if (!fs.existsSync(subagentDir)) return [];
    const allFiles = fs.readdirSync(subagentDir)
      .filter(f => f.startsWith('agent-') && f.endsWith('.jsonl'))
      .map(f => path.join(subagentDir, f));

    // Phase 1: Include main JSONL + name-matched files
    for (const filePath of allFiles) {
      if (mainJsonlPath && filePath === mainJsonlPath) {
        result.push({ filePath, mtime: fs.statSync(filePath).mtimeMs });
        includedPaths.add(filePath);
        continue;
      }

      const head = readFileHead(filePath, 8192);
      if (!head) continue;

      // Match by agent name patterns (shutdown requests, teammate-message tags)
      const hasAgentRef = head.includes(`@${agentName}`)
        || head.includes(`"${agentName}"`)
        || head.includes(`\\"${agentName}\\"`);

      if (hasAgentRef) {
        result.push({ filePath, mtime: fs.statSync(filePath).mtimeMs });
        includedPaths.add(filePath);
      }
    }

    // Phase 2: Trace parentUuid chains from matched files.
    // Inbox response files have NO agent name — only a parentUuid pointing to
    // the last UUID in the parent file's conversation. We collect all UUIDs from
    // matched files and find children whose parentUuid is in our set.
    const knownUuids = new Set<string>();
    for (const entry of result) {
      for (const uuid of collectUuids(entry.filePath)) {
        knownUuids.add(uuid);
      }
    }

    // Build parentUuid → filePath lookup for O(N) chain traversal
    const parentUuidIndex = new Map<string, string[]>();
    for (const filePath of allFiles) {
      if (includedPaths.has(filePath)) continue;
      const parentUuid = extractParentUuid(filePath);
      if (parentUuid) {
        const list = parentUuidIndex.get(parentUuid) ?? [];
        list.push(filePath);
        parentUuidIndex.set(parentUuid, list);
      }
    }

    // Walk the chain: for each known UUID, find children via the index
    const queue = [...knownUuids];
    while (queue.length > 0) {
      const uuid = queue.pop()!;
      const children = parentUuidIndex.get(uuid);
      if (!children) continue;
      for (const filePath of children) {
        if (includedPaths.has(filePath)) continue;
        result.push({ filePath, mtime: fs.statSync(filePath).mtimeMs });
        includedPaths.add(filePath);
        for (const childUuid of collectUuids(filePath)) {
          knownUuids.add(childUuid);
          queue.push(childUuid);
        }
      }
    }

    if (result.length > 1) {
      log.session.debug('findAllSubagentJsonlsForAgent: multi-file', {
        agentName, fileCount: result.length,
      });
    }
  } catch (err) {
    log.session.debug('findAllSubagentJsonlsForAgent failed', {
      agentName, error: err instanceof Error ? err.message : String(err),
    });
  }

  // Sort by mtime for chronological order
  result.sort((a, b) => a.mtime - b.mtime);
  return result.map(r => r.filePath);
}

/**
 * Get the path to the lead session JSONL file.
 * Claude Code stores session JSONL at ~/.claude/projects/{encodedCwd}/{sessionId}.jsonl
 */
export function getLeadSessionJsonlPath(sessionId: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  return path.join(CLAUDE_HOME, 'projects', encoded, `${sessionId}.jsonl`);
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
