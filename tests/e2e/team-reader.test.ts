/**
 * E2E test: Team Reader + Session-Chat team RPCs + Remote session bug reproductions.
 *
 * Groups:
 * A. team-reader.ts unit tests (readTeamConfig, extractTeamsFromLeadJsonl, findSubagentJsonlByPrompt, findAllSubagentJsonlsForAgent)
 * C. session-chat.ts team RPC integration (session:team-info, session:team-agent-subscribe)
 * D. Remote session bug reproductions (PID detection, orphan kill, freeze scenario)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';

// ── Mock constants → tmpdir ──
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('team-reader-test'));

// ── Imports (after mocks) ──
import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { _resetForTest as resetAgentRegistry } from '../../src/core/agent-registry.js';
import {
  readTeamConfig,
  extractTeamsFromLeadJsonl,
  findSubagentJsonlByPrompt,
  findAllSubagentJsonlsForAgent,
  getLeadSessionJsonlPath,
  writeToInbox,
  readInbox,
} from '../../src/core/team-reader.js';
import type { TeamConfig, ExtractedTeamAgent } from '../../src/core/team-reader.js';
import { encodeProjectPath } from '../../src/core/session-file-reader.js';
import { isProcessAliveAsync } from '../../src/utils/process.js';

// ── JSONL Fixture Builders ──

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function systemInitEvent(sessionId: string, model = 'claude-opus-4-6'): string {
  return jsonlLine({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    tools: [],
  });
}

function assistantTextEvent(text: string): string {
  return jsonlLine({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  });
}

function assistantToolUseEvent(toolName: string, toolId: string, input: Record<string, unknown>): string {
  return jsonlLine({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input,
      }],
      stop_reason: 'tool_use',
    },
  });
}

function userToolResultEvent(toolUseId: string, content: string): string {
  return jsonlLine({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
      }],
    },
  });
}

function resultEvent(sessionId: string, result: string): string {
  return jsonlLine({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result,
  });
}

function userMessageEvent(text: string): string {
  return jsonlLine({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  });
}

function systemEventWithUuid(sessionId: string, uuid: string, parentUuid?: string): string {
  return jsonlLine({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-opus-4-6',
    uuid,
    ...(parentUuid ? { parentUuid } : {}),
  });
}

function assistantEventWithUuid(text: string, uuid: string): string {
  return jsonlLine({
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    },
  });
}

// ── Shared Fixture: Team Config ──

const TEAM_NAME = 'test-investigation';
const SESSION_ID = 'b8ef03d0-1234-5678-9abc-def012345678';
const CWD = '/home/user/project';

function buildTeamConfig(overrides?: Partial<TeamConfig>): TeamConfig {
  return {
    name: TEAM_NAME,
    description: 'Test investigation team',
    createdAt: Date.now() - 60000,
    leadAgentId: 'lead-agent-001',
    leadSessionId: SESSION_ID,
    members: [
      {
        agentId: 'lead-agent-001',
        name: 'team-lead',
        agentType: 'general-purpose',
        model: 'opus',
      },
      {
        agentId: 'agent-alpha',
        name: 'researcher',
        agentType: 'general-purpose',
        model: 'sonnet',
        prompt: 'Research the CIS audit logs and find anomalies',
      },
      {
        agentId: 'agent-beta',
        name: 'analyzer',
        agentType: 'general-purpose',
        model: 'sonnet',
        prompt: 'Analyze the patterns in the audit data',
      },
      {
        agentId: 'agent-gamma',
        name: 'reporter',
        agentType: 'general-purpose',
        model: 'haiku',
        prompt: 'Write a summary report of the findings',
      },
    ],
    ...overrides,
  };
}

/** Write a team config to the filesystem */
async function writeTeamConfig(config: TeamConfig): Promise<void> {
  const configDir = path.join(CLAUDE_HOME, 'teams', config.name);
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
}

