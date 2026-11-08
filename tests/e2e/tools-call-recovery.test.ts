import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants());
import { startServer, stopServer } from '../../src/web/server.js';
import { runTools } from '../../src/commands/tools.js';
import { spyCliStreams } from '../helpers/cli-streams.js';

let root: string;
let savedExit: typeof process.exitCode;
let savedSocket: string | undefined;
let output: string[];
let errors: string[];

beforeAll(async () => {
  const server = await startServer({ port: 0, dev: true });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server has no port');
  root = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await stopServer(); });
beforeEach(() => {
  savedExit = process.exitCode;
  savedSocket = process.env.WALNUT_AGENT_SOCKET;
  delete process.env.WALNUT_AGENT_SOCKET;
  process.exitCode = 0;
  output = [];
  errors = [];
  // A failure is written to the process streams, a success through console.log: both are caught.
  spyCliStreams({ out: (s) => output.push(s), err: (s) => errors.push(s) });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExit;
  if (savedSocket === undefined) delete process.env.WALNUT_AGENT_SOCKET;
  else process.env.WALNUT_AGENT_SOCKET = savedSocket;
});

describe('tools call against the real server', () => {
  it('shows the real reason, then a corrected read works on the same server', async () => {
    const before = await fetch(`${root}/api/tasks`).then((r) => r.json());
    await runTools(['call', 'search', '{"q":"controller","types":["task","session"]}', '--json'], {});
    expect(process.exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(output).toHaveLength(1);
    const failure = JSON.parse(output[0]);
    expect(failure.ok).toBe(false);
    expect(failure.error.code).toBe('invalid_arguments');
    expect(failure.error.message).toContain('"task,session", not a list');
    output = [];
    process.exitCode = 0;
    await runTools(['call', 'search', '{"q":"controller","types":"task,session"}', '--json'], {});
    expect(process.exitCode).toBe(0);
    expect(errors).toEqual([]);
    const result = JSON.parse(output.join('\n'));
    expect(Array.isArray(result.results)).toBe(true);
    const after = await fetch(`${root}/api/tasks`).then((r) => r.json());
    expect(after.tasks).toEqual(before.tasks);
  });

  it('default stderr keeps the real reason and a corrected call keeps the successful result shape', async () => {
    await runTools(['call', 'search', '{"q":"controller","types":["task","session"]}'], {});
    expect(process.exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toHaveLength(1);
    const failure = JSON.parse(errors[0]);
    expect(failure.error.code).toBe('invalid_arguments');
    expect(failure.error.message).toContain('"task,session", not a list');
    errors = [];
    process.exitCode = 0;
    await runTools(['call', 'search', '{"q":"controller","types":"task,session"}'], {});
    expect(process.exitCode).toBe(0);
    expect(errors).toEqual([]);
    const result = JSON.parse(output.join('\n'));
    expect(Array.isArray(result.results)).toBe(true);
    expect(result).not.toHaveProperty('ok');
  });

  it('a write with a wrong key is refused, never guessed or performed', async () => {
    const before = await fetch(`${root}/api/tasks`).then((r) => r.json());
    await runTools(['call', 'task_create', '{"titel":"Should not be created"}', '--json'], {});
    expect(process.exitCode).toBe(1);
    const failure = JSON.parse(output[0]);
    expect(failure.error.message).toContain('did you mean "title"');
    const after = await fetch(`${root}/api/tasks`).then((r) => r.json());
    expect(after.tasks).toEqual(before.tasks);
  });
});
