import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  addSession,
  appendOutput,
  markBackgrounded,
  markExited,
  resetProcessRegistryForTests,
  type ProcessSession,
} from "../../../src/core/bash-process-registry.js";
import { createProcessTool } from "../../../src/agent/tools/process-tool.js";

const tool = createProcessTool();

function makeSession(overrides: Partial<ProcessSession> = {}): ProcessSession {
  return {
    id: overrides.id ?? "test-001",
    command: overrides.command ?? "echo hello",
    pid: overrides.pid ?? 12345,
    startedAt: overrides.startedAt ?? Date.now(),
    cwd: overrides.cwd ?? "/tmp",
    maxOutputChars: overrides.maxOutputChars ?? 100_000,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    truncated: false,
    backgrounded: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetProcessRegistryForTests();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

describe("process tool - list action", () => {
  it("returns empty message when no sessions", async () => {
    const result = await tool.execute({ action: "list" });
    expect(result).toBe("No running or recent sessions.");
  });

  it("lists running backgrounded sessions", async () => {
    const session = makeSession({ id: "abc-001", command: "npm test" });
    addSession(session);
    markBackgrounded(session);

    const result = await tool.execute({ action: "list" });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].session_id).toBe("abc-001");
    expect(parsed[0].command).toBe("npm test");
    expect(parsed[0].status).toBe("running");
    expect(parsed[0].pid).toBe(12345);
  });

  it("lists finished sessions", async () => {
    const session = makeSession({ id: "fin-001", command: "ls" });
    addSession(session);
    markBackgrounded(session);
    markExited(session, 0, null, "completed");

    const result = await tool.execute({ action: "list" });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].session_id).toBe("fin-001");
    expect(parsed[0].status).toBe("completed");
    expect(parsed[0].exit_code).toBe(0);
  });

  it("lists both running and finished sessions", async () => {
    const running = makeSession({ id: "run-001", command: "npm start" });
    addSession(running);
    markBackgrounded(running);

    const done = makeSession({ id: "done-001", command: "npm build" });
    addSession(done);
    markBackgrounded(done);
    markExited(done, 0, null, "completed");

    const result = await tool.execute({ action: "list" });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(2);
    const ids = parsed.map((s: { session_id: string }) => s.session_id);
    expect(ids).toContain("run-001");
    expect(ids).toContain("done-001");
  });
});

describe("process tool - read action", () => {
  it("returns error without session_id", async () => {
    const result = await tool.execute({ action: "read" });
    expect(result).toContain("session_id is required");
  });

  it("returns no session found for unknown id", async () => {
    const result = await tool.execute({ action: "read", session_id: "unknown" });
    expect(result).toContain("No session found");
  });

  it("reads output from a running backgrounded session", async () => {
    const session = makeSession({ id: "read-001" });
    addSession(session);
    markBackgrounded(session);
    appendOutput(session, "stdout", "hello world\n");

    const result = await tool.execute({ action: "read", session_id: "read-001" });
    expect(result).toContain("hello world");
    expect(result).toContain("Process still running");
  });

  it("reads output from a finished session", async () => {
    const session = makeSession({ id: "read-fin" });
    addSession(session);
    markBackgrounded(session);
    appendOutput(session, "stdout", "output before exit\n");
    markExited(session, 0, null, "completed");

    const result = await tool.execute({ action: "read", session_id: "read-fin" });
    expect(result).toContain("output before exit");
    expect(result).toContain("Process exited with code 0");
  });
});

describe("process tool - send action", () => {
  it("returns error for unknown session", async () => {
    const result = await tool.execute({ action: "send", session_id: "nope", input: "data" });
    expect(result).toContain("No active session");
  });

  it("sends data to stdin", async () => {
    const written: string[] = [];
    const session = makeSession({
      id: "send-001",
      stdin: {
        write: (data: string, cb?: (err?: Error | null) => void) => {
          written.push(data);
          cb?.();
        },
        end: () => {},
        destroyed: false,
      },
    });
    addSession(session);
    markBackgrounded(session);

    const result = await tool.execute({ action: "send", session_id: "send-001", input: "test\n" });
    expect(result).toContain("Wrote 5 bytes");
    expect(written).toEqual(["test\n"]);
  });
});

describe("process tool - kill action", () => {
  it("returns error for unknown session", async () => {
    const result = await tool.execute({ action: "kill", session_id: "nope" });
    expect(result).toContain("No active session");
  });

  it("kills a running session", async () => {
    let killed = false;
    const session = makeSession({
      id: "kill-001",
      child: {
        kill: () => {
          killed = true;
          return true;
        },
        stdin: null as unknown as NodeJS.WritableStream,
        stdout: null as unknown as NodeJS.ReadableStream,
        stderr: null as unknown as NodeJS.ReadableStream,
        pid: 99999,
      } as unknown as import("node:child_process").ChildProcessWithoutNullStreams,
    });
    addSession(session);
    markBackgrounded(session);

    const result = await tool.execute({ action: "kill", session_id: "kill-001" });
    expect(result).toContain("Killed session kill-001");
    expect(killed).toBe(true);
  });
});

describe("process tool - unknown action", () => {
  it("returns error for unknown action", async () => {
    const result = await tool.execute({ action: "invalid", session_id: "any" });
    expect(result).toContain('Unknown action "invalid"');
  });
});
