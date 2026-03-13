/**
 * SubagentPoller — active-tab polling for team agent JSONL files.
 *
 * Only polls ONE agent at a time (the active tab in the frontend).
 * Multi-file aware: tracks all JSONL files for an agent (main + inbox responses)
 * and periodically discovers new files created by inbox deliveries.
 *
 * Why multi-file? In Claude Code's in-process team mode, each inbox message
 * delivery creates a NEW JSONL file (new agentId, linked via parentUuid).
 * An agent receiving N inbox messages has N+1 files. The poller must:
 * 1. Track byte offsets for ALL known files (not just one)
 * 2. Periodically re-discover new files via findAllSubagentJsonlsForAgent()
 * 3. Read new files fully and emit their events when discovered
 *
 * Local: reads from filesystem with byte offset tracking (2s interval).
 * Remote: reads via SSH with byte offset (5s interval, single-file only).
 *
 * Emits parsed JSONL events tagged with agentName for the frontend.
 */

import fs from 'node:fs';
import { log } from '../logging/index.js';
import { findAllSubagentJsonlsForAgent } from '../core/team-reader.js';

const LOCAL_POLL_MS = 2000;
const REMOTE_POLL_MS = 5000;
/** Re-discover new files every N poll cycles (local only) */
const DISCOVERY_INTERVAL = 5; // every 10s at 2s poll

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

/** Discovery context for finding new files when inbox messages arrive */
export interface PollerDiscoveryCtx {
  sessionId: string;
  cwd: string;
  agentName: string;
  mainJsonlPath: string | null;
}

/**
 * Active-tab poller — polls an agent's JSONL files on a timer.
 * Multi-file aware: tracks all files for one agent and discovers new ones.
 * Only one instance should exist per session (managed by the session provider).
 */
export class ActiveTabPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentAgent: string | null = null;
  /** Tracked files: filePath → byte offset */
  private trackedFiles = new Map<string, number>();
  private isRemote = false;
  private _polling = false;
  private _pollCount = 0;
  private onEvent: OnSubagentEvent;
  private sshExec?: (cmd: string) => Promise<string | null>;
  /** Context for periodic file discovery (local only) */
  private discoveryCtx: PollerDiscoveryCtx | null = null;
  /** Legacy single-path for remote polling */
  private remotePath: string | null = null;
  private remoteOffset = 0;

  constructor(onEvent: OnSubagentEvent, sshExec?: (cmd: string) => Promise<string | null>) {
    this.onEvent = onEvent;
    this.sshExec = sshExec;
  }

  /**
   * Start polling a specific agent's JSONL files (multi-file).
   * Stops any previous polling first.
   *
   * The RPC has already sent the initial snapshot to the frontend,
   * so we just stat each file to set offsets at current EOF.
   *
   * @param agentName - The agent tab name
   * @param opts.filePaths - All known JSONL paths (pre-discovered by the RPC)
   * @param opts.remote - Whether this is a remote session
   * @param opts.discovery - Context for periodic new-file discovery (local only)
   */
  subscribe(agentName: string, opts: {
    filePaths: string[];
    remote: boolean;
    discovery?: PollerDiscoveryCtx;
  }): void {
    this.stop();

    this.currentAgent = agentName;
    this.isRemote = opts.remote;
    this.trackedFiles.clear();
    this._pollCount = 0;

    if (!opts.remote) {
      // Track all known files — set offset to current EOF
      for (const p of opts.filePaths) {
        try {
          const size = fs.statSync(p).size;
          this.trackedFiles.set(p, size);
        } catch { /* file may have been removed */ }
      }

      // Store discovery context for finding new files
      if (opts.discovery) {
        this.discoveryCtx = opts.discovery;
      }
    } else {
      // Remote: single-file mode (file discovery requires local fs)
      this.remotePath = opts.filePaths[0] ?? null;
      this.remoteOffset = 0;
      if (!this.remotePath) {
        log.session.warn('subagent poller: no file path for remote agent', { agentName });
        return;
      }
    }

    // Start polling timer
    const intervalMs = opts.remote ? REMOTE_POLL_MS : LOCAL_POLL_MS;
    this.timer = setInterval(() => this.poll(), intervalMs);

    log.session.info('subagent poller subscribed', {
      agentName,
      fileCount: opts.filePaths.length,
      remote: opts.remote,
      hasDiscovery: !!opts.discovery,
    });
  }

  /**
   * Async subscribe for remote agents — reads full file via SSH then starts polling.
   */
  async subscribeRemote(agentName: string, filePath: string): Promise<ParsedJsonlEvent[]> {
    this.stop();

    this.currentAgent = agentName;
    this.isRemote = true;
    this.remotePath = filePath;
    this.remoteOffset = 0;
    this.trackedFiles.clear();

    // Read initial snapshot via SSH
    let initialEvents: ParsedJsonlEvent[] = [];
    if (this.sshExec) {
      try {
        const result = await this.sshExec(`cat '${filePath}' 2>/dev/null`);
        if (result) {
          const lines = result.split('\n').filter(Boolean);
          this.remoteOffset = Buffer.byteLength(result);
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
    this.trackedFiles.clear();
    this.discoveryCtx = null;
    this.remotePath = null;
    this.remoteOffset = 0;
    this._pollCount = 0;
    this._polling = false;
  }

  /** Current subscribed agent name. */
  get activeAgent(): string | null {
    return this.currentAgent;
  }

  private async poll(): Promise<void> {
    if (!this.currentAgent) return;
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
    if (!this.currentAgent) return;

    // Poll all tracked files for new bytes
    for (const [filePath, currentOffset] of this.trackedFiles) {
      const { newLines, newOffset } = pollLocalFile(filePath, currentOffset);
      if (newLines.length > 0) {
        this.trackedFiles.set(filePath, newOffset);
        const events = parseJsonlLines(newLines);
        if (events.length > 0) {
          this.onEvent(this.currentAgent, events);
        }
      }
    }

    // Periodically discover new files (inbox response creates new JSONL files)
    this._pollCount++;
    if (this._pollCount % DISCOVERY_INTERVAL === 0 && this.discoveryCtx) {
      this.discoverNewFiles();
    }
  }

  /** Check for new JSONL files not yet tracked (inbox responses, shutdown acks) */
  private discoverNewFiles(): void {
    if (!this.discoveryCtx || !this.currentAgent) return;
    const { sessionId, cwd, agentName, mainJsonlPath } = this.discoveryCtx;

    const allPaths = findAllSubagentJsonlsForAgent(sessionId, cwd, agentName, mainJsonlPath);
    for (const p of allPaths) {
      if (this.trackedFiles.has(p)) continue;

      // New file discovered — read it fully and start tracking
      const { lines, offset } = readFullFile(p);
      this.trackedFiles.set(p, offset);
      const events = parseJsonlLines(lines);
      if (events.length > 0) {
        this.onEvent(this.currentAgent!, events);
      }

      log.session.info('subagent poller: discovered new file', {
        agentName, path: p.slice(-60), events: events.length,
      });
    }
  }

  private async pollRemote(): Promise<void> {
    if (!this.remotePath || !this.currentAgent || !this.sshExec) return;

    const cmd = buildRemotePollCmd(this.remotePath, this.remoteOffset);
    const result = await this.sshExec(cmd);
    if (!result) return;

    const { newLines, newOffset } = parseRemotePollResult(result, this.remoteOffset);
    if (newLines.length === 0) return;

    this.remoteOffset = newOffset;
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