/** Build a lead JSONL with TeamCreate + Agent tool calls */
function buildLeadJsonl(): string {
  const lines = [
    systemInitEvent(SESSION_ID),
    // TeamCreate tool call
    assistantToolUseEvent('TeamCreate', 'tc-001', {
      team_name: TEAM_NAME,
      description: 'Test investigation team',
    }),
    userToolResultEvent('tc-001', 'Team created'),
    // Agent #1 — researcher
    assistantToolUseEvent('Agent', 'agent-call-001', {
      team_name: TEAM_NAME,
      name: 'researcher',
      prompt: 'Research the CIS audit logs and find anomalies',
      model: 'sonnet',
      subagent_type: 'general-purpose',
    }),
    // Agent #2 — analyzer
    assistantToolUseEvent('Agent', 'agent-call-002', {
      team_name: TEAM_NAME,
      name: 'analyzer',
      prompt: 'Analyze the patterns in the audit data',
      model: 'sonnet',
      subagent_type: 'general-purpose',
    }),
    // Agent #3 — reporter (with tool_result = done)
    assistantToolUseEvent('Agent', 'agent-call-003', {
      team_name: TEAM_NAME,
      name: 'reporter',
      prompt: 'Write a summary report of the findings',
      model: 'haiku',
      subagent_type: 'general-purpose',
    }),
    userToolResultEvent('agent-call-003', 'Report completed'),
    // Result event
    resultEvent(SESSION_ID, 'Team dispatched all agents'),
  ];
  return lines.join('\n') + '\n';
}

/** Build a subagent JSONL for a specific agent */
function buildSubagentJsonl(agentName: string, prompt: string, uuid: string): string {
  const lines = [
    systemEventWithUuid(`subagent-${agentName}`, uuid),
    userMessageEvent(`<teammate-message from="${agentName}">\n${prompt}\n</teammate-message>`),
    assistantTextEvent(`I'll work on: ${prompt.slice(0, 50)}...`),
  ];
  return lines.join('\n') + '\n';
}

/** Write a JSONL file to the subagent directory */
async function writeSubagentJsonl(
  leadSessionId: string,
  cwd: string,
  filename: string,
  content: string,
): Promise<string> {
  const encoded = encodeProjectPath(cwd);
  const subagentDir = path.join(CLAUDE_HOME, 'projects', encoded, leadSessionId, 'subagents');
  await fs.mkdir(subagentDir, { recursive: true });
  const filePath = path.join(subagentDir, filename);
  await fs.writeFile(filePath, content);
  return filePath;
}

/** Write a lead session JSONL file */
async function writeLeadJsonl(sessionId: string, cwd: string, content: string): Promise<string> {
  const encoded = encodeProjectPath(cwd);
  const projectDir = path.join(CLAUDE_HOME, 'projects', encoded);
  await fs.mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(filePath, content);
  return filePath;
}

// ── Setup / Teardown ──

let server: HttpServer;
let port: number;

function wsUrl(): string {
  return `ws://localhost:${port}/ws`;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

interface WsFrame {
  type: string;
  name?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

function sendRpc(ws: WebSocket, method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = String(Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000);
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'res' && frame.id === id) {
        clearTimeout(timer);
        ws.off('message', handler);
        if (!frame.ok) reject(new Error(frame.error || 'RPC failed'));
        else resolve(frame.payload ?? {});
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'req', id, method, payload }));
  });
}

beforeAll(async () => {
  // Create required directories
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  await fs.mkdir(CLAUDE_HOME, { recursive: true });

  // Write minimal config
  await fs.writeFile(
    `${WALNUT_HOME}/config.yaml`,
    'version: 1\nuser:\n  name: Test User\ndefaults:\n  priority: none\n  category: Inbox\nprovider:\n  type: bedrock\n',
  );

  // Write empty tasks store
  const tasksDir = `${WALNUT_HOME}/tasks`;
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(`${tasksDir}/tasks.json`, JSON.stringify({ version: 2, tasks: [] }));

  resetAgentRegistry();
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
}, 15000);

// ── Group A: team-reader.ts Unit Tests ──

