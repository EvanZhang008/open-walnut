#!/usr/bin/env bun
/**
 * One-time cleanup for ~/.open-walnut/chat-history.json (and per-agent variants).
 *
 * Walnut's new compact() logic deletes pre-boundary entries automatically, but
 * historical files accumulated `compacted=true` AI entries + old UI notifications
 * that nobody reads. This script replicates the same rule once:
 *
 *   - keep all entries AT or AFTER the turn-boundary of the last 10 active turns
 *   - delete everything before that boundary (compacted AI + older UI notifications)
 *   - compactionSummary / compactionCount / version preserved
 *
 * Refuses to run while walnut is listening on port 3456 (stop it first).
 *
 * Usage: bun scripts/prune-chat-history.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';

const WALNUT_HOME = path.join(os.homedir(), '.open-walnut');
const RECENT_TURNS_TO_KEEP = 10;
const WALNUT_PORT = 3456;

function isTurnStart(entry) {
  if (entry.role !== 'user') return false;
  if (typeof entry.content === 'string') return true;
  if (!Array.isArray(entry.content)) return true;
  return !entry.content.some((b) => b && b.type === 'tool_result');
}

function findTurnBoundaryIndex(aiEntries, turnsToKeep) {
  let turnsSeen = 0;
  for (let i = aiEntries.length - 1; i >= 0; i--) {
    if (isTurnStart(aiEntries[i])) {
      turnsSeen++;
      if (turnsSeen === turnsToKeep) return i;
    }
  }
  return null;
}

function atomicWrite(filePath, data) {
  const tmp = path.join(
    os.tmpdir(),
    `walnut-prune-${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

// Free means nothing answers on the port, over IPv4 or IPv6. A test bind on
// 127.0.0.1 is not proof: the server listens on the IPv6 wildcard (*:3456), and a
// bind to 127.0.0.1:3456 still succeeds beside it, so walnut looked stopped while
// it ran.
function answers(port, host) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (up) => { sock.destroy(); resolve(up); };
    sock.setTimeout(2000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
async function checkPortFree(port) {
  const [v4, v6] = await Promise.all([answers(port, '127.0.0.1'), answers(port, '::1')]);
  return !v4 && !v6;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function pruneFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log(`[skip] ${filePath} does not exist`);
    return;
  }
  const beforeSize = fs.statSync(filePath).size;
  const raw = fs.readFileSync(filePath, 'utf-8');
  let store;
  try {
    store = JSON.parse(raw);
  } catch (err) {
    console.error(`[error] cannot parse ${filePath}: ${err.message}`);
    process.exit(1);
  }
  const entries = Array.isArray(store.entries) ? store.entries : [];
  if (entries.length === 0) {
    console.log(`[skip] ${path.basename(filePath)} has no entries`);
    return;
  }

  const aiEntries = entries.filter((e) => e.tag === 'ai' && !e.compacted);
  const boundary = findTurnBoundaryIndex(aiEntries, RECENT_TURNS_TO_KEEP);

  let cutoff = 0;
  if (boundary === null) {
    // Fewer than RECENT_TURNS_TO_KEEP active turns — still drop anything before
    // the first non-compacted AI entry (i.e. drop compacted + older-than-recent UI).
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.tag === 'ai' && !e.compacted) {
        cutoff = i;
        break;
      }
      cutoff = i + 1;
    }
  } else {
    let aiSeen = 0;
    cutoff = entries.length;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.tag === 'ai' && !e.compacted) {
        if (aiSeen === boundary) {
          cutoff = i;
          break;
        }
        aiSeen++;
      }
    }
  }

  if (cutoff === 0) {
    console.log(`[skip] ${path.basename(filePath)}: nothing to prune`);
    return;
  }

  const backupPath = `${filePath}.backup-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19)}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`[backup] ${path.basename(filePath)} → ${path.basename(backupPath)}`);

  store.entries = entries.slice(cutoff);
  atomicWrite(filePath, store);
  const afterSize = fs.statSync(filePath).size;

  console.log(
    `[pruned] ${path.basename(filePath)}: ${entries.length} → ${store.entries.length} entries, ${bytes(beforeSize)} → ${bytes(afterSize)} (saved ${bytes(beforeSize - afterSize)})`,
  );
}

async function main() {
  const free = await checkPortFree(WALNUT_PORT);
  if (!free) {
    console.error(
      `[abort] port ${WALNUT_PORT} is in use — stop walnut first (the watchdog will restart it after).`,
    );
    process.exit(1);
  }

  const files = fs
    .readdirSync(WALNUT_HOME)
    .filter((n) => /^chat-history(-[a-z0-9-]+)?\.json$/.test(n))
    .map((n) => path.join(WALNUT_HOME, n));

  if (files.length === 0) {
    console.log('[done] no chat-history files found');
    return;
  }

  for (const f of files) pruneFile(f);
  console.log('[done]');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
