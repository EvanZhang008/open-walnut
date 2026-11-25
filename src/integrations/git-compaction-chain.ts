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

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitChildEnv } from '../lib/git-env.js';

export interface ChainCommit {
  hash: string;
  /** ISO-8601 with offset (`%aI`). */
  date: string;
  message: string;
}

const BIG = 512 * 1024 * 1024;

function gitOut(repoDir: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: repoDir, input, encoding: 'utf-8', maxBuffer: BIG, timeout: 600_000,
    stdio: ['pipe', 'pipe', 'pipe'], env: gitChildEnv(),
  });
}

/** `Name <email>` of an ident as git var prints it (`Name <email> 1700000000 +0000`). */
function identName(repoDir: string, which: 'GIT_AUTHOR_IDENT' | 'GIT_COMMITTER_IDENT'): string {
  const ident = gitOut(repoDir, ['var', which]).trim();
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
export function buildCompactedChain(repoDir: string, kept: ChainCommit[]): string {
  if (kept.length === 0) throw new Error('nothing to keep');
  const treeLines = gitOut(repoDir, ['cat-file', '--batch-check'], kept.map((c) => `${c.hash}^{tree}`).join('\n') + '\n')
    .split('\n').filter(Boolean);
  if (treeLines.length !== kept.length) throw new Error(`read ${treeLines.length} trees for ${kept.length} commits`);
  const trees = treeLines.map((line, i) => {
    const [sha, type] = line.split(' ');
    if (type !== 'tree') throw new Error(`no tree for ${kept[i].hash}: ${line}`);
    return sha;
  });
  const author = identName(repoDir, 'GIT_AUTHOR_IDENT');
  const committer = identName(repoDir, 'GIT_COMMITTER_IDENT');

  // The repo's own hash (a SHA-256 repo has 64-hex trees).
  const algo = trees[0].length === 64 ? 'sha256' : 'sha1';
  // Inside .git and cleared first: a run a deploy kills skips the finally,
  // and the next run removes what it left.
  const gitDir = gitOut(repoDir, ['rev-parse', '--absolute-git-dir']).trim();
  const tmp = path.join(gitDir, 'walnut-compact-chain');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const files: string[] = [];
    const expected: string[] = [];
    let parent = '';
    kept.forEach((c, i) => {
      const body = commitObject({ tree: trees[i], parent, author, committer, date: c.date, message: c.message });
      const file = path.join(tmp, `${i}`);
      fs.writeFileSync(file, body, 'utf-8');
      files.push(file);
      parent = objectHash(body, algo);
      expected.push(parent);
    });
    const written = gitOut(repoDir, ['hash-object', '-t', 'commit', '-w', '--stdin-paths'], files.join('\n') + '\n')
      .split('\n').filter(Boolean);
    if (written.length !== expected.length || written.some((h, i) => h !== expected[i])) {
      throw new Error('written commit objects differ from the computed chain');
    }
    return parent;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
