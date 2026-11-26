/**
 * Build the compacted chain (step 4 of compactGitHistory) in three git calls.
 *
 * Each kept commit becomes a new commit object on its ORIGINAL tree, parented
 * on the previous new one. `git commit-tree` per commit did that with one
 * child process each: about 17k kept commits on the real data repo took 30+
 * minutes, longer than the gap between two deploys of the server that forks
 * this worker, so a restart cut most runs short and compaction never finished
 * (2026-11-25). The commit objects are small and fully determined by their
 * fields, so we write them ourselves: read every tree in one `cat-file
 * --batch-check`, compute each object's hash here to chain the parents, and
 * store them all with one `hash-object -t commit -w --stdin-paths`, which also
 * checks each object's format. Its answers must match the hashes we computed.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gitChildEnv } from '../lib/git-env.js';

export interface ChainCommit {
  hash: string;
  /** ISO-8601 with offset (`%aI`). */
  date: string;
  message: string;
}

const BIG = 512 * 1024 * 1024;

/** Async, never execSync: the event-loop ratchet holds for the worker too. */
function gitOut(repoDir: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'], env: gitChildEnv(undefined, process.env, repoDir) });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`git ${args[0]} timed out`)); }, 600_000);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > BIG) { child.kill('SIGKILL'); return; }
      out.push(c);
    });
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString('utf-8')).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && size <= BIG) resolve(Buffer.concat(out).toString('utf-8'));
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${err.trim()}`));
    });
    child.stdin.on('error', () => { /* git exited early: its exit code tells */ });
    child.stdin.end(input ?? '');
  });
}

/** `Name <email>` of an ident as git var prints it (`Name <email> 1700000000 +0000`). */
async function identName(repoDir: string, which: 'GIT_AUTHOR_IDENT' | 'GIT_COMMITTER_IDENT'): Promise<string> {
  const ident = (await gitOut(repoDir, ['var', which])).trim();
  const end = ident.lastIndexOf('>');
  if (end < 0) throw new Error(`unreadable ${which}: ${ident}`);
  return ident.slice(0, end + 1);
}

/** git's raw date: `<epoch seconds> <+hhmm>`, from an ISO-8601 date with offset. */
export function rawGitDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`unreadable commit date: ${iso}`);
  const m = /([+-])(\d\d):?(\d\d)$/.exec(iso);
  const tz = m ? `${m[1]}${m[2]}${m[3]}` : '+0000';
  return `${Math.floor(ms / 1000)} ${tz}`;
}

export function commitObject(fields: { tree: string; parent: string; author: string; committer: string; date: string; message: string }): string {
  const when = rawGitDate(fields.date);
  return `tree ${fields.tree}\n`
    + (fields.parent ? `parent ${fields.parent}\n` : '')
    + `author ${fields.author} ${when}\n`
    + `committer ${fields.committer} ${when}\n`
    // As commit-tree -m: a newline ends a message, and an empty one stays empty.
    + `\n${fields.message ? `${fields.message}\n` : ''}`;
}

function objectHash(body: string, algo: 'sha1' | 'sha256'): string {
  const content = Buffer.from(body, 'utf-8');
  return crypto.createHash(algo).update(`commit ${content.length}\0`).update(content).digest('hex');
}

/** Write the chain and return its head. Nothing points at it yet. */
export async function buildCompactedChain(repoDir: string, kept: ChainCommit[]): Promise<string> {
  if (kept.length === 0) throw new Error('nothing to keep');
  const treeLines = (await gitOut(repoDir, ['cat-file', '--batch-check'], kept.map((c) => `${c.hash}^{tree}`).join('\n') + '\n'))
    .split('\n').filter(Boolean);
  if (treeLines.length !== kept.length) throw new Error(`read ${treeLines.length} trees for ${kept.length} commits`);
  const trees = treeLines.map((line, i) => {
    const [sha, type] = line.split(' ');
    if (type !== 'tree') throw new Error(`no tree for ${kept[i].hash}: ${line}`);
    return sha;
  });
  const author = await identName(repoDir, 'GIT_AUTHOR_IDENT');
  const committer = await identName(repoDir, 'GIT_COMMITTER_IDENT');

  // The repo's own hash (a SHA-256 repo has 64-hex trees).
  const algo = trees[0].length === 64 ? 'sha256' : 'sha1';
  // Inside .git and cleared first: a run a deploy kills skips the finally,
  // and the next run removes what it left.
  const gitDir = (await gitOut(repoDir, ['rev-parse', '--absolute-git-dir'])).trim();
  const tmp = path.join(gitDir, 'walnut-compact-chain');
  await fsp.rm(tmp, { recursive: true, force: true });
  await fsp.mkdir(tmp, { recursive: true });
  try {
    const files: string[] = [];
    const expected: string[] = [];
    let parent = '';
    for (let i = 0; i < kept.length; i++) {
      const c = kept[i];
      const body = commitObject({ tree: trees[i], parent, author, committer, date: c.date, message: c.message });
      const file = path.join(tmp, `${i}`);
      await fsp.writeFile(file, body, 'utf-8');
      files.push(file);
      parent = objectHash(body, algo);
      expected.push(parent);
    }
    const written = (await gitOut(repoDir, ['hash-object', '-t', 'commit', '-w', '--stdin-paths'], files.join('\n') + '\n'))
      .split('\n').filter(Boolean);
    if (written.length !== expected.length || written.some((h, i) => h !== expected[i])) {
      throw new Error('written commit objects differ from the computed chain');
    }
    return parent;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}
