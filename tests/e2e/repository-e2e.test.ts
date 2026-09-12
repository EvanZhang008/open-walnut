/**
 * E2E tests for the repository feature — real server + full CRUD lifecycle.
 *
 * What's real: Express server, repository YAML file I/O, CWD→repo matching.
 * What's mocked: constants.js (temp dir).
 *
 * Tests verify:
 *   1. REST API CRUD — create, list, read, update, delete repos
 *   2. Path traversal protection — slug validation on all routes
 *   3. YAML parsing — multiline fields, special characters, tech_stack arrays
 *   4. CWD→repo matching — exact match, prefix match, longest prefix, no match
 *   5. Session context injection — matched repo appears in system prompt
 *   6. Edge cases — large YAML, empty hosts, .yml extension
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('repo-e2e'))

import { WALNUT_HOME, REPOSITORIES_DIR } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { findRepoByPath } from '../../src/core/repository-matcher.js'

// ── Helpers ──

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

async function api(method: string, path: string, body?: Record<string, unknown>) {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  }
  if (body) opts.body = JSON.stringify(body)
  return fetch(apiUrl(path), opts)
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── REST API CRUD ──

describe('REST API CRUD lifecycle', () => {
  const testYaml = [
    'name: E2E Test Repo',
    'description: A repository for E2E testing',
    'tech_stack: [TypeScript, Vitest]',
    'hosts:',
    '  local:',
    '    path: /tmp/e2e-test-repo',
    '  cloud:',
    '    path: /workspace/e2e-test',
    '    ssh_host: dev-box',
  ].join('\n')

  it('creates a new repository', async () => {
    const res = await api('POST', '/api/repositories/e2e-test', { content: testYaml })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('created')
  })

  it('lists repositories including the created one', async () => {
    const res = await api('GET', '/api/repositories')
    expect(res.status).toBe(200)
    const body = await res.json()
    const repo = body.repositories.find((r: any) => r.slug === 'e2e-test')
    expect(repo).toBeDefined()
    expect(repo.name).toBe('E2E Test Repo')
    expect(repo.description).toBe('A repository for E2E testing')
    expect(repo.tech_stack).toBe('TypeScript, Vitest')
    expect(repo.hosts.local).toBeDefined()
    expect(repo.hosts.local.path).toBe('/tmp/e2e-test-repo')
    expect(repo.hosts.cloud.ssh_host).toBe('dev-box')
  })

  it('reads a single repository', async () => {
    const res = await api('GET', '/api/repositories/e2e-test')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slug).toBe('e2e-test')
    expect(body.content).toBe(testYaml)
    expect(body.modified).toBeTruthy()
  })

  it('updates an existing repository', async () => {
    const updated = testYaml.replace('A repository for E2E testing', 'Updated description')
    const res = await api('POST', '/api/repositories/e2e-test', { content: updated })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('updated')

    // Verify the update persisted
    const readRes = await api('GET', '/api/repositories/e2e-test')
    const readBody = await readRes.json()
    expect(readBody.content).toContain('Updated description')
  })

  it('deletes a repository', async () => {
    const res = await api('DELETE', '/api/repositories/e2e-test')
    expect(res.status).toBe(200)

    const readRes = await api('GET', '/api/repositories/e2e-test')
    expect(readRes.status).toBe(404)
  })

  it('returns 404 for non-existent repo', async () => {
    const res = await api('GET', '/api/repositories/nonexistent')
    expect(res.status).toBe(404)
  })

  it('returns 404 when deleting non-existent repo', async () => {
    const res = await api('DELETE', '/api/repositories/ghost')
    expect(res.status).toBe(404)
  })
})

// ── Path Traversal Protection ──

describe('Path traversal protection', () => {
  it('rejects GET with path traversal in slug', async () => {
    const res = await api('GET', '/api/repositories/..%2F..%2Fetc%2Fpasswd')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid repository name')
  })

  it('rejects DELETE with path traversal in slug', async () => {
    const res = await api('DELETE', '/api/repositories/..%2Ffoo')
    expect(res.status).toBe(400)
  })

  it('rejects POST with path traversal in slug', async () => {
    const res = await api('POST', '/api/repositories/..%2Fetc%2Fpasswd', {
      content: 'malicious: content',
    })
    expect(res.status).toBe(400)
  })

  it('rejects slug starting with hyphen', async () => {
    const res = await api('POST', '/api/repositories/-bad', {
      content: 'name: Bad\n',
    })
    expect(res.status).toBe(400)
  })

  it('rejects slug with spaces', async () => {
    const res = await api('POST', '/api/repositories/bad%20name', {
      content: 'name: Bad\n',
    })
    expect(res.status).toBe(400)
  })

  it('accepts slug with dots and underscores', async () => {
    const res = await api('POST', '/api/repositories/my_repo.v2', {
      content: 'name: My Repo V2\nhosts:\n  local:\n    path: /tmp\n',
    })
    expect(res.status).toBe(200)
    // Clean up
    await api('DELETE', '/api/repositories/my_repo.v2')
  })
})

// ── YAML Parsing Edge Cases ──

describe('YAML parsing edge cases', () => {
  it('handles multiline description with | syntax', async () => {
    await api('POST', '/api/repositories/ml-desc', {
      content: [
        'name: Multiline Desc',
        'description: |',
        '  This is a multiline',
        '  description block',
        'hosts:',
        '  local:',
        '    path: /tmp/ml',
      ].join('\n'),
    })

    const res = await api('GET', '/api/repositories')
    const body = await res.json()
    const repo = body.repositories.find((r: any) => r.slug === 'ml-desc')
    expect(repo).toBeDefined()
    expect(repo.description).toBe('This is a multiline')
    await api('DELETE', '/api/repositories/ml-desc')
  })

  it('handles inline tech_stack array', async () => {
    await api('POST', '/api/repositories/tech-test', {
      content: [
        'name: Tech Test',
        'tech_stack: [Python, FastAPI, PostgreSQL]',
        'hosts:',
        '  local:',
        '    path: /tmp/tech',
      ].join('\n'),
    })

    const res = await api('GET', '/api/repositories')
    const body = await res.json()
    const repo = body.repositories.find((r: any) => r.slug === 'tech-test')
    expect(repo.tech_stack).toBe('Python, FastAPI, PostgreSQL')
    await api('DELETE', '/api/repositories/tech-test')
  })

  it('handles repo with overview and architecture fields', async () => {
    const richYaml = [
      'name: Rich Repo',
      'description: Has rich profile fields',
      'tech_stack: [TypeScript]',
      'hosts:',
      '  local:',
      '    path: /tmp/rich',
      'overview: |',
      '  What: A rich repository',
      '  Why: Testing purposes',
      '  How: With YAML',
      'architecture: |',
      '  Frontend: React',
      '  Backend: Express',
    ].join('\n')

    await api('POST', '/api/repositories/rich-repo', { content: richYaml })
    const res = await api('GET', '/api/repositories/rich-repo')
    const body = await res.json()
    expect(body.content).toContain('overview:')
    expect(body.content).toContain('architecture:')
    await api('DELETE', '/api/repositories/rich-repo')
  })

  it('rejects content exceeding 100KB', async () => {
    const bigContent = 'x'.repeat(100_001)
    const res = await api('POST', '/api/repositories/too-big', { content: bigContent })
    expect(res.status).toBe(413)
  })

  it('rejects missing content field', async () => {
    const res = await api('POST', '/api/repositories/no-content', {})
    expect(res.status).toBe(400)
  })
})

// ── CWD→Repo Matching ──

describe('CWD→repo matching via findRepoByPath', () => {
  const basePath = `/tmp/repo-e2e-match-${process.pid}`

  beforeAll(async () => {
    await fs.mkdir(path.join(basePath, 'src', 'core'), { recursive: true })
    await fs.mkdir(path.join(basePath, 'packages', 'child'), { recursive: true })
    await fs.mkdir(REPOSITORIES_DIR, { recursive: true })

    // Create parent repo
    await fs.writeFile(
      path.join(REPOSITORIES_DIR, 'parent.yaml'),
      [
        'name: Parent Monorepo',
        'description: Root-level repo',
        'tech_stack: [TypeScript]',
        'hosts:',
        '  local:',
        `    path: ${basePath}`,
      ].join('\n'),
      'utf-8',
    )

    // Create child repo (nested path)
    await fs.writeFile(
      path.join(REPOSITORIES_DIR, 'child.yaml'),
      [
        'name: Child Package',
        'description: Nested package',
        'architecture_notes: |',
        '  This is a child package inside the monorepo.',
        'hosts:',
        '  local:',
        `    path: ${path.join(basePath, 'packages', 'child')}`,
      ].join('\n'),
      'utf-8',
    )
  })

  afterAll(async () => {
    await fs.rm(basePath, { recursive: true, force: true })
  })

  it('matches exact path', () => {
    const result = findRepoByPath(basePath)
    expect(result).toBeDefined()
    expect(result!.name).toBe('Parent Monorepo')
  })

  it('matches subdirectory of host path', () => {
    const result = findRepoByPath(path.join(basePath, 'src', 'core'))
    expect(result).toBeDefined()
    expect(result!.name).toBe('Parent Monorepo')
  })

  it('picks longest prefix for nested repos', () => {
    const childCwd = path.join(basePath, 'packages', 'child', 'src')
    const result = findRepoByPath(childCwd)
    expect(result).toBeDefined()
    expect(result!.name).toBe('Child Package')
    expect(result!.slug).toBe('child')
  })

  it('returns parent for non-child subdirectory', () => {
    const result = findRepoByPath(path.join(basePath, 'docs'))
    expect(result).toBeDefined()
    expect(result!.name).toBe('Parent Monorepo')
  })

  it('returns undefined for unrelated path', () => {
    const result = findRepoByPath('/tmp/completely-unrelated')
    expect(result).toBeUndefined()
  })

  it('does not match prefix of similar directory name', () => {
    // /tmp/repo-e2e-match-XYZ should NOT match /tmp/repo-e2e-match-XYZ-extra
    const result = findRepoByPath(basePath + '-extra')
    expect(result).toBeUndefined()
  })

  it('extracts architecture_notes from matched repo', () => {
    const result = findRepoByPath(path.join(basePath, 'packages', 'child'))
    expect(result).toBeDefined()
    expect(result!.architecture_notes).toContain('child package')
  })
})

// ── Session Context Injection ──

describe('Session context injection', () => {
  const testPath = `/tmp/repo-e2e-context-${process.pid}`

  beforeAll(async () => {
    await fs.mkdir(testPath, { recursive: true })
    await fs.mkdir(REPOSITORIES_DIR, { recursive: true })

    await fs.writeFile(
      path.join(REPOSITORIES_DIR, 'context-test.yaml'),
      [
        'name: Context Test Repo',
        'description: Tests session context injection',
        'tech_stack: [Rust, Wasm]',
        'overview: |',
        '  A test repo for verifying session context injection.',
        'architecture: |',
        '  Core: Rust library',
        '  WASM: Browser bindings',
        'common_commands: |',
        '  cargo build',
        '  cargo test',
        'hosts:',
        '  local:',
        `    path: ${testPath}`,
      ].join('\n'),
      'utf-8',
    )
  })

  afterAll(async () => {
    await fs.rm(testPath, { recursive: true, force: true })
  })

  // buildSessionContext is a no-op as of 2026-06-18 — Walnut no longer injects
  // repository (or any other) context into a session's system prompt. Repo
  // matching itself (findRepoByPath, tested above) still works; it's just no
  // longer fed into the system prompt. These tests pin the no-op contract.
  it('does not inject repo context even when CWD matches a configured repo', async () => {
    const { buildSessionContext } = await import('../../src/core/sessions/session-context.js')

    const createRes = await api('POST', '/api/tasks', {
      title: 'Context injection test task',
      category: 'test',
    })
    const createBody = await createRes.json()
    const taskId = createBody.task.id

    const ctx = await buildSessionContext(taskId, testPath)

    expect(ctx.systemPrompt).toBe('')
    expect(ctx.systemPrompt).not.toContain('repository_context')
    expect(ctx.systemPrompt).not.toContain('Context Test Repo')
  })

  it('returns an empty prompt when CWD does not match any repo', async () => {
    const { buildSessionContext } = await import('../../src/core/sessions/session-context.js')

    const createRes = await api('POST', '/api/tasks', {
      title: 'No-match context test',
      category: 'test',
    })
    const createBody = await createRes.json()
    const taskId = createBody.task.id

    const ctx = await buildSessionContext(taskId, '/tmp/no-repo-here')

    expect(ctx.systemPrompt).toBe('')
  })
})
