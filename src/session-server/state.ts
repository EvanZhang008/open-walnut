/**
 * Session Server State — minimal persistence for crash recovery.
 *
 * Stores active session IDs + metadata to disk so the session server
 * can mark sessions as idle on restart. Actual resume is handled by
 * the SDK (which stores conversation history in ~/.claude/projects/).
 */

import fs from 'node:fs'
import path from 'node:path'

export interface PersistedSession {
  sessionId: string
  cwd?: string
  mode?: string
  startedAt: string
}

export interface SessionState {
  sessions: PersistedSession[]
}

const STATE_FILE = 'session-server-state.json'

export class StateManager {
  private filePath: string
  private sessions = new Map<string, PersistedSession>()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, STATE_FILE)
    this.load()
  }

  /** Add or update a session. */
  set(sessionId: string, data: Omit<PersistedSession, 'sessionId'>): void {
    this.sessions.set(sessionId, { sessionId, ...data })
    this.save()
  }

  /** Remove a session. */
  remove(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.save()
  }

  /** Get all persisted sessions. */
  getAll(): PersistedSession[] {
    return Array.from(this.sessions.values())
  }

  /** Clear all sessions. */
  clear(): void {
    this.sessions.clear()
    this.save()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8')
        const state: SessionState = JSON.parse(raw)
        for (const s of state.sessions) {
          this.sessions.set(s.sessionId, s)
        }
      }
    } catch {
      // Corrupt or missing file — start fresh
      this.sessions.clear()
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath)
      fs.mkdirSync(dir, { recursive: true })
      const state: SessionState = {
        sessions: Array.from(this.sessions.values()),
      }
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2) + '\n', 'utf-8')
    } catch {
      // Non-critical — state can be lost
    }
  }
}
