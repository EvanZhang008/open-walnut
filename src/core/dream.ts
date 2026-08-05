/**
 * Dream Consolidation — periodic background knowledge organization.
 *
 * Gating: >=24h since last dream + >=5 sessions since last dream.
 * Execution: forked agent turn with the default tool set.
 * 4 phases: Orient -> Gather -> Consolidate -> Prune.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  MEMORY_DIR,
  TOPICS_DIR,
  COMPACTION_DIR,
  MEMORY_INDEX_FILE,
  DAILY_DIR,
  WORKING_MEMORY_FILE,
} from '../constants.js';
import { listSessions } from './session-tracker.js';
import { log } from '../logging/index.js';

// ── Lock management ──

const DREAM_LOCK_FILE = path.join(MEMORY_DIR, '.dream-lock');
// 60 min: generous upper bound for dream consolidation (typically completes in <10 min).
// Safety net for hung LLM calls or infinite tool loops.
const STALE_LOCK_MS = 60 * 60 * 1000;
const MIN_HOURS_BETWEEN_DREAMS = 24;
const MIN_SESSIONS_FOR_DREAM = 5;

/** Persisted alongside the lock file to record last successful dream time. */
const DREAM_STATE_FILE = path.join(MEMORY_DIR, '.dream-state.json');

interface DreamLock {
  pid: number;
  startedAt: string;
}

interface DreamState {
  lastDreamAt: string;
}

