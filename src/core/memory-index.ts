import Database, { type Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WALNUT_HOME, MEMORY_DIR } from '../constants.js';

const DB_PATH = path.join(WALNUT_HOME, 'memory-index.sqlite');
const MEMORY_FILE = path.join(WALNUT_HOME, 'MEMORY.md');

let db: DatabaseType | null = null;

export function getDb(): DatabaseType {
  if (db) return db;

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      hash TEXT NOT NULL,
      mtime REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      offset INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content=chunks, content_rowid=id);

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;

    -- Embedding tables for hybrid semantic search
    CREATE TABLE IF NOT EXISTS task_embeddings (
      task_id TEXT PRIMARY KEY,
      composite_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Intentionally uses chars/4 approximation instead of the real tokenizer.
// chunkMarkdown calls this in tight nested loops (per paragraph, per sentence)
// and only needs approximate counts for deciding where to split text.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitOnSentences(text: string): string[] {
  // Split on ". " followed by an uppercase letter
  const parts: string[] = [];
  let remaining = text;
  const sentencePattern = /\.\s+(?=[A-Z])/;

  let match = sentencePattern.exec(remaining);
  while (match) {
    parts.push(remaining.slice(0, match.index + 1)); // include the period
    remaining = remaining.slice(match.index + match[0].length);
    match = sentencePattern.exec(remaining);
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

export function chunkMarkdown(
  content: string,
  targetTokens: number = 400,
  overlapTokens: number = 80,
): string[] {
  if (!content.trim()) return [];

  // Split on ## headings, keeping the heading with its section
  const sections: string[] = [];
  const headingPattern = /^## /m;
  let remaining = content;
  let match = headingPattern.exec(remaining);

  if (match && match.index > 0) {
    // Content before the first ## heading
    const before = remaining.slice(0, match.index).trim();
    if (before) sections.push(before);
    remaining = remaining.slice(match.index);
    match = headingPattern.exec(remaining.slice(3)); // skip the first match
  }

  if (!match && sections.length === 0) {
    // No ## headings at all
    sections.push(remaining.trim());
  } else {
    // Split on ## headings
    const parts = remaining.split(/^(?=## )/m);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed) sections.push(trimmed);
    }
  }

  // Now break large sections into paragraph-level, then sentence-level
  const rawChunks: string[] = [];
  for (const section of sections) {
    if (estimateTokens(section) <= targetTokens) {
      rawChunks.push(section);
    } else {
      // Split on paragraph boundaries
      const paragraphs = section.split(/\n\n+/);
      let currentChunk = '';
      for (const para of paragraphs) {
        const combined = currentChunk ? currentChunk + '\n\n' + para : para;
        if (estimateTokens(combined) <= targetTokens) {
          currentChunk = combined;
        } else {
          if (currentChunk) rawChunks.push(currentChunk);
          // If this single paragraph exceeds target, split on sentences
          if (estimateTokens(para) > targetTokens) {
            const sentences = splitOnSentences(para);
            let sentChunk = '';
            for (const sent of sentences) {
              const sentCombined = sentChunk ? sentChunk + ' ' + sent : sent;
              if (estimateTokens(sentCombined) <= targetTokens) {
                sentChunk = sentCombined;
              } else {
                if (sentChunk) rawChunks.push(sentChunk);
                sentChunk = sent;
              }
            }
            if (sentChunk) rawChunks.push(sentChunk);
            currentChunk = '';
          } else {
            currentChunk = para;
          }
        }
      }
      if (currentChunk) rawChunks.push(currentChunk);
    }
  }

  if (rawChunks.length === 0) return [];

  // Apply overlap
  const chunks: string[] = [rawChunks[0]];
  for (let i = 1; i < rawChunks.length; i++) {
    const prevWords = rawChunks[i - 1].split(/\s+/).filter(Boolean);
    const overlapCharCount = overlapTokens * 4;
    // Approximate word count from char budget (~5 chars/word avg)
    const overlapWordCount = Math.floor(overlapCharCount / 5);
    const overlapWords = prevWords.slice(-overlapWordCount);
    const overlap = overlapWords.length > 0 ? overlapWords.join(' ') + ' ' : '';
    chunks.push(overlap + rawChunks[i]);
  }

  return chunks;
}

export function collectMemoryFiles(): Array<{ path: string; fullPath: string }> {
  const results: Array<{ path: string; fullPath: string }> = [];

  // Walk MEMORY_DIR recursively
  function walkDir(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const relPath = path.relative(WALNUT_HOME, fullPath);
        results.push({ path: relPath, fullPath });
      }
    }
  }

  walkDir(MEMORY_DIR);

  // Check for global MEMORY.md
  if (fs.existsSync(MEMORY_FILE)) {
    const relPath = path.relative(WALNUT_HOME, MEMORY_FILE);
    results.push({ path: relPath, fullPath: MEMORY_FILE });
  }

  return results;
}

export function indexMemoryFiles(): void {
  const database = getDb();
  const files = collectMemoryFiles();
  const existingPaths = new Set<string>();

  const getFileStmt = database.prepare('SELECT id, hash FROM files WHERE path = ?');
  const insertFileStmt = database.prepare('INSERT INTO files (path, hash, mtime) VALUES (?, ?, ?)');
  const updateFileStmt = database.prepare('UPDATE files SET hash = ?, mtime = ? WHERE id = ?');
  const deleteChunksStmt = database.prepare('DELETE FROM chunks WHERE file_id = ?');
  const insertChunkStmt = database.prepare('INSERT INTO chunks (file_id, text, offset) VALUES (?, ?, ?)');
  const deleteFileStmt = database.prepare('DELETE FROM files WHERE path = ?');
  const allPathsStmt = database.prepare('SELECT path FROM files');

  const transaction = database.transaction(() => {
    for (const file of files) {
      existingPaths.add(file.path);

      const content = fs.readFileSync(file.fullPath, 'utf-8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const stat = fs.statSync(file.fullPath);

      const existing = getFileStmt.get(file.path) as { id: number; hash: string } | undefined;

      if (existing) {
        if (existing.hash === hash) continue; // unchanged
        // File changed — delete old chunks, update file record
        deleteChunksStmt.run(existing.id);
        updateFileStmt.run(hash, stat.mtimeMs, existing.id);
        const chunks = chunkMarkdown(content);
        for (let i = 0; i < chunks.length; i++) {
          insertChunkStmt.run(existing.id, chunks[i], i);
        }
      } else {
        // New file
        const result = insertFileStmt.run(file.path, hash, stat.mtimeMs);
        const fileId = result.lastInsertRowid;
        const chunks = chunkMarkdown(content);
        for (let i = 0; i < chunks.length; i++) {
          insertChunkStmt.run(fileId, chunks[i], i);
        }
      }
    }

    // Remove files that no longer exist on disk
    const allPaths = allPathsStmt.all() as Array<{ path: string }>;
    for (const row of allPaths) {
      if (!existingPaths.has(row.path)) {
        deleteFileStmt.run(row.path);
      }
    }
  });

  transaction();
}

export function searchIndex(
  query: string,
  limit: number = 10,
): Array<{ text: string; path: string; score: number }> {
  const database = getDb();

  // FTS5 MATCH query — escape double quotes in the query
  const sanitized = query.replace(/"/g, '""');

  const stmt = database.prepare(`
    SELECT chunks.text, files.path, rank
    FROM chunks_fts
    JOIN chunks ON chunks.id = chunks_fts.rowid
    JOIN files ON files.id = chunks.file_id
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);

  const rows = stmt.all(sanitized, limit) as Array<{ text: string; path: string; rank: number }>;

  return rows.map((row) => ({
    text: row.text,
    path: row.path,
    score: -row.rank, // FTS5 rank is negative (lower = better), negate for positive scores
  }));
}
