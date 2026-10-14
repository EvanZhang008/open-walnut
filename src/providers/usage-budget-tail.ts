import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { canonicalRecordFromAssistant, normalizeUsageModel, type CanonicalUsageRecord } from './usage-scan-core.js';

type JsonObject = Record<string, unknown>;
interface TailFile { path: string; sessionId: string; agentId?: string }
interface Checkpoint { offset: number; dev: number; ino: number; complete: boolean }

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function syntheticZero(message: JsonObject): boolean {
  if (!['synthetic', '<synthetic>'].includes(normalizeUsageModel(message.model))) return false;
  const usage = message.usage;
  return !object(usage) || ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .every(key => !usage[key]);
}

/** Host-local incremental final responses. The budget runtime owns historical identity deduplication. */
export function createBudgetTail(options: { projectsDir: string }) {
  const projects = new Map<string, string>();
  const checkpoints = new Map<string, Checkpoint>();

  async function projectFor(sessionId: string): Promise<string | undefined> {
    const cached = projects.get(sessionId);
    if (cached) {
      try { await lstat(path.join(cached, `${sessionId}.jsonl`)); return cached; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        projects.delete(sessionId);
      }
    }
    const entries = await readdir(options.projectsDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const project = path.join(options.projectsDir, entry.name);
      try {
        await lstat(path.join(project, `${sessionId}.jsonl`));
        projects.set(sessionId, project);
        return project;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  async function scan(sessionId: string): Promise<{ records: CanonicalUsageRecord[]; complete: boolean }> {
    if (!sessionId || path.basename(sessionId) !== sessionId || sessionId === '..' || sessionId === '.') {
      throw new Error('Budget session ID must be a filename component');
    }
    const records: CanonicalUsageRecord[] = [];
    let complete = true;
    let cpuStart = process.cpuUsage();
    async function yieldIfNeeded() {
      const elapsed = process.cpuUsage(cpuStart);
      if (elapsed.user + elapsed.system < 5_000) return;
      await setImmediate();
      cpuStart = process.cpuUsage();
    }
    let files: TailFile[];
    try {
      const project = await projectFor(sessionId);
      if (!project) return { records, complete: false };
      files = [{ path: path.join(project, `${sessionId}.jsonl`), sessionId }];
      const agentsDir = path.join(project, sessionId, 'subagents');
      try {
        if (!(await lstat(agentsDir)).isDirectory()) throw new Error('Budget subagent path must be a directory');
        const entries = await readdir(agentsDir, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.name.endsWith('.jsonl')) continue;
          files.push({ path: path.join(agentsDir, entry.name), sessionId, agentId: entry.name.slice(0, -6) });
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } catch { return { records, complete: false }; }

    for (const file of files) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(file.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile()) { complete = false; continue; }
        let checkpoint = checkpoints.get(file.path);
        if (!checkpoint || checkpoint.dev !== stat.dev || checkpoint.ino !== stat.ino || checkpoint.offset > stat.size) {
          checkpoint = { offset: 0, dev: stat.dev, ino: stat.ino, complete: true };
          checkpoints.set(file.path, checkpoint);
        }
        complete &&= checkpoint.complete;
        let position = checkpoint.offset;
        let fragments: Buffer[] = [];
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (position < stat.size) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
          if (!bytesRead) { complete = false; break; }
          const chunk = Buffer.from(buffer.subarray(0, bytesRead));
          let cursor = 0;
          while (cursor < chunk.length) {
            const newline = chunk.indexOf(10, cursor);
            if (newline < 0) { fragments.push(chunk.subarray(cursor)); break; }
            fragments.push(chunk.subarray(cursor, newline + 1));
            const line = Buffer.concat(fragments).toString('utf8').replace(/\r?\n$/, '');
            checkpoint.offset = position + newline + 1;
            fragments = [];
            cursor = newline + 1;
            const elapsed = process.cpuUsage(cpuStart);
            if (elapsed.user + elapsed.system >= 5_000) await yieldIfNeeded();
            if (!line.trim()) continue;
            let row: unknown;
            try { row = JSON.parse(line.replace(/^\0+/, '')); }
            catch { checkpoint.complete = false; complete = false; continue; }
            if (!object(row)) { checkpoint.complete = false; complete = false; continue; }
            if (row.type !== 'assistant') continue;
            if (!object(row.message)) { checkpoint.complete = false; complete = false; continue; }
            if (syntheticZero(row.message)) continue;
            if (typeof row.message.stop_reason !== 'string' || !row.message.stop_reason) continue;
            // Copied history is owned by the baseline scanner, not a coverage gap in this tail.
            if (object(row.forkedFrom) && typeof row.forkedFrom.sessionId === 'string' && row.forkedFrom.sessionId) continue;
            const source = typeof row.sessionId === 'string' && row.sessionId ? row.sessionId
              : row.sessionId === undefined && typeof row.session_id === 'string' && row.session_id ? row.session_id : sessionId;
            if (source !== sessionId) continue;
            const record = canonicalRecordFromAssistant(row, { sessionId, ...(file.agentId ? { agentId: file.agentId } : {}) });
            if (record) records.push(record);
            if (!record?.complete) { checkpoint.complete = false; complete = false; }
          }
          position += bytesRead;
          await yieldIfNeeded();
        }
        if (fragments.length) complete = false;
      } catch { complete = false; }
      finally { await handle?.close().catch(() => {}); }
    }
    return { records, complete };
  }

  return { scan };
}
