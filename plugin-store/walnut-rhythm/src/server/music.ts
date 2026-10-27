/**
 * Focus music: the tracks in one folder on this Mac. PURE except for the two fs calls
 * it is handed.
 *
 * Rhythm ships no audio. The person puts their own files in the folder (by default
 * `<plugin data dir>/focus-music`, which never leaves this machine), and every surface
 * plays them from there through Walnut's raw file route, which serves byte ranges. Only
 * the folder's own files count, sorted by name with numbers in order, so "01 Brown
 * Noise.m4a" comes first. Only formats every surface plays are listed: Safari, the Mac
 * app's WebKit, Chromium and the phone all play AAC (.m4a), MP3 and WAV.
 */
import path from 'node:path'

export const DEFAULT_MUSIC_DIR = 'focus-music'
/** A folder this big is a library, not a focus playlist; the rest is not listed. */
export const MAX_TRACKS = 500

export const MUSIC_TYPES: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
}

export interface MusicTrack {
  /** The file name, unique within the folder. */
  id: string
  title: string
  /** Absolute path on this Mac. */
  file: string
  bytes: number
  type: string
}

export interface MusicListing {
  folder: string
  isDefault: boolean
  exists: boolean
  tracks: MusicTrack[]
  /** Audio-looking files left out because some surface cannot play them. */
  skipped: string[]
  /** Set when the folder could not be read; the listing is then empty. */
  error?: string
}

interface MusicEntry { name: string; isFile(): boolean; isSymbolicLink(): boolean }

export interface MusicFs {
  readdir(dir: string): Promise<MusicEntry[]>
  /** Follows links: a link to a file is a track, a link to a folder is not. */
  stat(file: string): Promise<{ size: number; isFile: boolean }>
}

const OTHER_AUDIO = new Set(['aac', 'flac', 'ogg', 'oga', 'opus', 'webm', 'aiff', 'aif', 'wma', 'alac'])

/** The configured folder as an absolute path; '' means the plugin's own default. */
export function resolveMusicFolder(configured: string, dataDir: string, home: string): { folder: string; isDefault: boolean; error?: string } {
  const raw = configured.trim()
  if (!raw) return { folder: path.join(dataDir, DEFAULT_MUSIC_DIR), isDefault: true }
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw
  if (!path.isAbsolute(expanded)) {
    return { folder: expanded, isDefault: false, error: `Music folder "${raw}" is not an absolute path. Use a path that starts with / or ~/.` }
  }
  return { folder: path.normalize(expanded), isDefault: false }
}

/** "01 Brown Noise.m4a" → "Brown Noise". The number only orders the list. */
export function trackTitle(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '')
  const stripped = base.replace(/^\d{1,3}\s*[-._)]?\s+/, '').trim()
  return stripped || base
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export async function listMusic(folder: string, isDefault: boolean, fs: MusicFs): Promise<MusicListing> {
  let entries: MusicEntry[]
  try {
    entries = await fs.readdir(folder)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { folder, isDefault, exists: false, tracks: [], skipped: [] }
    const reason = code === 'ENOTDIR' ? 'it is not a folder' : code === 'EACCES' || code === 'EPERM' ? 'permission denied' : String((error as Error).message ?? error)
    return { folder, isDefault, exists: true, tracks: [], skipped: [], error: `Rhythm could not read ${folder}: ${reason}.` }
  }
  const files = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort((a, b) => collator.compare(a, b))
  const tracks: MusicTrack[] = []
  const skipped: string[] = []
  for (const name of files) {
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    const type = name.includes('.') && Object.hasOwn(MUSIC_TYPES, ext) ? MUSIC_TYPES[ext] : undefined
    if (!type) {
      if (OTHER_AUDIO.has(ext)) skipped.push(name)
      continue
    }
    // Walnut's file route refuses any path with "..", so such a name could never play.
    if (name.includes('..')) {
      skipped.push(name)
      continue
    }
    if (tracks.length >= MAX_TRACKS) break
    const file = path.join(folder, name)
    // A file removed between the list and the stat (or a broken link) is simply not there.
    const info = await fs.stat(file).catch(() => null)
    if (!info || !info.isFile || info.size <= 0) continue
    tracks.push({ id: name, title: trackTitle(name), file, bytes: info.size, type })
  }
  return { folder, isDefault, exists: true, tracks, skipped }
}
