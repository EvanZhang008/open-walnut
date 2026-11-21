/**
 * Focus spaces: the person's saved lists of projects and tasks to focus on.
 *
 * A space is a list read beside the board, never a move: it names project names and task ids,
 * and every task stays where it lives, so Main and every lead still see it. Which tasks a
 * space holds is the scope rule (scope.ts). Each app in a space either inherits Main's (the
 * same data, the same session), starts fresh, or is hidden there (`focusAppMode` in scope.ts).
 *
 * Stored in <WALNUT_HOME>/focus-spaces.json, which rides the data folder's git sync, so every
 * box of the person reads the same spaces; the phone reads them through /api/v1. Which space
 * the person is in right now is this box's own (active.ts).
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'
import { normalizeScope, scopeIsEmpty, type FocusAppMode, type FocusScope, type FocusSpace } from './scope.js'

export type { FocusAppMode, FocusSpace }

export interface FocusSpaceInput {
  name?: unknown
  projects?: unknown
  tasks?: unknown
  apps?: unknown
}

const MAX_SPACES = 30
const MAX_NAME = 60
const MAX_APPS = 60
const ID_RE = /^fs-[0-9a-f]{8}$/
const APP_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const MODES: readonly FocusAppMode[] = ['inherit', 'isolated', 'off']

interface FileShape { version: 1; spaces: FocusSpace[] }
const EMPTY: FileShape = { version: 1, spaces: [] }

export class FocusSpaceError extends Error {
  constructor(public code: 'not_found' | 'bad_request' | 'too_many', message: string) { super(message) }
}

function spacesFile(): string {
  return path.join(WALNUT_HOME, 'focus-spaces.json')
}

export function isFocusSpaceId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

function cleanApps(raw: unknown): Record<string, FocusAppMode> {
  const out: Record<string, FocusAppMode> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, mode] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_APPS) break
    if (APP_ID_RE.test(id) && MODES.includes(mode as FocusAppMode)) out[id] = mode as FocusAppMode
  }
  return out
}

function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : ''
}

/** A stored row as this version reads it: junk dropped, an unreadable row skipped. */
function readRow(raw: unknown): FocusSpace | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isFocusSpaceId(r.id)) return null
  const scope = normalizeScope(r)
  return {
    id: r.id,
    name: cleanName(r.name) || 'Focus',
    projects: [...(scope.projects ?? [])],
    tasks: [...(scope.tasks ?? [])],
    apps: cleanApps(r.apps),
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : new Date(0).toISOString(),
  }
}

function rowsOf(file: unknown): FocusSpace[] {
  const list = file && typeof file === 'object' ? (file as { spaces?: unknown }).spaces : undefined
  return (Array.isArray(list) ? list : []).flatMap((one) => readRow(one) ?? [])
}

export async function listFocusSpaces(): Promise<FocusSpace[]> {
  return rowsOf(await readJsonFile<unknown>(spacesFile(), EMPTY))
}

export async function getFocusSpace(id: string): Promise<FocusSpace | null> {
  return (await listFocusSpaces()).find((s) => s.id === id) ?? null
}

/** The scope a space reads as (scope.ts). */
export function spaceScope(space: Pick<FocusSpace, 'projects' | 'tasks'>): FocusScope {
  return normalizeScope({ projects: space.projects, tasks: space.tasks })
}

/** A new space from `input` (no file touched): a test run keeps its own copy of the list. */
export function newFocusSpace(input: FocusSpaceInput, now = new Date()): FocusSpace {
  const scope = normalizeScope(input)
  if (scopeIsEmpty(scope)) throw new FocusSpaceError('bad_request', 'A focus space needs at least one project or task.')
  const stamp = now.toISOString()
  return {
    id: `fs-${crypto.randomBytes(4).toString('hex')}`,
    name: cleanName(input.name) || 'Focus',
    projects: [...(scope.projects ?? [])],
    tasks: [...(scope.tasks ?? [])],
    apps: cleanApps(input.apps),
    createdAt: stamp,
    updatedAt: stamp,
  }
}

/** `current` with `input`'s fields changed (absent = kept). */
export function patchFocusSpace(current: FocusSpace, input: FocusSpaceInput, now = new Date()): FocusSpace {
  const scope = normalizeScope({
    projects: input.projects !== undefined ? input.projects : current.projects,
    tasks: input.tasks !== undefined ? input.tasks : current.tasks,
  })
  if (scopeIsEmpty(scope)) throw new FocusSpaceError('bad_request', 'A focus space needs at least one project or task.')
  return {
    ...current,
    ...(input.name !== undefined ? { name: cleanName(input.name) || current.name } : {}),
    projects: [...(scope.projects ?? [])],
    tasks: [...(scope.tasks ?? [])],
    ...(input.apps !== undefined ? { apps: cleanApps(input.apps) } : {}),
    updatedAt: now.toISOString(),
  }
}

export const MAX_FOCUS_SPACES = MAX_SPACES

export async function createFocusSpace(input: FocusSpaceInput, now = new Date()): Promise<FocusSpace> {
  const space = newFocusSpace(input, now)
  await updateJsonFile<unknown>(spacesFile(), EMPTY, (file) => {
    const rows = rowsOf(file)
    if (rows.length >= MAX_SPACES) throw new FocusSpaceError('too_many', `At most ${MAX_SPACES} focus spaces.`)
    return { ...(file as object), version: 1, spaces: [...((file as FileShape).spaces ?? []), space] }
  })
  return space
}

export async function updateFocusSpace(id: string, input: FocusSpaceInput, now = new Date()): Promise<FocusSpace> {
  let out: FocusSpace | null = null
  await updateJsonFile<unknown>(spacesFile(), EMPTY, (file) => {
    const raw = Array.isArray((file as FileShape).spaces) ? (file as FileShape).spaces : []
    const at = raw.findIndex((row) => (row as { id?: unknown })?.id === id)
    const current = at >= 0 ? readRow(raw[at]) : null
    if (!current) throw new FocusSpaceError('not_found', 'No such focus space.')
    const next = patchFocusSpace(current, input, now)
    // Keep fields a newer version wrote on the row.
    const merged = { ...(raw[at] as object), ...next }
    out = next
    const spaces = [...raw]
    spaces[at] = merged as FocusSpace
    return { ...(file as object), version: 1, spaces }
  })
  return out!
}

export async function deleteFocusSpace(id: string): Promise<boolean> {
  let removed = false
  await updateJsonFile<unknown>(spacesFile(), EMPTY, (file) => {
    const raw = Array.isArray((file as FileShape).spaces) ? (file as FileShape).spaces : []
    const spaces = raw.filter((row) => (row as { id?: unknown })?.id !== id)
    removed = spaces.length !== raw.length
    return { ...(file as object), version: 1, spaces }
  })
  return removed
}
