import fs from 'node:fs'
import { log } from '../logging/index.js'

/**
 * Tails a JSONL file for new lines, calling onLine() for each complete line.
 *
 * Replaces piped stdout reading for detached sessions. Uses fs.watch()
 * for real-time notification with a 1s polling fallback (fs.watch can
 * miss events on some platforms/filesystems).
 */
export class JsonlTailer {
  private offset = 0
  private lineBuf = ''
  private fd: number | null = null
  private watcher: fs.FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    readonly filePath: string,
    private onLine: (line: string) => void,
  ) {}

  /**
   * Start tailing the file. Reads any existing content from fromOffset,
   * then watches for new data.
   */
  start(fromOffset = 0): void {
    this.offset = fromOffset
    this.stopped = false

    try {
      this.fd = fs.openSync(this.filePath, 'r')
    } catch (err) {
      log.session.warn('jsonl-tailer: failed to open file', {
        file: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    log.session.info('jsonl-tailer: tailing started', { filePath: this.filePath, fromOffset })

    // Read any existing content
    this.readNewData()

    // Watch for changes
    try {
      this.watcher = fs.watch(this.filePath, () => {
        if (!this.stopped) this.readNewData()
      })
      this.watcher.on('error', () => {
        // File may have been deleted or renamed — not critical
      })
    } catch {
      // fs.watch may not be available — rely on polling
    }

    // Polling fallback — fs.watch can miss events
    this.pollTimer = setInterval(() => {
      if (!this.stopped) this.readNewData()
    }, 1000)
  }

  /**
   * Stop tailing. Closes the file descriptor and clears watchers/timers.
   */
  stop(): void {
    log.session.info('jsonl-tailer: tailing ended', { filePath: this.filePath, totalBytes: this.offset })
    this.stopped = true

    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd)
      } catch {
        // Already closed
      }
      this.fd = null
    }
  }

  /**
   * Read new data from the current offset to EOF.
   * Splits into lines and calls onLine() for each complete line.
   * Partial lines are buffered for the next read.
   */
  readNewData(): void {
    if (this.fd === null || this.stopped) return

    try {
      const stat = fs.fstatSync(this.fd)
      const size = stat.size

      if (size <= this.offset) return

      const bytesToRead = size - this.offset
      const buf = Buffer.alloc(bytesToRead)
      const bytesRead = fs.readSync(this.fd, buf, 0, bytesToRead, this.offset)

      if (bytesRead === 0) return
      this.offset += bytesRead

      const chunk = buf.toString('utf-8', 0, bytesRead)
      this.lineBuf += chunk

      const lines = this.lineBuf.split('\n')
      // Keep the last (possibly incomplete) line in the buffer
      this.lineBuf = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        this.onLine(line.trim())
      }
    } catch (err) {
      log.session.debug('jsonl-tailer: read error', {
        file: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Flush any remaining buffered data and process it.
   * Call this when you know the writer has finished (process exited).
   */
  flush(): void {
    // Do a final read to catch any data written between last poll and now
    this.readNewData()

    // Process any remaining partial line in the buffer
    if (this.lineBuf.trim()) {
      this.onLine(this.lineBuf.trim())
      this.lineBuf = ''
    }
  }

  /** Current byte offset (useful for resumption). */
  get currentOffset(): number {
    return this.offset
  }
}
