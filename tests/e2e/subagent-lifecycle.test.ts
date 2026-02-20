/**
 * E2E test: Subagent system lifecycle.
 *
 * Tests:
 * 1. Agent Registry CRUD (builtin + config)
 * 2. Embedded session start → subagent:started + subagent:result via WebSocket
 * 3. list_sessions includes embedded runs
 * 4. send_to_session with run_id resumes embedded run
 * 5. Agent CRUD tools (list_agents, create_agent, etc.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import { WebSocket } from 'ws';

// ── Mock constants → tmpdir ──
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants());

// ── Mock runAgentLoop → no Bedrock calls ──
vi.mock('../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (
    message: string,
    history: unknown[],
    callbacks?: { onText?: (t: string) => void; onTextDelta?: (d: string) => void },
    _options?: unknown,
  ) => {
    const response = `Mock result for: ${message.slice(0, 200)}`;
    callbacks?.onText?.(response);
    return {
      messages: [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: [{ type: 'text', text: response }] },
      ],
      response,
    };
  }),
}));

// ── Mock buildSystemPrompt → avoid real config/memory ──
vi.mock('../../src/agent/context.js', () => ({
  buildSystemPrompt: vi.fn(async () => 'Mock system prompt'),
  buildRoleSection: vi.fn(() => 'Mock role section'),
  buildMemoryContext: vi.fn(() => 'Mock memory context'),
}));

// ── Imports (after mocks) ──
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import {
  getAllAgents,
  getAgent,
  createAgent,
  deleteAgent,
  _resetForTest as resetAgentRegistry,
} from '../../src/core/agent-registry.js';
import { subagentRunner } from '../../src/providers/subagent-runner.js';
import { executeTool } from '../../src/agent/tools.js';
import { addTask, getTask } from '../../src/core/task-manager.js';

// ── Helpers ──

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

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 15000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs);
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

function collectWsEvents(ws: WebSocket, eventNames: string[]): WsFrame[] {
  const events: WsFrame[] = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as WsFrame;
    if (frame.type === 'event' && eventNames.includes(frame.name!)) {
      events.push(frame);
    }
  });
  return events;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  // Create required directories
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });

  // Write minimal config
  await fs.writeFile(
    `${WALNUT_HOME}/config.yaml`,
    'version: 1\nuser:\n  name: Test User\ndefaults:\n  priority: none\n  category: Inbox\nprovider:\n  type: bedrock\n',
  );

  // Write empty tasks store
  const tasksDir = `${WALNUT_HOME}/tasks`;
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(`${tasksDir}/tasks.json`, JSON.stringify({ version: 2, tasks: [] }));

  // Reset agent registry before starting server
  resetAgentRegistry();

  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
}, 15000);

// ── Tests ──

describe('Agent Registry', () => {
  it('should have built-in general agent', async () => {
    const agents = await getAllAgents();
    const general = agents.find((a) => a.id === 'general');
    expect(general).toBeDefined();
    expect(general!.name).toBe('General Agent');
    expect(general!.runner).toBe('embedded');
    expect(general!.source).toBe('builtin');
  });

  it('should create a config agent', async () => {
    const agent = await createAgent({
      id: 'researcher',
      name: 'Research Agent',
      description: 'Searches and summarizes findings',
      runner: 'embedded',
      denied_tools: ['exec', 'write', 'edit'],
    });
    expect(agent.id).toBe('researcher');
    expect(agent.source).toBe('config');
  });

  it('should list all agents including config', async () => {
    const agents = await getAllAgents();
    expect(agents.length).toBeGreaterThanOrEqual(2);
    expect(agents.map((a) => a.id)).toContain('general');
    expect(agents.map((a) => a.id)).toContain('researcher');
  });

  it('should get single agent by ID', async () => {
    const agent = await getAgent('researcher');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('Research Agent');
    expect(agent!.denied_tools).toEqual(['exec', 'write', 'edit']);
  });

  it('should persist config agents to config.yaml', async () => {
    const yaml = await import('js-yaml');
    const content = await fs.readFile(`${WALNUT_HOME}/config.yaml`, 'utf-8');
    const config = yaml.load(content) as { agent?: { agents?: { id: string }[] } };
    const agents = config.agent?.agents ?? [];
    expect(agents.some((a) => a.id === 'researcher')).toBe(true);
  });

  it('should delete a config agent', async () => {
    await deleteAgent('researcher');
    const agent = await getAgent('researcher');
    expect(agent).toBeUndefined();
  });

  it('should not delete builtin agent', async () => {
    await expect(deleteAgent('general')).rejects.toThrow('builtin-defined');
  });
});

describe('Agent CRUD Tools', () => {
  it('list_agents returns built-in agents', async () => {
    const result = await executeTool('list_agents', {});
    const agents = JSON.parse(result);
    expect(agents).toBeInstanceOf(Array);
    expect(agents.find((a: { id: string }) => a.id === 'general')).toBeDefined();
  });

  it('create_agent creates a config agent via tool', async () => {
    const result = await executeTool('create_agent', {
      id: 'quick',
      name: 'Quick Agent',
      description: 'Fast, cheap tasks',
      runner: 'embedded',
      max_tool_rounds: 3,
    });
    expect(result).toContain('quick');
    expect(result).toContain('Quick Agent');
  });

  it('get_agent returns the created agent', async () => {
    const result = await executeTool('get_agent', { agent_id: 'quick' });
    const agent = JSON.parse(result);
    expect(agent.id).toBe('quick');
    expect(agent.name).toBe('Quick Agent');
    expect(agent.max_tool_rounds).toBe(3);
  });

  it('delete_agent removes the config agent', async () => {
    const result = await executeTool('delete_agent', { agent_id: 'quick' });
    expect(result).toContain('deleted');

    const getResult = await executeTool('get_agent', { agent_id: 'quick' });
    expect(getResult).toContain('not found');
  });
});

describe('Embedded Session Lifecycle', () => {
  it('start_session with runner=embedded emits subagent events via WebSocket', async () => {
    const ws = await connectWs();
    const events = collectWsEvents(ws, [
      'subagent:started',
      'subagent:result',
      'subagent:error',
    ]);

    // Start an embedded session by emitting subagent:start (what start_session tool does)
    bus.emit(EventNames.SUBAGENT_START, {
      agentId: 'general',
      task: 'Summarize the current tasks',
      taskId: undefined,
    }, ['subagent-runner'], { source: 'test' });

    // Wait for result event on WebSocket
    const resultEvent = await waitForWsEvent(ws, 'subagent:result', 20000);

    // Verify event data
    const data = resultEvent.data as Record<string, unknown>;
    expect(data.agentId).toBe('general');
    expect(data.agentName).toBe('General Agent');
    expect(data.result).toBeDefined();
    expect(typeof data.result).toBe('string');
    expect(data.runId).toBeDefined();

    // Verify we got subagent:started before result
    expect(events.some((e) => e.name === 'subagent:started')).toBe(true);

    // Verify run is tracked in SubagentRunner
    const runs = subagentRunner.getAllRuns();
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const completedRun = runs.find((r) => r.runId === data.runId);
    expect(completedRun).toBeDefined();
    expect(completedRun!.status).toBe('completed');
    expect(completedRun!.result).toBeDefined();

    ws.close();
  }, 30000);

  it('list_sessions tool includes embedded runs', async () => {
    const result = await executeTool('list_sessions', { runner: 'embedded' });
    const sessions = JSON.parse(result);
    expect(sessions).toBeInstanceOf(Array);
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    const embeddedRun = sessions[0];
    expect(embeddedRun.runner).toBe('embedded');
    expect(embeddedRun.agent_id).toBe('general');
    expect(embeddedRun.status).toBe('completed');
  });

  it('get_session_history with run_id returns embedded run details', async () => {
    const runs = subagentRunner.getAllRuns();
    const run = runs[0];
    expect(run).toBeDefined();

    const result = await executeTool('get_session_history', { run_id: run.runId });
    const parsed = JSON.parse(result);
    expect(parsed.run_id).toBe(run.runId);
    expect(parsed.agent_id).toBe('general');
    expect(parsed.status).toBe('completed');
  });

  it('start_session tool with runner=embedded works end-to-end', async () => {
    const ws = await connectWs();

    // Use the start_session tool directly with runner=embedded
    const result = await executeTool('start_session', {
      prompt: 'Research TypeScript 6.0 features',
      runner: 'embedded',
      agent_id: 'general',
    });

    expect(result).toContain('Embedded session started');
    expect(result).toContain('general');

    // Wait for subagent result
    const resultEvent = await waitForWsEvent(ws, 'subagent:result', 20000);
    const data = resultEvent.data as Record<string, unknown>;
    expect(data.result).toBeDefined();
    expect(typeof data.result).toBe('string');

    ws.close();
  }, 30000);

  it('send_to_session with run_id resumes embedded run', async () => {
    const ws = await connectWs();

    const runs = subagentRunner.getAllRuns();
    const completedRun = runs.find((r) => r.status === 'completed');
    expect(completedRun).toBeDefined();

    // Resume with run_id
    const result = await executeTool('send_to_session', {
      run_id: completedRun!.runId,
      message: 'Give me more details',
    });
    expect(result).toContain('Resuming in the background');

    // Wait for the resumed run's result
    const resultEvent = await waitForWsEvent(ws, 'subagent:result', 20000);
    const data = resultEvent.data as Record<string, unknown>;
    expect(data.runId).toBe(completedRun!.runId);
    expect(data.result).toBeDefined();

    ws.close();
  }, 30000);
});

describe('Embedded session links to task', () => {
  it('embedded session populates task.exec_session_id and task.session_ids', async () => {
    const ws = await connectWs();

    // Create a task to link the embedded session to
    const { task } = await addTask({ title: 'Task for embedded session test', category: 'Inbox' });

    // Verify task starts with no sessions
    const beforeTask = await getTask(task.id);
    expect(beforeTask.exec_session_id).toBeUndefined();
    expect(beforeTask.session_ids).toEqual([]);

    // Start an embedded session linked to this task
    bus.emit(EventNames.SUBAGENT_START, {
      agentId: 'general',
      task: 'Do something for the task',
      taskId: task.id,
    }, ['subagent-runner'], { source: 'test' });

    // Wait for the session to complete
    const resultEvent = await waitForWsEvent(ws, 'subagent:result', 20000);
    const data = resultEvent.data as Record<string, unknown>;
    expect(data.runId).toBeDefined();

    // Verify the task now has the session linked
    const afterTask = await getTask(task.id);
    expect(afterTask.exec_session_id).toBe(data.runId);
    expect(afterTask.session_ids).toContain(data.runId as string);

    ws.close();
  }, 30000);
});

describe('start_session tool backward compat', () => {
  it('start_session without runner defaults to CLI', async () => {
    // With no runner/agent_id, should try CLI path → requires working_directory
    const result = await executeTool('start_session', {
      prompt: 'Hello world',
    });
    expect(result).toContain('working_directory is required');
  });

  it('start_session with agent_id defaults to embedded', async () => {
    const ws = await connectWs();

    const result = await executeTool('start_session', {
      prompt: 'Quick task',
      agent_id: 'general',
    });
    expect(result).toContain('Embedded session started');

    // Confirm it actually runs
    await waitForWsEvent(ws, 'subagent:result', 20000);
    ws.close();
  }, 30000);
});
