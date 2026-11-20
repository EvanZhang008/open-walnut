/**
 * Walnut's artifacts folder (src/core/artifacts/paths.ts) as the Notes page lists it, in its
 * "Walnut artifacts" section (2026-11-20, the user wants to look in one place):
 *
 *   GET /api/artifacts   { root, groups: [{ id, title, task_id?, files: [{ path, name, kind, bytes, at }] }] }
 *
 * One group for the org's skills, one for the shared notes, one per node (Main, a VP, a lead, any
 * task with something there), each file by its absolute path, which the app's file viewer opens.
 * Read only: the files are written through Walnut (agent_skill_write, agent_memory_write, the
 * reflection duty). The backups and the lock files are not listed.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { artifactsDir, NOTE_NAME_RE, SKILL_NAME_RE, TASK_ID_RE } from '../../core/artifacts/paths.js'

export const artifactsRouter = Router()

export interface ArtifactFile { path: string; name: string; kind: 'memory' | 'guidance' | 'skill' | 'note' | 'reflection'; bytes: number; at: string }
export interface ArtifactGroup { id: string; title: string; task_id?: string; files: ArtifactFile[] }


async function file(p: string, name: string, kind: ArtifactFile['kind']): Promise<ArtifactFile | null> {
  const st = await fsp.stat(p).catch(() => null)
  return st?.isFile() ? { path: p, name, kind, bytes: st.size, at: st.mtime.toISOString() } : null
}

const names = async (dir: string): Promise<string[]> => (await fsp.readdir(dir).catch(() => [] as string[])).sort()

async function skills(dir: string): Promise<ArtifactFile[]> {
  const out = await Promise.all((await names(dir)).filter((n) => SKILL_NAME_RE.test(n)).map((n) => file(path.join(dir, n, 'SKILL.md'), n, 'skill')))
  return out.filter((f): f is ArtifactFile => !!f)
}

async function notes(dir: string, kind: 'note' | 'reflection'): Promise<ArtifactFile[]> {
  const out = await Promise.all((await names(dir)).filter((n) => NOTE_NAME_RE.test(n)).map((n) => file(path.join(dir, n), n, kind)))
  return out.filter((f): f is ArtifactFile => !!f)
}

/** Newest reflection records first; everything else by name. */
async function nodeFiles(dir: string): Promise<ArtifactFile[]> {
  const top = await Promise.all([file(path.join(dir, 'MEMORY.md'), 'MEMORY.md', 'memory'), file(path.join(dir, 'guidance.md'), 'guidance.md', 'guidance')])
  return [
    ...top.filter((f): f is ArtifactFile => !!f),
    ...await skills(path.join(dir, 'skills')),
    ...await notes(path.join(dir, 'notes'), 'note'),
    ...(await notes(path.join(dir, 'reflections'), 'reflection')).reverse(),
  ]
}

/** Every group, the org's and the shared first, then the nodes: Main, the leads, the rest, each by title. */
export async function artifactGroups(): Promise<ArtifactGroup[]> {
  const root = artifactsDir()
  const groups: ArtifactGroup[] = []
  const org = await skills(path.join(root, 'org', 'skills'))
  if (org.length) groups.push({ id: 'org', title: 'Org skills', files: org })
  const shared = await notes(path.join(root, 'shared', 'notes'), 'note')
  if (shared.length) groups.push({ id: 'shared', title: 'Shared notes', files: shared })
  const [{ getTask }, { orgDisplayTitle }] = await Promise.all([import('../../core/task-manager.js'), import('../../core/org/org-tree.js')])
  const nodes: Array<ArtifactGroup & { rank: number }> = []
  for (const id of (await names(path.join(root, 'nodes'))).filter((n) => TASK_ID_RE.test(n))) {
    const files = await nodeFiles(path.join(root, 'nodes', id))
    if (!files.length) continue
    const task = await getTask(id).catch(() => null)
    const title = task ? (task.org_role === 'main' || task.org_role === 'lead' ? orgDisplayTitle(task) : task.title) : `${id} (deleted task)`
    nodes.push({ id: `node:${id}`, title, task_id: id, files, rank: task?.org_role === 'main' ? 0 : task?.org_role === 'lead' ? 1 : 2 })
  }
  nodes.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
  return [...groups, ...nodes.map(({ rank: _rank, ...g }) => g)]
}

artifactsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ root: artifactsDir(), groups: await artifactGroups() })
  } catch (err) {
    next(err)
  }
})
