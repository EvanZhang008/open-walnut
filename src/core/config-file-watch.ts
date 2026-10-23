/**
 * An edit of config.yaml made outside Walnut (an editor, an AI session's file
 * tools, a script) takes effect like a Settings save.
 *
 * Every reader already reads the file on each call (getConfig), but the things
 * that act on a change start on CONFIG_CHANGED or onConfigWritten, which only
 * Walnut's own writes fired: the followers' copies (core/replication/kinds/),
 * a host's notes copy and what it keeps (core/host-replica-sync.ts), the
 * heartbeat, the host list. Before this, a hand-set
 * `hosts.<alias>.keep.notes_exclude` left the note on that host until the next
 * 5-minute sweep.
 *
 * Polls the file's stat (fs.watchFile goes by path, so an editor's
 * rename-replace is seen, and the sqlite files beside it raise no events),
 * waits for the writes to settle, then reads and parses the file. Skipped:
 * Walnut's own write (the same hash), a file that does not parse as a mapping
 * (an editor mid-save; the next stat change tries again), content seen before.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import yaml from 'js-yaml'
import { CONFIG_FILE } from '../constants.js'
import { log } from '../logging/index.js'
import { announceConfigWritten, configContentHash, isOwnConfigWrite } from './config-manager.js'
import { bus, EventNames } from './event-bus.js'

const POLL_MS = 2_000
const SETTLE_MS = 500

export interface ConfigFileWatchOptions { file?: string; pollMs?: number; settleMs?: number }

export function startConfigFileWatch(opts: ConfigFileWatchOptions = {}): { stop: () => void } {
  const file = opts.file ?? CONFIG_FILE
  const settleMs = opts.settleMs ?? SETTLE_MS
  let seen: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  // The file as it stands at start is no change.
  void fsp.readFile(file, 'utf-8').then((c) => { seen ??= configContentHash(c) }).catch(() => {})

  const check = async (): Promise<void> => {
    let content: string
    try { content = await fsp.readFile(file, 'utf-8') } catch { return }
    if (stopped) return
    const hash = configContentHash(content)
    if (hash === seen) return
    if (isOwnConfigWrite(hash)) { seen = hash; return }
    let parsed: unknown
    try { parsed = yaml.load(content) } catch (err) {
      log.session.warn('config.yaml changed outside Walnut but does not parse: waiting for the next save', { error: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log.session.warn('config.yaml changed outside Walnut but is not a mapping: waiting for the next save', { bytes: content.length })
      return
    }
    seen = hash
    log.session.info('config.yaml changed outside Walnut: applying it like a save', { bytes: content.length })
    announceConfigWritten()
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'config.yaml' }, ['web-ui'], { source: 'config-file' })
  }

  const listener = (cur: fs.Stats, prev: fs.Stats): void => {
    if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size && cur.ino === prev.ino) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; if (!stopped) void check() }, settleMs)
    timer.unref?.()
  }
  fs.watchFile(file, { interval: opts.pollMs ?? POLL_MS, persistent: false }, listener)
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      fs.unwatchFile(file, listener)
    },
  }
}
