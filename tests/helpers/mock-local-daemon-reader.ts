/**
 * Test double for DaemonFileReader that serves the LOCAL (__local__) host from the real
 * filesystem, honoring the test's mocked CLAUDE_HOME instead of the process $HOME.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Under the daemon-uniform model, ALL session-data reads — local included — go through
 * `DaemonFileReader(host ?? '__local__')`. In production the '__local__' reader connects to
 * the in-process local daemon over a WebSocket, and that daemon expands `~/.claude/...`
 * paths via its own `process.env.HOME`.
 *
 * Unit tests, however:
 *   1. have no running local daemon (so the real reader would try to `ssh __local__`), and
 *   2. write their fixtures under a MOCKED CLAUDE_HOME (a throwaway tmp dir), not real $HOME.
 *
 * This double bridges both: it implements the SessionFileReader surface against the real fs,
 * rewriting the tilde prefix `~/.claude` → the mocked CLAUDE_HOME so fixtures resolve. It
 * exercises the true read pipeline (createFileReader → readSessionJsonlContent → tilde paths
 * → glob/find fallbacks) without a daemon, so the tests validate the daemon-uniform code path
 * rather than bypassing it.
 *
 * Remote hosts (host !== '__local__') are NOT served here — a test that needs remote behavior
 * should mock the daemon connection explicitly.
 *
 * USAGE (must be hoisted before importing the module under test):
 *   import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';
 *   vi.mock('../../src/constants.js', () => createMockConstants());
 *   vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());
 *
 * The double reads CLAUDE_HOME lazily (per call) from the mocked constants module, so it
 * always tracks the current test's tmp dir even though createMockConstants() generates a
 * fresh path per import.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Resolve a tilde/glob path to an absolute path under the mocked CLAUDE_HOME. */
async function resolveTilde(p: string): Promise<string> {
  // CLAUDE_HOME is <tmpBase>/.claude ; '~' should map to <tmpBase> so '~/.claude' → CLAUDE_HOME.
  const { CLAUDE_HOME } = await import('../../src/constants.js');
  const home = path.dirname(CLAUDE_HOME as string);
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p; // already absolute
}

/**
 * Expand a glob the way the real `DaemonFileReader.readFile` does: only a `*` in the
 * FILE NAME is a pattern (fs.find under the literal parent dir, depth 2, name-substring
 * match on the name with its `*`s removed). A `*` in a folder segment stays a literal
 * folder name, so nothing matches. Expanding folder globs here would let a test pass
 * for a read that returns nothing in production.
 */
async function expandGlob(absPattern: string): Promise<string | null> {
  const dir = path.dirname(absPattern);
  if (dir.includes('*')) return null;
  const needle = path.basename(absPattern).replace(/\*/g, '');
  async function walk(d: string, depth: number): Promise<string | null> {
    if (depth > 2) return null;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && e.name.includes(needle)) return full;
      if (e.isDirectory()) {
        const hit = await walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }
  return walk(dir, 0);
}

/**
 * Ceiling on bytes ONE read may materialize — mirrors the real
 * DaemonFileReader.maxReadBytes(). The double MUST enforce it: without it, a test
 * that sets WALNUT_MAX_FILE_READ_BYTES to force the degradation path silently gets
 * a full read instead and passes for the wrong reason (exactly how an empty-history
 * regression for a 197 MB session reached production behind a green test).
 */
function maxReadBytes(): number {
  const raw = process.env.WALNUT_MAX_FILE_READ_BYTES;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 32 * 1024 * 1024;
}

/** Same message shape the real reader throws, so `.includes('byte ceiling')` matches. */
function ceilingError(p: string, size: number, limit: number): Error {
  return new Error(
    `file read exceeded the ${limit}-byte ceiling (path=${p}, size=${size}); ` +
    'read a bounded window instead (see readSessionHistoryTail)',
  );
}

class MockLocalDaemonFileReader {
  private host: string;
  constructor(host: string) {
    this.host = host;
  }

  /** Mirrors the real static — callers clamp bounded windows against it. */
  static maxReadBytes(): number {
    return maxReadBytes();
  }

  /** `glob`: only readFile expands a pattern (as in the real reader); every other
   *  method takes a `*` literally, so the path simply does not exist. */
  private async resolve(remotePath: string, glob = false): Promise<string | null> {
    if (this.host !== '__local__') {
      throw new Error(`MockLocalDaemonFileReader only serves __local__, got host=${this.host}`);
    }
    const abs = await resolveTilde(remotePath);
    if (glob && abs.includes('*')) return expandGlob(abs);
    return abs;
  }

  async readFile(remotePath: string): Promise<string | null> {
    const abs = await this.resolve(remotePath, true);
    if (!abs) return null;
    let size: number;
    try {
      size = (await fsp.stat(abs)).size;
    } catch {
      return null; // ENOENT → null (matches real reader's ENOENT contract)
    }
    const limit = maxReadBytes();
    if (size > limit) throw ceilingError(abs, size, limit);
    try {
      return await fsp.readFile(abs, 'utf-8');
    } catch {
      return null;
    }
  }