describe('A. team-reader.ts', () => {
  describe('readTeamConfig', () => {
    it('A1. reads valid team config and returns TeamConfig object', async () => {
      const config = buildTeamConfig();
      await writeTeamConfig(config);

      const result = readTeamConfig(TEAM_NAME);
      expect(result).not.toBeNull();
      expect(result!.name).toBe(TEAM_NAME);
      expect(result!.members).toHaveLength(4);
      expect(result!.leadAgentId).toBe('lead-agent-001');
      expect(result!.members[1].name).toBe('researcher');
      expect(result!.members[1].model).toBe('sonnet');
    });

    it('A2. returns null when config does not exist', () => {
      const result = readTeamConfig('nonexistent-team');
      expect(result).toBeNull();
    });

    it('A3. returns null when config has malformed JSON', async () => {
      const configDir = path.join(CLAUDE_HOME, 'teams', 'bad-json-team');
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, 'config.json'), '{ invalid json!!');

      const result = readTeamConfig('bad-json-team');
      expect(result).toBeNull();
    });
  });

  describe('extractTeamsFromLeadJsonl', () => {
    it('A4. extracts 3 Agent calls with correct team_name/name/prompt/model', async () => {
      const content = buildLeadJsonl();
      const filePath = await writeLeadJsonl(SESSION_ID, CWD, content);

      const teams = extractTeamsFromLeadJsonl(filePath);
      expect(teams.size).toBe(1);
      expect(teams.has(TEAM_NAME)).toBe(true);

      const agents = teams.get(TEAM_NAME)!;
      expect(agents).toHaveLength(3);

      // Check researcher
      const researcher = agents.find(a => a.name === 'researcher');
      expect(researcher).toBeDefined();
      expect(researcher!.teamName).toBe(TEAM_NAME);
      expect(researcher!.model).toBe('sonnet');
      expect(researcher!.agentType).toBe('general-purpose');
      expect(researcher!.fullPrompt).toBe('Research the CIS audit logs and find anomalies');
      expect(researcher!.promptSnippet).toBe('Research the CIS audit logs and find anomalies');

      // Check analyzer
      const analyzer = agents.find(a => a.name === 'analyzer');
      expect(analyzer).toBeDefined();
      expect(analyzer!.model).toBe('sonnet');

      // Check reporter
      const reporter = agents.find(a => a.name === 'reporter');
      expect(reporter).toBeDefined();
      expect(reporter!.model).toBe('haiku');
    });

    it('A5. distinguishes done vs calling status based on tool_result presence', async () => {
      const content = buildLeadJsonl();
      const filePath = await writeLeadJsonl(SESSION_ID + '-status', CWD, content);

      const teams = extractTeamsFromLeadJsonl(filePath);
      const agents = teams.get(TEAM_NAME)!;

      // reporter has tool_result → done
      const reporter = agents.find(a => a.name === 'reporter');
      expect(reporter!.status).toBe('done');

      // researcher has no tool_result → calling
      const researcher = agents.find(a => a.name === 'researcher');
      expect(researcher!.status).toBe('calling');

      // analyzer has no tool_result → calling
      const analyzer = agents.find(a => a.name === 'analyzer');
      expect(analyzer!.status).toBe('calling');
    });
  });

  describe('findSubagentJsonlByPrompt', () => {
    it('A6. matches prompt and returns correct file', async () => {
      const prompt = 'Research the CIS audit logs and find anomalies';
      await writeSubagentJsonl(SESSION_ID, CWD, 'agent-aaa.jsonl',
        buildSubagentJsonl('researcher', prompt, 'uuid-aaa'));

      const result = findSubagentJsonlByPrompt(SESSION_ID, CWD, prompt);
      expect(result).not.toBeNull();
      expect(result!).toContain('agent-aaa.jsonl');
    });

    it('A7. prefers larger file when multiple match the same prompt', async () => {
      const sid = SESSION_ID + '-multi';
      const prompt = 'Analyze the patterns in the audit data';

      // Small file (shutdown message — 200 bytes)
      await writeSubagentJsonl(sid, CWD, 'agent-small.jsonl',
        buildSubagentJsonl('analyzer', prompt, 'uuid-small'));

      // Large file (real conversation — add lots of content)
      const bigContent = buildSubagentJsonl('analyzer', prompt, 'uuid-big') +
        assistantTextEvent('This is a much longer response with detailed analysis '.repeat(20)) + '\n' +
        assistantTextEvent('Additional findings '.repeat(50)) + '\n';
      await writeSubagentJsonl(sid, CWD, 'agent-big.jsonl', bigContent);

      const result = findSubagentJsonlByPrompt(sid, CWD, prompt);
      expect(result).not.toBeNull();
      expect(result!).toContain('agent-big.jsonl');
    });
  });

  describe('findAllSubagentJsonlsForAgent', () => {
    it('A8. traces parentUuid chain to discover inbox response files', async () => {
      const sid = SESSION_ID + '-chain';

      // Main JSONL — uuid-main-1 and uuid-main-2
      const mainContent = [
        systemEventWithUuid('subagent-reader', 'uuid-main-1'),
        userMessageEvent('<teammate-message from="reader">\nDo research\n</teammate-message>'),
        assistantEventWithUuid('Working on it...', 'uuid-main-2'),
      ].join('\n') + '\n';
      const mainPath = await writeSubagentJsonl(sid, CWD, 'agent-main.jsonl', mainContent);

      // Inbox response #1 — parentUuid points to uuid-main-2
      const inbox1Content = [
        systemEventWithUuid('inbox-response-1', 'uuid-inbox1-1', 'uuid-main-2'),
        userMessageEvent('New task from inbox'),
        assistantEventWithUuid('Processing inbox message...', 'uuid-inbox1-2'),
      ].join('\n') + '\n';
      await writeSubagentJsonl(sid, CWD, 'agent-inbox1.jsonl', inbox1Content);

      // Inbox response #2 — parentUuid points to uuid-inbox1-2
      const inbox2Content = [
        systemEventWithUuid('inbox-response-2', 'uuid-inbox2-1', 'uuid-inbox1-2'),
        userMessageEvent('Another inbox message'),
        assistantEventWithUuid('Processing second inbox message', 'uuid-inbox2-2'),
      ].join('\n') + '\n';
      // Write with a small delay to ensure different mtime
      await writeSubagentJsonl(sid, CWD, 'agent-inbox2.jsonl', inbox2Content);

      const allFiles = findAllSubagentJsonlsForAgent(sid, CWD, 'reader', mainPath);

      // Should find 3 files: main + inbox1 + inbox2
      expect(allFiles).toHaveLength(3);

      // Sorted by mtime (oldest first)
      expect(allFiles[0]).toContain('agent-main.jsonl');
      // inbox1 and inbox2 should both be found (order depends on write time)
      const fileNames = allFiles.map(f => path.basename(f));
      expect(fileNames).toContain('agent-inbox1.jsonl');
      expect(fileNames).toContain('agent-inbox2.jsonl');
    });
  });

  describe('inbox operations', () => {
    it('writeToInbox and readInbox round-trip', async () => {
      await writeToInbox(TEAM_NAME, 'researcher', 'Hello from test', 'tester');
      const inbox = readInbox(TEAM_NAME, 'researcher');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].text).toBe('Hello from test');
      expect(inbox[0].from).toBe('tester');
      expect(inbox[0].read).toBe(false);
    });
  });
});

