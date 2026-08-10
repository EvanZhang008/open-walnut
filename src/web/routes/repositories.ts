/**
 * Repositories routes — CRUD for repository YAML profiles.
 *
 * The operation functions (listRepositories / readRepository / writeRepository /
 * deleteRepository) are exported and shared with the /api/v1 mobile router
 * (library-v1.ts) — one implementation, two thin route shells.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { REPOSITORIES_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'

const MAX_REPO_SIZE = 100_000 // 100 KB
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i

/** Typed error for repository ops so both route shells map status codes identically. */
export class RepositoryOpError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message)
    this.name = 'RepositoryOpError'
  }
}

/**
 * Validate a repo slug (throws 400). Applied to ALL ops — Express decodes %2F
 * in params, so without this, path traversal via e.g. ..%2F..%2Fetc is possible.
 */
function requireSlug(name: unknown): string {
  if (typeof name !== 'string' || !SLUG_RE.test(name)) {
    throw new RepositoryOpError('Invalid repository name. Use alphanumeric, hyphens, dots, underscores.', 400)
  }
  return name
}

export interface RepositoryListItem {
  slug: string
  name: string
  description: string
  tech_stack: string
  hosts: Record<string, { path?: string; ssh_host?: string }>
  modified: string
  size: number
}

/** List all repository profiles (parsed YAML headers, no full content). */
export async function listRepositories(): Promise<{ repositories: RepositoryListItem[] }> {
  await fsp.mkdir(REPOSITORIES_DIR, { recursive: true })
  const files = (await fsp.readdir(REPOSITORIES_DIR))
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()

  const repositories = await Promise.all(files.map(async (f) => {
    const slug = f.replace(/\.ya?ml$/, '')
    const fullPath = path.join(REPOSITORIES_DIR, f)
    const content = await fsp.readFile(fullPath, 'utf-8')
    const stat = await fsp.stat(fullPath)
    const header = parseYamlHeader(content)
    return {
      slug,
      name: header.name || slug,
      description: header.description || '',
      tech_stack: header.tech_stack || '',
      hosts: header.hosts,
      modified: stat.mtime.toISOString(),
      size: stat.size,
    }
  }))

  return { repositories }
}

/** Read one repository profile's full YAML content. */
export async function readRepository(name: unknown): Promise<{ slug: string; content: string; modified: string }> {
  const slug = requireSlug(name)
  const filePath = path.join(REPOSITORIES_DIR, `${slug}.yaml`)
  try {
    const content = await fsp.readFile(filePath, 'utf-8')
    const stat = await fsp.stat(filePath)
    return { slug, content, modified: stat.mtime.toISOString() }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RepositoryOpError(`Repository "${slug}" not found`, 404)
    }
    throw err
  }
}

/** Create or update a repository profile. */
export async function writeRepository(name: unknown, content: unknown): Promise<{ ok: true; status: 'created' | 'updated' }> {
  if (typeof content !== 'string') {
    throw new RepositoryOpError('content (string) is required', 400)
  }
  if (content.length > MAX_REPO_SIZE) {
    throw new RepositoryOpError(`Content too large (max ${MAX_REPO_SIZE} bytes)`, 413)
  }
  const slug = requireSlug(name)
  await fsp.mkdir(REPOSITORIES_DIR, { recursive: true })
  const filePath = path.join(REPOSITORIES_DIR, `${slug}.yaml`)
  const existed = fs.existsSync(filePath)
  await fsp.writeFile(filePath, content, 'utf-8')
  log.memory.info(`Repository ${existed ? 'updated' : 'created'} via UI`, { name: slug })
  return { ok: true, status: existed ? 'updated' : 'created' }
}

/** Delete a repository profile. */
export async function deleteRepository(name: unknown): Promise<{ ok: true }> {
  const slug = requireSlug(name)
  const filePath = path.join(REPOSITORIES_DIR, `${slug}.yaml`)
  try {
    await fsp.unlink(filePath)
    log.memory.info('Repository deleted via UI', { name: slug })
    return { ok: true }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RepositoryOpError(`Repository "${slug}" not found`, 404)
    }
    throw err
  }
}

export const repositoriesRouter = Router()

/** Route shell: run an op, map RepositoryOpError to the legacy { error } shape. */
async function run(res: Response, next: NextFunction, fn: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await fn())
  } catch (err) {
    if (err instanceof RepositoryOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
}

// GET /api/repositories — list all repos
repositoriesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  await run(res, next, () => listRepositories())
})

// GET /api/repositories/:name — read single repo
repositoriesRouter.get('/:name', async (req: Request, res: Response, next: NextFunction) => {
  await run(res, next, () => readRepository(req.params.name))
})

// POST /api/repositories/:name — create or update repo
repositoriesRouter.post('/:name', async (req: Request, res: Response, next: NextFunction) => {
  await run(res, next, () => writeRepository(req.params.name, req.body?.content))
})

// DELETE /api/repositories/:name — delete repo
repositoriesRouter.delete('/:name', async (req: Request, res: Response, next: NextFunction) => {
  await run(res, next, () => deleteRepository(req.params.name))
})

/**
 * Parse YAML header fields without a full YAML parser.
 */
function parseYamlHeader(content: string): { name?: string; description?: string; tech_stack?: string; hosts: Record<string, { path?: string; ssh_host?: string }> } {
  const lines = content.split('\n')
  let name: string | undefined
  let description: string | undefined
  let tech_stack: string | undefined
  const hosts: Record<string, { path?: string; ssh_host?: string }> = {}
  let inHosts = false
  let currentHost: string | null = null

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (line.startsWith('name:')) {
      name = line.slice('name:'.length).trim().replace(/^["']|["']$/g, '')
      inHosts = false
    } else if (line.startsWith('description:')) {
      const val = line.slice('description:'.length).trim().replace(/^["']|["']$/g, '')
      if (val !== '|' && val !== '>') description = val
      else {
        // Read next indented line
        for (let i = li + 1; i < lines.length; i++) {
          if (lines[i].startsWith(' ') && lines[i].trim()) {
            description = lines[i].trim()
            break
          }
          if (!lines[i].startsWith(' ') && lines[i].trim()) break
        }
      }
      inHosts = false
    } else if (line.startsWith('tech_stack:')) {
      const val = line.slice('tech_stack:'.length).trim()
      tech_stack = val.startsWith('[') ? val.replace(/[\[\]]/g, '').trim() : val
      inHosts = false
    } else if (line.startsWith('hosts:')) {
      inHosts = true
      currentHost = null
    } else if (inHosts) {
      const hostMatch = line.match(/^  (\S+):$/)
      if (hostMatch) {
        currentHost = hostMatch[1]
        hosts[currentHost] = {}
      } else if (currentHost) {
        const pathMatch = line.match(/^\s+path:\s*(.+)/)
        if (pathMatch) hosts[currentHost].path = pathMatch[1].trim().replace(/^["']|["']$/g, '')
        const sshMatch = line.match(/^\s+ssh_host:\s*(.+)/)
        if (sshMatch) hosts[currentHost].ssh_host = sshMatch[1].trim().replace(/^["']|["']$/g, '')
      } else if (!line.startsWith(' ')) {
        inHosts = false
      }
    }
  }

  return { name, description, tech_stack, hosts }
}
