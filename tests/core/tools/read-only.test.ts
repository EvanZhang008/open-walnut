/**
 * The read-only tool belt handed to an in-process model turn.
 *
 * Two things are load-bearing here and neither can be seen by reading one file:
 * the belt is DERIVED from the op registry's `readonly` tag (so a new write op
 * cannot leak into an unattended caller by default), and a tool's execute goes
 * through executeOp (so there is one set of validations, not two).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listOps, opNames } from '../../../src/ops/index.js';
import {
  getReadOnlyTools,
  getToolSchemas,
  readOnlyToolNames,
  READ_ONLY_TOOL_NAMES,
} from '../../../src/core/tools/read-only.js';

describe('the read-only belt is derived from the registry', () => {
  it('carries exactly the ops tagged readonly', () => {
    const belt = getReadOnlyTools().map((t) => t.name).sort();
    expect(belt).toEqual([...opNames({ readonly: true })].sort());
    expect(belt.length).toBeGreaterThan(5);
  });

  it('leaks no write op — not one', () => {
    const writeOps = listOps().filter((op) => !op.tags.readonly).map((op) => op.name);
    expect(writeOps.length).toBeGreaterThan(0);
    const belt = new Set(getReadOnlyTools().map((t) => t.name));
    for (const name of writeOps) expect(belt.has(name)).toBe(false);
  });

  it('gives every tool a described JSON-schema object input', () => {
    for (const tool of getReadOnlyTools()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.input_schema.type).toBe('object');
      // A provider rejects a schema whose properties are not an object.
      expect(typeof tool.input_schema.properties).toBe('object');
      expect(tool.input_schema.$schema).toBeUndefined();
    }
  });

  it('marks every read-only tool parallelSafe, so a batch of them overlaps', () => {
    for (const tool of getReadOnlyTools()) expect(tool.parallelSafe).toBe(true);
  });

  it('answers the same set as names and as a frozen constant', () => {
    const names = readOnlyToolNames();
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual([...names].sort());
    // The names callers actually gate on today.
    for (const name of ['task_list', 'task_get', 'search', 'task_history']) {
      expect(names.has(name)).toBe(true);
    }
    expect(names.has('task_create')).toBe(false);
    expect(names.has('task_delete')).toBe(false);
  });

  it('getToolSchemas lists the belt (plus plugin tools) as name/description/schema only', () => {
    const schemas = getToolSchemas();
    const beltNames = getReadOnlyTools().map((t) => t.name);
    for (const name of beltNames) expect(schemas.some((s) => s.name === name)).toBe(true);
    for (const schema of schemas) {
      expect(Object.keys(schema).sort()).toEqual(['description', 'input_schema', 'name']);
    }
  });
});

describe('execute routes through executeOp', () => {
  const executeOp = vi.fn();

  beforeEach(() => {
    executeOp.mockReset();
    vi.resetModules();
    // Keep the real registry (so the belt is still the real op set) and replace
    // only the executor.
    vi.doMock('../../../src/ops/index.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/ops/index.js')>('../../../src/ops/index.js');
      return { ...actual, executeOp };
    });
  });

  /** One read-only tool from a freshly imported belt (so the mock applies). */
  async function tool(name: string) {
    const mod = await import('../../../src/core/tools/read-only.js');
    const found = mod.getReadOnlyTools().find((t) => t.name === name);
    expect(found).toBeDefined();
    return found!;
  }

  it('calls the op by name with the model\'s params and returns pretty JSON', async () => {
    executeOp.mockResolvedValue({ ok: true, result: { count: 1, tasks: [{ id: 'abc' }] } });

    const result = await (await tool('task_list')).execute({ project: 'Marina' });

    expect(executeOp).toHaveBeenCalledWith('task_list', { project: 'Marina' });
    expect(result).toBe(JSON.stringify({ count: 1, tasks: [{ id: 'abc' }] }, null, 2));
  });

  it('passes {} when the model sends no params at all', async () => {
    executeOp.mockResolvedValue({ ok: true, result: [] });

    await (await tool('project_list')).execute(undefined as never);

    expect(executeOp).toHaveBeenCalledWith('project_list', {});
  });

  it('turns a failed op into an "Error:" string — the loop\'s error signal', async () => {
    executeOp.mockResolvedValue({ ok: false, message: 'Invalid arguments for task_list: limit: too small' });

    const result = await (await tool('task_list')).execute({ limit: 0 });

    // The micro-agent loop reads this prefix to set is_error on the tool_result.
    expect(result).toMatch(/^Error: /);
    expect(result).toContain('limit: too small');
  });
});