function acquireDreamLock(): boolean {
  try {
    fs.mkdirSync(path.dirname(DREAM_LOCK_FILE), { recursive: true });
    // Atomic exclusive create — avoids TOCTOU race between existsSync + writeFileSync
    fs.writeFileSync(DREAM_LOCK_FILE, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    } satisfies DreamLock), { encoding: 'utf-8', flag: 'wx' });
    return true;
  } catch (err: unknown) {
    // EEXIST means the lock file already exists — check if it's stale
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EEXIST') {
      try {
        const stat = fs.statSync(DREAM_LOCK_FILE);
        const age = Date.now() - stat.mtimeMs;
        if (age < STALE_LOCK_MS) {
          // Check if PID is still alive
          try {
            const lock: DreamLock = JSON.parse(fs.readFileSync(DREAM_LOCK_FILE, 'utf-8'));
            // signal 0 = check process existence without sending a signal (POSIX idiom).
            // Throws ESRCH if PID doesn't exist → lock is stale.
            process.kill(lock.pid, 0);
            return false; // lock is valid and process is alive
          } catch {
            // PID dead or unreadable — stale lock, fall through to reclaim
          }
        }
        // Stale lock — remove and retry
        fs.unlinkSync(DREAM_LOCK_FILE);
        fs.writeFileSync(DREAM_LOCK_FILE, JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        } satisfies DreamLock), { encoding: 'utf-8', flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function releaseDreamLock(): void {
  try { fs.unlinkSync(DREAM_LOCK_FILE); } catch { /* best-effort */ }
}

function getLastDreamTime(): number {
  try {
    if (fs.existsSync(DREAM_STATE_FILE)) {
      const state: DreamState = JSON.parse(fs.readFileSync(DREAM_STATE_FILE, 'utf-8'));
      return new Date(state.lastDreamAt).getTime();
    }
  } catch { /* best-effort */ }
  return 0;
}

function recordDreamTime(): void {
  try {
    fs.mkdirSync(path.dirname(DREAM_STATE_FILE), { recursive: true });
    fs.writeFileSync(DREAM_STATE_FILE, JSON.stringify({
      lastDreamAt: new Date().toISOString(),
    } satisfies DreamState), 'utf-8');
  } catch { /* best-effort */ }
}

// ── Gating ──

async function getRecentSessionCount(): Promise<number> {
  try {
    const sessions = await listSessions();
    const lastDream = getLastDreamTime();
    return sessions.filter((s) => {
      const startTime = new Date(s.startedAt ?? 0).getTime();
      return startTime > lastDream;
    }).length;
  } catch {
    return 0;
  }
}

export async function shouldDream(): Promise<boolean> {
  const lastDream = getLastDreamTime();
  const hoursSince = (Date.now() - lastDream) / (1000 * 60 * 60);
  if (hoursSince < MIN_HOURS_BETWEEN_DREAMS) return false;

  const sessionCount = await getRecentSessionCount();
  if (sessionCount < MIN_SESSIONS_FOR_DREAM) return false;

  return true;
}

// ── Dream prompt ──

function buildDreamPrompt(): string {
  const lastDream = getLastDreamTime();
  const lastDreamDate = lastDream > 0
    ? new Date(lastDream).toISOString().slice(0, 10)
    : '(no previous dream)';

  return `You are performing a DREAM consolidation — organizing scattered knowledge into a clean wiki.

## Your task

Consolidate recent daily logs, working memory, and compaction archives into topic files.
Then update the memory index.

## Phase 1 — Orient

1. Read ${MEMORY_INDEX_FILE} (the wiki index) if it exists
2. List files in ${TOPICS_DIR} and read their headers (first 10 lines each)
3. Understand what topics already exist

## Phase 2 — Gather

1. List and read daily logs from ${DAILY_DIR} since ${lastDreamDate}
2. Read ${WORKING_MEMORY_FILE} if it exists
3. List and read files from ${COMPACTION_DIR} since ${lastDreamDate}
4. Identify new knowledge, decisions, patterns, and user preferences

## Phase 3 — Consolidate

For each piece of new knowledge:
1. If it fits an existing topic file -> EDIT that file (use file_edit to update the relevant section)
2. If it's a genuinely new topic -> CREATE a new topic file in ${TOPICS_DIR}
3. PREFER merging into existing files over creating new ones
4. Convert relative dates to absolute dates (e.g., "yesterday" -> "${formatYesterday()}")
5. Delete contradicted or outdated facts
6. Each topic file should follow this format:

\`\`\`markdown
---
title: Topic Name
updated: YYYY-MM-DD
tags: [tag1, tag2]
---

## Overview
Brief description.

## Key Facts
- Bullet points of essential knowledge
- Include dates for time-sensitive facts

## Decisions
- YYYY-MM-DD: Decision description and reasoning

## See Also
- [related-topic](related-topic.md) — one-line description
\`\`\`

## Phase 4 — Prune

1. Update ${MEMORY_INDEX_FILE} with the current state of all topic files
2. Index format: \`- [title](topics/filename.md) — one-line description\`
3. Keep index under 200 lines
4. Remove entries for files that no longer exist
5. Group by: Topics, Active Projects, Recent Daily Logs
6. If you encounter contradictory facts that cannot be resolved from the sources, add a "\u26a0 Needs confirmation" note in the relevant topic file under a "## Unresolved" section.

## Rules

- DO NOT create topic files for ephemeral information (today's weather, temporary debugging)
- DO NOT duplicate information that's already well-captured in a topic file
- Focus on KNOWLEDGE that will be useful weeks from now
- Be concise — each topic file should be scannable in 30 seconds`;
}

function formatYesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function buildDreamSystemPrompt(): string {
  return `You are a knowledge consolidation agent. Your job is to organize scattered memory files into a clean wiki structure.

You have access to file operations (read, write, edit, list, glob, grep).

## Rules
- ONLY operate on files under ${MEMORY_DIR}
- Focus on consolidating knowledge, not creating tasks or sessions
- Be concise and factual
- Convert relative dates to absolute dates
- Prefer editing existing topic files over creating new ones`;
}

// ── Execute dream ──

export async function executeDream(): Promise<void> {
  const canDream = await shouldDream();
  if (!canDream) {
    log.memory.debug('dream: skipping — conditions not met');
    return;
  }

  if (!acquireDreamLock()) {
    log.memory.debug('dream: skipping — lock held');
    return;
  }

  log.memory.info('dream: starting consolidation');

  try {
    const { runAgentLoop } = await import('../agent/loop.js');
    // Import restricted tool set for the dream agent (files only — no shell access)
    const { filesTools } = await import('../agent/tools/files-tools.js');
    const prompt = buildDreamPrompt();

    await runAgentLoop(prompt, [], {
      onTextDelta: () => {},
    }, {
      system: buildDreamSystemPrompt(),
      tools: filesTools,
      source: 'dream-consolidation',
      modelConfig: { maxTokens: 16000 },
      maxToolRounds: 30,
    });

    log.memory.info('dream: consolidation complete');

    // Record last dream time
    recordDreamTime();
  } catch (err) {
    log.memory.warn('dream: consolidation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    releaseDreamLock();
  }
}

// ── Initialization ──

export function ensureDreamDirectories(): void {
  fs.mkdirSync(TOPICS_DIR, { recursive: true });
  fs.mkdirSync(COMPACTION_DIR, { recursive: true });
  ensureMemoryIndex();
}

/**
 * Create the default memory index if it does not exist.
 */
export function ensureMemoryIndex(): void {
  if (!fs.existsSync(MEMORY_INDEX_FILE)) {
    fs.mkdirSync(path.dirname(MEMORY_INDEX_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_INDEX_FILE, `# Memory Index

## Topics
_(No topic files yet. Dream consolidation will populate this.)_

## Active Projects
_(Project knowledge lives in skills — resolved by project name across skill
groups; new project skills land in skills/projects/<project>/. memory/projects/
is retired legacy data — read-only, never written to.)_

## Recent Daily Logs
_(Daily logs are stored under memory/daily/.)_
`, 'utf-8');
  }
}