// ── Group C: session-chat.ts Team RPC Integration Tests ──

describe('C. session-chat.ts team RPCs', () => {
  it('C13. session:team-info returns members from team config', async () => {
    const config = buildTeamConfig();
    await writeTeamConfig(config);

    const ws = await connectWs();
    try {
      const result = await sendRpc(ws, 'session:team-info', {
        sessionId: SESSION_ID,
        teamName: TEAM_NAME,
      });

      expect(result.teamName).toBe(TEAM_NAME);
      expect(Array.isArray(result.members)).toBe(true);
      const members = result.members as Array<{ name: string; isLead: boolean; model: string }>;
      expect(members.length).toBe(4);

      // Lead should be marked
      const lead = members.find(m => m.name === 'team-lead');
      expect(lead).toBeDefined();
      expect(lead!.isLead).toBe(true);

      // Non-lead members
      const researcher = members.find(m => m.name === 'researcher');
      expect(researcher).toBeDefined();
      expect(researcher!.isLead).toBe(false);
      expect(researcher!.model).toBe('sonnet');
    } finally {
      ws.close();
    }
  });

  it('C14. session:team-info falls back to lead JSONL when config deleted', async () => {
    // Setup: write lead JSONL, but do NOT write team config (simulates TeamDelete)
    const fallbackTeam = 'deleted-team';
    const fallbackSid = 'fallback-session-001';
    const fallbackCwd = '/home/user/fallback-project';

    // Build a lead JSONL with Agent calls referencing the fallback team
    const lines = [
      systemInitEvent(fallbackSid),
      assistantToolUseEvent('Agent', 'fb-001', {
        team_name: fallbackTeam,
        name: 'alpha',
        prompt: 'Do alpha work',
        model: 'sonnet',
        subagent_type: 'general-purpose',
      }),
      assistantToolUseEvent('Agent', 'fb-002', {
        team_name: fallbackTeam,
        name: 'beta',
        prompt: 'Do beta work',
        model: 'haiku',
        subagent_type: 'general-purpose',
      }),
      resultEvent(fallbackSid, 'Done'),
    ];
    await writeLeadJsonl(fallbackSid, fallbackCwd, lines.join('\n') + '\n');

    // Register a session record so session:team-info can find the cwd
    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord(fallbackSid, '', '', fallbackCwd);

    const ws = await connectWs();
    try {
      const result = await sendRpc(ws, 'session:team-info', {
        sessionId: fallbackSid,
        teamName: fallbackTeam,
      });

      expect(result.teamName).toBe(fallbackTeam);
      const members = result.members as Array<{ name: string; model: string }>;
      expect(members.length).toBe(2);
      expect(members.find(m => m.name === 'alpha')).toBeDefined();
      expect(members.find(m => m.name === 'beta')).toBeDefined();
    } finally {
      ws.close();
    }
  });

  it('C15. session:team-agent-subscribe returns events from JSONL files', async () => {
    const subSid = 'subscribe-test-001';
    const subCwd = '/home/user/subscribe-project';
    const subTeam = 'subscribe-team';

    // Write team config
    const config = buildTeamConfig({
      name: subTeam,
      leadSessionId: subSid,
      members: [
        { agentId: 'lead', name: 'lead', agentType: 'general-purpose', model: 'opus' },
        { agentId: 'worker', name: 'worker', agentType: 'general-purpose', model: 'sonnet' },
      ],
    });
    await writeTeamConfig(config);

    // Write a subagent JSONL for the worker
    const workerContent = buildSubagentJsonl('worker', 'Do the work', 'uuid-worker');
    await writeSubagentJsonl(subSid, subCwd, 'agent-worker.jsonl', workerContent);

    // Register session record
    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord(subSid, '', '', subCwd);

    const ws = await connectWs();
    try {
      const result = await sendRpc(ws, 'session:team-agent-subscribe', {
        sessionId: subSid,
        agentName: 'worker',
        teamName: subTeam,
      });

      const events = result.events as Array<{ type: string; text?: string }>;
      // Should have at least system + user + assistant events
      expect(events.length).toBeGreaterThanOrEqual(2);

      // Should contain text from the subagent JSONL
      const textEvent = events.find(e => e.type === 'text');
      expect(textEvent).toBeDefined();
      expect(textEvent!.text).toContain('Do the work');
    } finally {
      // Cleanup poller
      await sendRpc(ws, 'session:team-agent-unsubscribe', { sessionId: subSid }).catch(() => {});
      ws.close();
    }
  });

  it('C16. session:team-agent-subscribe returns empty + error for missing JSONL (remote ENOENT)', async () => {
    const remoteSid = 'remote-no-jsonl-001';
    const remoteCwd = '/home/remote/project';
    const remoteTeam = 'remote-team';

    // Write team config but NO subagent JSONL (simulates remote session where files are on remote host)
    const config = buildTeamConfig({
      name: remoteTeam,
      leadSessionId: remoteSid,
      members: [
        { agentId: 'lead', name: 'lead', agentType: 'general-purpose', model: 'opus' },
        { agentId: 'remote-worker', name: 'remote-worker', agentType: 'general-purpose', model: 'sonnet' },
      ],
    });
    await writeTeamConfig(config);

    // Register session record
    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord(remoteSid, '', '', remoteCwd);

    const ws = await connectWs();
    try {
      const result = await sendRpc(ws, 'session:team-agent-subscribe', {
        sessionId: remoteSid,
        agentName: 'remote-worker',
        teamName: remoteTeam,
      });

      // Should return empty events with error
      const events = result.events as unknown[];
      expect(events).toHaveLength(0);
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe('string');
      expect((result.error as string).toLowerCase()).toContain('not found');
    } finally {
      ws.close();
    }
  });

  it('C-extra. session:team-info returns empty when no teamName provided', async () => {
    const ws = await connectWs();
    try {
      const result = await sendRpc(ws, 'session:team-info', {
        sessionId: SESSION_ID,
        // no teamName
      });

      expect(result.teamName).toBeNull();
      expect((result.members as unknown[]).length).toBe(0);
    } finally {
      ws.close();
    }
  });
});

