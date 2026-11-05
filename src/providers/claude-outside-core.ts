/**
 * Which Claude Code transcripts Walnut did not start. Every transcript's first lines say how the
 * session was started (`entrypoint`: `sdk-cli` for a `claude -p` run such as every Walnut session,
 * `cli` for the terminal, `walnut-utility` for Walnut's own one-shot helper calls) and where
 * (`cwd`). The usage scan reads the sessions this lists besides Walnut's own, so a terminal
 * session, an agent's `claude -p` or an SDK script is counted too.
 *
 * Read host-side and read-only. What a transcript says about itself never changes, so each file
 * is read once and remembered in a small cache beside the usage scan index.
 */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';

/** Marker for the source twin: this sidecar can list outside Claude sessions (claude-outside-v1). */
export const CLAUDE_OUTSIDE = true;

/** Entrypoints of Walnut's own helper calls: counted from Walnut's call records, never as outside work. */
export const WALNUT_ENTRYPOINTS: ReadonlySet<string> = new Set(['walnut-utility']);

/** The entrypoint a Walnut session (`claude -p --input-format stream-json`) writes. */
export const WALNUT_SESSION_ENTRYPOINT = 'sdk-cli';

export interface ClaudeSessionMeta { sessionId: string; entrypoint: string; cwd: string }

/** The entrypoint is within the first dozen KB of a transcript unless the first message is huge (an inline image); stop looking at this much. */
const HEAD_MAX_BYTES = 4 * 1024 * 1024;
/** What is kept from one chunk to the next, so a field cut by a chunk boundary is still found. */
const OVERLAP_CHARS = 8 * 1024;
const CACHE_FILE = 'claude-session-meta.json';
const YIELD_EVERY = 40;
const ENTRYPOINT = /"entrypoint"\s*:\s*("(?:[^"\\]|\\.)*")/;
const CWD = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/;

function quoted(re: RegExp, text: string): string {
  const m = re.exec(text);
  if (!m) return '';
  try { const v = JSON.parse(m[1]); return typeof v === 'string' ? v : ''; } catch { return ''; }
}

/**
 * Looks for the two fields as text, not line by line: the line that holds them can be megabytes long. `complete` is false when
 * the file ended before an entrypoint showed (a session that has just begun), so it is read again; `capped` means the limit was
 * reached with none, which is remembered with the file's size and looked at again only if the file grows.
 */
async function readHead(file: string): Promise<{ entrypoint: string; cwd: string; complete: boolean; size: number } | undefined> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let tail = '';
    let total = 0;
    let cwd = '';
    let entrypoint = '';
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) return entrypoint ? { entrypoint, cwd, complete: true, size: total } : cwd ? { entrypoint: '', cwd, complete: false, size: total } : undefined;
      total += bytesRead;
      const text = tail + buffer.toString('utf8', 0, bytesRead);
      if (!entrypoint) entrypoint = quoted(ENTRYPOINT, text);
      if (!cwd) cwd = quoted(CWD, text);
      if (entrypoint && cwd) return { entrypoint, cwd, complete: true, size: total };
      tail = text.slice(-OVERLAP_CHARS);
      if (total >= HEAD_MAX_BYTES) return { entrypoint, cwd, complete: !!entrypoint, size: total };
    }
  } finally { await handle.close().catch(() => {}); }
}

/** [entrypoint, cwd] and, for a file read up to the limit with no entrypoint found, the size it had then. */
type Cache = Record<string, [string, string] | [string, string, number]>;

async function loadCache(file: string | undefined): Promise<Cache> {
  if (!file) return {};
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as Cache; } catch { return {}; }
}

async function saveCache(file: string, cache: Cache): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(cache));
    await fs.rename(tmp, file);
  } catch { /* the cache is an optimisation only */ }
}

/**
 * Every top-level transcript under `<projects dir>/<project>/<session id>.jsonl`: how it was started and where.
 * A subagent transcript belongs to its parent session and is not listed. A file with no entrypoint line yet
 * (a session that has just begun) is listed with an empty entrypoint and read again next time.
 */
export async function claudeSessionMetas(projectsDir: string, indexDir?: string): Promise<Map<string, ClaudeSessionMeta> & { unreadable: number }> {
  const cacheFile = indexDir ? path.join(indexDir, CACHE_FILE) : undefined;
  const cache = await loadCache(cacheFile);
  const next: Cache = {};
  const out = Object.assign(new Map<string, ClaudeSessionMeta>(), { unreadable: 0 });
  let dirty = false;
  let seen = 0;
  let projects: string[] = [];
  try { projects = await fs.readdir(projectsDir); } catch { return out; }
  for (const project of projects) {
    let names: string[];
    try { names = await fs.readdir(path.join(projectsDir, project)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      const key = `${project}/${name}`;
      const file = path.join(projectsDir, project, name);
      let hit: Cache[string] | undefined = cache[key];
      // A file once read to the limit with no entrypoint is looked at again only when it has grown.
      if (hit && hit.length === 3) {
        const size = await fs.stat(file).then(st => st.size, () => hit![2] as number);
        if (size > (hit[2] as number)) hit = undefined;
      }
      if (!hit) {
        try {
          const head = await readHead(file);
          if (head && (head.complete || head.size >= HEAD_MAX_BYTES)) { hit = head.entrypoint ? [head.entrypoint, head.cwd] : ['', head.cwd, head.size]; dirty = true; }
        } catch { out.unreadable++; /* unreadable now: listed without an entrypoint, read again next time, and the pass says so */ }
      }
      if (hit) next[key] = hit;
      out.set(sessionId, { sessionId, entrypoint: hit?.[0] ?? '', cwd: hit?.[1] ?? '' });
      if (++seen % YIELD_EVERY === 0) await setImmediate();
    }
  }
  if (cacheFile && (dirty || Object.keys(cache).length !== Object.keys(next).length)) await saveCache(cacheFile, next);
  return out;
}

/**
 * The sessions whose usage is counted besides Walnut's own: every one but Walnut's helper calls. A session
 * that has not named its entrypoint yet waits for the next pass, so a helper call is never taken for outside work.
 */
export function outsideSessionIds(metas: Map<string, ClaudeSessionMeta>): string[] {
  return [...metas.values()].filter(m => m.entrypoint && !WALNUT_ENTRYPOINTS.has(m.entrypoint)).map(m => m.sessionId);
}
