export interface QmdEmbedProgress {
  chunksEmbedded: number;
  totalChunks: number;
  bytesProcessed: number;
  totalBytes: number;
}

export interface QmdFullIndexWork {
  kind: 'full';
  initialize?: boolean;
  force?: boolean;
  /**
   * Reclaim SQLite freelist pages after cleanup. The parent may set this only
   * while it holds a read-blocking store-reset reservation.
   */
  compact?: boolean;
}

export interface QmdIncrementalIndexWork {
  kind: 'incremental';
  memory?: boolean;
  notesFull?: boolean;
  forceNotes?: boolean;
  taskIds?: string[];
  sessionIds?: string[];
  notePaths?: string[];
}

export type QmdIndexWork = QmdFullIndexWork | QmdIncrementalIndexWork;

export interface QmdWorkerMessage {
  type: 'progress' | 'complete' | 'error';
  store?: string;
  progress?: QmdEmbedProgress;
  stats?: unknown;
  error?: string;
}