// ── Group D: Remote Session Bug Reproductions ──

describe('D. Remote session bug reproductions', () => {
  it('D17. isProcessAliveAsync(remotePid, "ssh") returns false for unknown PID', async () => {
    // Remote PIDs are on the remote host — locally they don't exist.
    // Use a PID that is very unlikely to exist (high number)
    const fakePid = 9999999;
    const alive = await isProcessAliveAsync(fakePid, 'ssh');
    expect(alive).toBe(false);
  });

  it('D18. process.kill(-remotePid) is no-op for non-existent PID (orphan kill)', () => {
    // Health monitor calls process.kill(-pid, 'SIGTERM') for orphan cleanup.
    // For remote PIDs that don't exist locally, this should throw ESRCH (no such process).
    const fakePid = 9999998;
    let threw = false;
    try {
      process.kill(-fakePid, 'SIGTERM');
    } catch (err: unknown) {
      threw = true;
      expect((err as NodeJS.ErrnoException).code).toBe('ESRCH');
    }
    expect(threw).toBe(true);
  });

  it('D19. getLeadSessionJsonlPath returns local path that does not exist for remote cwd', () => {
    // Remote sessions have cwd like /home/user/remote-project on the remote host.
    // getLeadSessionJsonlPath constructs a LOCAL path under CLAUDE_HOME that won't exist.
    const remoteCwd = '/home/remote-user/workspace/my-project';
    const remoteSid = 'remote-session-xyz';

    const jsonlPath = getLeadSessionJsonlPath(remoteSid, remoteCwd);

    // Path should be constructed but the file won't exist
    expect(jsonlPath).toContain(CLAUDE_HOME);
    expect(jsonlPath).toContain(remoteSid);
    expect(jsonlPath).toMatch(/\.jsonl$/);
    expect(fsSync.existsSync(jsonlPath)).toBe(false);
  });

  it('D20. Team freeze scenario — stream stops after result event, subagent data unreachable', async () => {
    // Reproduce the exact sequence that caused the 47-minute freeze:
    // 1. Lead session dispatches 3 agents → result event → stream stops
    // 2. Subagent JSONL is on remote host → local findSubagentJsonlByPrompt returns null
    // 3. session:team-agent-subscribe returns empty

    const freezeSid = 'freeze-session-b8ef03d0';
    const freezeCwd = '/home/clouddev/investigation';
    const freezeTeam = 'freeze-investigation';

    // Build lead JSONL with 3 agent dispatches (as if session completed its dispatch turn)
    const leadLines = [
      systemInitEvent(freezeSid),
      assistantToolUseEvent('TeamCreate', 'tc-freeze', {
        team_name: freezeTeam,
      }),
      userToolResultEvent('tc-freeze', 'Team created'),
      assistantToolUseEvent('Agent', 'freeze-a1', {
        team_name: freezeTeam, name: 'log-checker', prompt: 'Check CloudWatch logs for errors',
        model: 'sonnet', subagent_type: 'general-purpose',
      }),
      assistantToolUseEvent('Agent', 'freeze-a2', {
        team_name: freezeTeam, name: 'config-analyzer', prompt: 'Analyze IAM configs for misconfigurations',
        model: 'sonnet', subagent_type: 'general-purpose',
      }),
      assistantToolUseEvent('Agent', 'freeze-a3', {
        team_name: freezeTeam, name: 'report-writer', prompt: 'Compile findings into a report',
        model: 'haiku', subagent_type: 'general-purpose',
      }),
      // Result event — at this point Walnut sees isStreaming: false
      resultEvent(freezeSid, 'All 3 agents dispatched. They are working in the background.'),
    ];
    await writeLeadJsonl(freezeSid, freezeCwd, leadLines.join('\n') + '\n');

    // NO subagent JSONL files written locally — they're on the remote host
    // (This is the core of the bug: files exist only on the clouddev machine)

    // Write team config (exists because TeamCreate was called)
    const freezeConfig = buildTeamConfig({
      name: freezeTeam,
      leadSessionId: freezeSid,
      members: [
        { agentId: 'lead', name: 'team-lead', agentType: 'general-purpose', model: 'opus' },
        { agentId: 'lc', name: 'log-checker', agentType: 'general-purpose', model: 'sonnet' },
        { agentId: 'ca', name: 'config-analyzer', agentType: 'general-purpose', model: 'sonnet' },
        { agentId: 'rw', name: 'report-writer', agentType: 'general-purpose', model: 'haiku' },
      ],
    });
    await writeTeamConfig(freezeConfig);

    // Register session record (host='clouddev' → remote session)
    const { createSessionRecord } = await import('../../src/core/session-tracker.js');
    await createSessionRecord(freezeSid, '', '', freezeCwd, { host: 'clouddev' });

    // Verify: extractTeamsFromLeadJsonl CAN find the agents from the lead JSONL
    const leadPath = getLeadSessionJsonlPath(freezeSid, freezeCwd);
    const teams = extractTeamsFromLeadJsonl(leadPath);
    expect(teams.has(freezeTeam)).toBe(true);
    expect(teams.get(freezeTeam)!).toHaveLength(3);

    // Verify: all agents have status 'calling' (no tool_result)
    const agents = teams.get(freezeTeam)!;
    expect(agents.every(a => a.status === 'calling')).toBe(true);

    // Verify: findSubagentJsonlByPrompt returns null for all agents (files are remote)
    for (const agent of agents) {
      const jsonlPath = findSubagentJsonlByPrompt(freezeSid, freezeCwd, agent.fullPrompt);
      expect(jsonlPath).toBeNull();
    }

    // Verify: session:team-agent-subscribe returns empty events for all agents
    const ws = await connectWs();
    try {
      for (const agentName of ['log-checker', 'config-analyzer', 'report-writer']) {
        const result = await sendRpc(ws, 'session:team-agent-subscribe', {
          sessionId: freezeSid,
          agentName,
          teamName: freezeTeam,
        });

        const events = result.events as unknown[];
        expect(events).toHaveLength(0);
        expect(result.error).toBeDefined();
      }
    } finally {
      ws.close();
    }

    // This proves the freeze: once the result event fires (isStreaming=false),
    // and subagent JSONL files only exist on the remote host,
    // the frontend has NO way to get subagent progress data.
  });
});