  async stat(remotePath: string): Promise<{ mtimeMs: number; size: number; epoch?: string } | null> {
    const abs = await this.resolve(remotePath);
    if (!abs) return null;
    try {
      const s = await fsp.stat(abs);
      // epoch mirrors the real reader: dev:ino:birthtimeMs file-incarnation id.
      return { mtimeMs: s.mtimeMs, size: s.size, epoch: `${s.dev}:${s.ino}:${Math.floor(s.birthtimeMs)}` };
    } catch {
      return null;
    }
  }

  /** Byte-range read [start, EOF) — mirrors the real reader's readFileRange contract
   *  (used by session-reconcile.ts to tail daemon stream files). */
  async readFileRange(remotePath: string, start: number): Promise<{ content: string; fileSize: number } | null> {
    const abs = await this.resolve(remotePath);
    if (!abs) return null;
    try {
      const buf = await fsp.readFile(abs);
      const slice = buf.subarray(Math.min(start, buf.length));
      // Ceiling applies to bytes THIS call materializes, not file size — a tail read
      // of a huge file passes a large `start` and legitimately stays under it.
      const limit = maxReadBytes();
      if (slice.length > limit) throw ceilingError(abs, buf.length, limit);
      return { content: slice.toString('utf-8'), fileSize: buf.length };
    } catch (err) {
      if (err instanceof Error && err.message.includes('byte ceiling')) throw err;
      return null;
    }
  }

  /** One raw byte window [start, start+length) — mirrors the real reader's
   *  readRangeBytes (ceiling-free: callers loop bounded windows). */
  async readRangeBytes(
    remotePath: string,
    start: number,
    length: number,
  ): Promise<{ buf: Buffer; fileSize: number; eof: boolean } | null> {
    const abs = await this.resolve(remotePath);
    if (!abs) return null;
    try {
      const buf = await fsp.readFile(abs);
      const slice = buf.subarray(Math.min(start, buf.length), Math.min(start + length, buf.length));
      return { buf: Buffer.from(slice), fileSize: buf.length, eof: start + slice.length >= buf.length };
    } catch {
      return null;
    }
  }

  async listDir(remotePath: string): Promise<string[]> {
    const abs = await this.resolve(remotePath);
    if (!abs) return [];
    try {
      return await fsp.readdir(abs);
    } catch {
      return [];
    }
  }

  /** listDir with per-file size/mtimeMs — mirrors the real reader's fs.ls detail:true. */
  async listDirDetailed(remotePath: string): Promise<Array<{ name: string; type: string; size?: number; mtimeMs?: number }>> {
    const abs = await this.resolve(remotePath);
    if (!abs) return [];
    let entries: string[];
    try {
      entries = await fsp.readdir(abs);
    } catch {
      return [];
    }
    const result: Array<{ name: string; type: string; size?: number; mtimeMs?: number }> = [];
    for (const name of entries) {
      try {
        const s = await fsp.stat(path.join(abs, name));
        const type = s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other';
        if (type === 'file') result.push({ name, type, size: s.size, mtimeMs: s.mtimeMs });
        else result.push({ name, type });
      } catch {
        result.push({ name, type: 'other' });
      }
    }
    return result;
  }

  async findSession(sessionId: string): Promise<{ content: string; path: string } | null> {
    const found = await this.findSessionPath(sessionId);
    if (!found) return null;
    // Routes through readFile so the ceiling applies here too — this is the hot
    // path for hashed-cwd sessions, and the real reader chunks through readFile.
    const content = await this.readFile(found);
    return content !== null ? { content, path: found } : null;
  }

  /** Path-only find (mirrors the real reader's findSessionPath). */
  async findSessionPath(sessionId: string): Promise<string | null> {
    // Recursive-ish find under ~/.claude/projects (one level of project dirs, matching maxDepth).
    const projectsAbs = await resolveTilde('~/.claude/projects');
    let dirs: string[];
    try {
      dirs = await fsp.readdir(projectsAbs);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const candidate = path.join(projectsAbs, d, `${sessionId}.jsonl`);
      try {
        await fsp.access(candidate);
        return candidate;
      } catch {
        // keep scanning
      }
    }
    return null;
  }

  async batchReadSubagents(remoteDirPath: string): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const abs = await this.resolve(remoteDirPath);
    if (!abs) return result;
    let files: string[];
    try {
      files = await fsp.readdir(abs);
    } catch {
      return result;
    }
    for (const f of files) {
      if (!f.startsWith('agent-') || !f.endsWith('.jsonl')) continue;
      try {
        result.set(f, await fsp.readFile(path.join(abs, f), 'utf-8'));
      } catch {
        // skip unreadable
      }
    }
    return result;
  }
}

/** Factory for `vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())`. */
export function mockLocalDaemonReader() {
  return { DaemonFileReader: MockLocalDaemonFileReader };
}
