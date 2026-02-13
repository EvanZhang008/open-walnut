/**
 * process tool — manage background bash process sessions.
 * Actions: list, read, send, kill.
 */
import type { ToolDefinition } from "../tools.js";
import {
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markExited,
} from "../../core/bash-process-registry.js";

export function createProcessTool(): ToolDefinition {
  return {
    name: "process",
    description:
      "Manage background process sessions. Actions: list (show running + finished), read (get output), send (write to stdin), kill (terminate).",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "send", "kill"],
          description: "Process action to perform",
        },
        session_id: {
          type: "string",
          description: "Session ID (required for read, send, kill)",
        },
        input: {
          type: "string",
          description: "Data to write to stdin (for send action)",
        },
      },
      required: ["action"],
    },
    async execute(params) {
      const action = params.action as string;

      if (action === "list") {
        const running = listRunningSessions().map((s) => ({
          session_id: s.id,
          command: s.command,
          status: "running" as const,
          pid: s.pid,
          started_at: s.startedAt,
          runtime_ms: Date.now() - s.startedAt,
          cwd: s.cwd,
          tail: s.tail,
          truncated: s.truncated,
        }));
        const finished = listFinishedSessions().map((s) => ({
          session_id: s.id,
          command: s.command,
          status: s.status,
          started_at: s.startedAt,
          ended_at: s.endedAt,
          runtime_ms: s.endedAt - s.startedAt,
          cwd: s.cwd,
          exit_code: s.exitCode,
          exit_signal: s.exitSignal,
          tail: s.tail,
          truncated: s.truncated,
        }));
        const all = [...running, ...finished];
        if (all.length === 0) {
          return "No running or recent sessions.";
        }
        return JSON.stringify(all, null, 2);
      }

      const sessionId = params.session_id as string | undefined;
      if (!sessionId) {
        return "Error: session_id is required for this action.";
      }

      if (action === "read") {
        const session = getSession(sessionId);
        if (session) {
          if (!session.backgrounded) {
            return `Session ${sessionId} is not backgrounded.`;
          }
          const { stdout, stderr } = drainSession(session);
          const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
          const exited = session.exited;
          const exitInfo = exited
            ? `\n\nProcess exited with ${
                session.exitSignal
                  ? `signal ${session.exitSignal}`
                  : `code ${session.exitCode ?? 0}`
              }.`
            : "\n\nProcess still running.";
          return (output || "(no new output)") + exitInfo;
        }
        const finished = getFinishedSession(sessionId);
        if (finished) {
          const exitInfo = `\n\nProcess exited with ${
            finished.exitSignal
              ? `signal ${finished.exitSignal}`
              : `code ${finished.exitCode ?? 0}`
          }.`;
          return (finished.aggregated || "(no output recorded)") + exitInfo;
        }
        return `No session found for ${sessionId}.`;
      }

      if (action === "send") {
        const session = getSession(sessionId);
        if (!session) {
          return `No active session found for ${sessionId}.`;
        }
        if (!session.backgrounded) {
          return `Session ${sessionId} is not backgrounded.`;
        }
        const stdin = session.stdin ?? session.child?.stdin;
        if (!stdin || stdin.destroyed) {
          return `Session ${sessionId} stdin is not writable.`;
        }
        const data = (params.input as string) ?? "";
        await new Promise<void>((resolve, reject) => {
          stdin.write(data, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        return `Wrote ${data.length} bytes to session ${sessionId}.`;
      }

      if (action === "kill") {
        const session = getSession(sessionId);
        if (!session) {
          return `No active session found for ${sessionId}.`;
        }
        if (!session.backgrounded) {
          return `Session ${sessionId} is not backgrounded.`;
        }
        try {
          if (session.child) {
            session.child.kill("SIGKILL");
          } else if (session.pid) {
            process.kill(session.pid, "SIGKILL");
          }
        } catch {
          // Process may already be dead
        }
        markExited(session, null, "SIGKILL", "killed");
        return `Killed session ${sessionId}.`;
      }

      return `Error: Unknown action "${action}". Use list, read, send, or kill.`;
    },
  };
}
