/**
 * SubagentPoller — active-tab polling for team agent JSONL files.
 *
 * Only polls ONE agent at a time (the active tab in the frontend).
 * Local: reads from filesystem with byte offset tracking (2s interval).
 * Remote: reads via SSH with byte offset (5s interval).
 *
 * Emits parsed JSONL events tagged with agentName for the frontend.
 */

import fs from 'node:fs';
import { log } from '../logging/index.js';

const LOCAL_POLL_MS = 2000;
const REMOTE_POLL_MS = 5000;

export interface ParsedJsonlEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'system';
  // text events
  text?: string;
  // tool events
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  result?: string;
  // system events
  subtype?: string;
  model?: string;
}

export type OnSubagentEvent = (agentName: string, events: ParsedJsonlEvent[]) => void;

/**
 * Poll a local JSONL file from a byte offset.
 * Returns new JSONL lines and the updated offset.
 */
function pollLocalFile(filePath: string, offset: number): { newLines: string[]; newOffset: number } {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return { newLines: [], newOffset: offset };
  }

  try {
    const stat = fs.fstatSync(fd);
    if (stat.size <= offset) {
      return { newLines: [], newOffset: offset };
    }

    const buf = Buffer.alloc(stat.size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(Boolean);
    return { newLines: lines, newOffset: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a complete local JSONL file (for initial snapshot on tab open).
 */
export function readFullFile(filePath: string): { lines: string[]; offset: number } {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return { lines, offset: Buffer.byteLength(content) };
  } catch {
    return { lines: [], offset: 0 };
  }
}

/**
 * Build SSH command to read new bytes from a remote JSONL file.
 * Returns: "stat -f%z FILE && tail -c +OFFSET FILE" (macOS stat)
 * or "stat -c%s FILE && tail -c +OFFSET FILE" (Linux stat)
 */
function buildRemotePollCmd(filePath: string, offset: number): string {
  // Use wc -c for portable file size, then tail for new content
  return `size=$(wc -c < '${filePath}' 2>/dev/null || echo 0) && echo "$size" && [ "$size" -gt ${offset} ] && tail -c +${offset + 1} '${filePath}'`;
}

/**
 * Parse the output of buildRemotePollCmd.
 */
function parseRemotePollResult(output: string, currentOffset: number): { newLines: string[]; newOffset: number } {
  const lines = output.split('\n');
  const sizeLine = lines[0]?.trim();
  const newSize = parseInt(sizeLine || '0', 10);

  if (isNaN(newSize) || newSize <= currentOffset) {
    return { newLines: [], newOffset: currentOffset };
  }

  const newLines = lines.slice(1).filter(Boolean);
  return { newLines, newOffset: newSize };
}

/**
 * Parse JSONL lines into structured events for the frontend.
 */
export function parseJsonlLines(lines: string[]): ParsedJsonlEvent[] {
  const events: ParsedJsonlEvent[] = [];

  for (const line of lines) {
    try {
      const raw = JSON.parse(line);

      if (raw.type === 'system') {
        events.push({
          type: 'system',
          subtype: raw.subtype,
          model: raw.model,
        });
      } else if (raw.type === 'assistant' && Array.isArray(raw.message?.content)) {
        for (const block of raw.message.content) {
          if (block.type === 'text' && block.text) {
            events.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            events.push({
              type: 'tool_use',
              toolName: block.name,
              toolUseId: block.id,
              input: block.input,
            });
          }
        }
      } else if (raw.type === 'user' && Array.isArray(raw.message?.content)) {
        for (const block of raw.message.content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            const resultText = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.filter((c: { type: string }) => c.type === 'text').map((c: { text?: string }) => c.text).join('\n')
                : '';
            events.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              result: resultText,
            });
          }
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

/**
 * Active-tab poller — polls a single agent's JSONL file on a timer.
 * Only one instance should exist per session (managed by the session provider).
 */
export class ActiveTabPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentAgent: string | null = null;
  private currentPath: string | null = null;
  private offset = 0;
  private isRemote = false;
  private _polling = false;
  private onEvent: OnSubagentEvent;
  private sshExec?: (cmd: string) => Promise<string | null>;

  constructor(onEvent: OnSubagentEvent, sshExec?: (cmd: string) => Promise<string | null>) {
    this.onEvent = onEvent;
    this.sshExec = sshExec;
  }

  /**
   * Start polling a specific agent's JSONL file.
   * Stops any previous polling first.
   * Returns the initial snapshot of events from the full file.
   */
  subscribe(agentName: string, filePath: string, remote: boolean): ParsedJsonlEvent[] {
    this.stop();

    this.currentAgent = agentName;
    this.currentPath = filePath;
    this.isRemote = remote;
    this.offset = 0;

    // Read initial snapshot (local only — remote uses async subscribe)
    let initialEvents: ParsedJsonlEvent[] = [];
    if (!remote) {
      const { lines, offset } = readFullFile(filePath);
      this.offset = offset;
      initialEvents = parseJsonlLines(lines);
    }

    // Start polling timer
    const intervalMs = remote ? REMOTE_POLL_MS : LOCAL_POLL_MS;
    this.timer = setInterval(() => this.poll(), intervalMs);

    log.session.info('subagent poller subscribed', {
      agentName, filePath: filePath.slice(-60), remote, initialEvents: initialEvents.length,
    });

    return initialEvents;
  }

  /**
   * Async subscribe for remote agents — reads full file via SSH then starts polling.
   */
  async subscribeRemote(agentName: string, filePath: string): Promise<ParsedJsonlEvent[]> {
    this.stop();

    this.currentAgent = agentName;
    this.currentPath = filePath;
    this.isRemote = true;
    this.offset = 0;

    // Read initial snapshot via SSH
    let initialEvents: ParsedJsonlEvent[] = [];
    if (this.sshExec) {
      try {
        const result = await this.sshExec(`cat '${filePath}' 2>/dev/null`);
        if (result) {
          const lines = result.split('\n').filter(Boolean);
          this.offset = Buffer.byteLength(result);
          initialEvents = parseJsonlLines(lines);
        }
      } catch (err) {
        log.session.warn('remote subagent initial read failed', {
          agentName, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Start polling timer
    this.timer = setInterval(() => this.poll(), REMOTE_POLL_MS);

    log.session.info('subagent poller subscribed (remote)', {
      agentName, filePath: filePath.slice(-60), initialEvents: initialEvents.length,
    });

    return initialEvents;
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.currentAgent = null;
    this.currentPath = null;
    this.offset = 0;
  }

  /** Current subscribed agent name. */
  get activeAgent(): string | null {
    return this.currentAgent;
  }

  private async poll(): Promise<void> {
    if (!this.currentAgent || !this.currentPath) return;
    if (this._polling) return; // Prevent overlapping polls (remote can be slow)
    this._polling = true;

    try {
      if (this.isRemote) {
        await this.pollRemote();
      } else {
        this.pollLocal();
      }
    } catch (err) {
      log.session.debug('subagent poll error', {
        agent: this.currentAgent,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this._polling = false;
    }
  }

  private pollLocal(): void {
    if (!this.currentPath || !this.currentAgent) return;

    const { newLines, newOffset } = pollLocalFile(this.currentPath, this.offset);
    if (newLines.length === 0) return;

    this.offset = newOffset;
    const events = parseJsonlLines(newLines);
    if (events.length > 0) {
      this.onEvent(this.currentAgent, events);
    }
  }

  private async pollRemote(): Promise<void> {
    if (!this.currentPath || !this.currentAgent || !this.sshExec) return;

    const cmd = buildRemotePollCmd(this.currentPath, this.offset);
    const result = await this.sshExec(cmd);
    if (!result) return;

    const { newLines, newOffset } = parseRemotePollResult(result, this.offset);
    if (newLines.length === 0) return;

    this.offset = newOffset;
    const events = parseJsonlLines(newLines);
    if (events.length > 0) {
      this.onEvent(this.currentAgent, events);
    }
  }

  /** Destroy the poller (for cleanup). */
  destroy(): void {
    this.stop();
  }
}
