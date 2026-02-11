import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR, WALNUT_HOME } from '../constants.js';
import { indexMemoryFiles } from './memory-index.js';
import { log } from '../logging/index.js';

function notifyGitVersioning(filename: string): void {
  // Fire-and-forget async import to avoid issues with ESM
  import('./git-versioning.js')
    .then(({ getGitVersioning }) => {
      getGitVersioning()?.notifyMemoryChange(filename);
    })
    .catch(() => {
      // Git versioning not available — ignore
    });
}

export function startMemoryWatcher(): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let embeddingTimer: ReturnType<typeof setTimeout> | null = null;
  const watchers: fs.FSWatcher[] = [];

  function scheduleReindex(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        indexMemoryFiles();
        // After FTS reindex, schedule chunk embedding (delayed to avoid blocking)
        scheduleChunkEmbedding();
      } catch {
        // Graceful degradation — indexing failure should not crash the app
      }
    }, 1500);
  }

  function scheduleChunkEmbedding(): void {
    if (embeddingTimer) clearTimeout(embeddingTimer);
    embeddingTimer = setTimeout(async () => {
      try {
        const { reconcileChunkEmbeddings } = await import('./embedding/pipeline.js');
        const result = await reconcileChunkEmbeddings();
        if (result.embedded > 0) {
          log.agent.info(`Memory watcher: embedded ${result.embedded} new chunks`);
        }
      } catch {
        // Graceful degradation — embedding failure is non-fatal
      }
    }, 3000); // 3s after FTS reindex to avoid overlap
  }

  try {
    // Watch MEMORY_DIR recursively for any .md file changes
    if (fs.existsSync(MEMORY_DIR)) {
      const dirWatcher = fs.watch(MEMORY_DIR, { recursive: true }, (_event, filename) => {
        if (filename && filename.endsWith('.md')) {
          scheduleReindex();
          // Notify git versioning of memory file change
          notifyGitVersioning(filename);
        }
      });
      watchers.push(dirWatcher);
    }

    // Watch WALNUT_HOME (non-recursive) for MEMORY.md changes
    if (fs.existsSync(WALNUT_HOME)) {
      const homeWatcher = fs.watch(WALNUT_HOME, (_event, filename) => {
        if (filename === 'MEMORY.md') {
          scheduleReindex();
          notifyGitVersioning(filename);
        }
      });
      watchers.push(homeWatcher);
    }
  } catch {
    // Graceful degradation — watcher setup failure is non-fatal
  }

  return {
    stop(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (embeddingTimer) {
        clearTimeout(embeddingTimer);
        embeddingTimer = null;
      }
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      watchers.length = 0;
    },
  };
}
