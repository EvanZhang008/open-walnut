/**
 * Unit tests for the shared dynamic-workflow progress accumulator
 * (src/core/workflow-progress.ts) and the on-disk manifest reconstruction
 * (reconstructWorkflowProgress in session-history.ts).
 *
 * The accumulator is the SINGLE source of truth parsed by both the live event
 * ingest (ClaudeCodeSession) and the persisted-manifest reload path, so these
 * tests pin its contract: ghost-filtering, merge-don't-clobber, phase upsert,
 * state normalization, and full reconstruction from a real wf_*.json manifest.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import {
  normalizeWorkflowState,
  accumulateWorkflowProgress,
  sortedPhases,
  sortedAgents,
} from '../../src/core/workflow-progress.js'
import type { WorkflowPhaseInfo, WorkflowAgentInfo } from '../../src/core/event-types.js'
import { reconstructWorkflowProgress } from '../../src/core/session-history.js'
import { encodeProjectPath } from '../../src/core/session-file-reader.js'
import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js'

function emptyMaps() {
  return {
    phases: new Map<number, WorkflowPhaseInfo>(),
    agents: new Map<string, WorkflowAgentInfo>(),
  }
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ── normalizeWorkflowState ──

describe('normalizeWorkflowState', () => {
  it('maps observed + synonym states, defaults unknown to running', () => {
    expect(normalizeWorkflowState('start')).toBe('running')
    expect(normalizeWorkflowState('running')).toBe('running')
    expect(normalizeWorkflowState('done')).toBe('completed')
    expect(normalizeWorkflowState('success')).toBe('completed')
    expect(normalizeWorkflowState('failed')).toBe('failed')
    expect(normalizeWorkflowState('error')).toBe('failed')
    expect(normalizeWorkflowState('killed')).toBe('stopped')
    expect(normalizeWorkflowState('cancelled')).toBe('stopped')
    expect(normalizeWorkflowState('queued')).toBe('pending')
    // Defensive: unknown / null / undefined never throw, fall back to running.
    expect(normalizeWorkflowState('SOMETHING_NEW')).toBe('running')
    expect(normalizeWorkflowState(undefined)).toBe('running')
    expect(normalizeWorkflowState(null)).toBe('running')
  })
})

// ── accumulateWorkflowProgress ──

describe('accumulateWorkflowProgress', () => {
  it('skips ghost placeholder entries (no agentId)', () => {
    const { phases, agents } = emptyMaps()
    accumulateWorkflowProgress([
      { type: 'workflow_phase', index: 1, title: 'Fan out' },
      { type: 'workflow_agent', index: 1, label: 'bugs', state: 'start' }, // ghost — no agentId
      { type: 'workflow_agent', index: 1, label: 'bugs', agentId: 'a-bugs', state: 'start' },
    ], phases, agents)
    expect(agents.size).toBe(1)
    expect(agents.get('a-bugs')!.label).toBe('bugs')
    expect(phases.size).toBe(1)
  })

  it('merges by agentId across snapshots without clobbering known fields', () => {
    const { phases, agents } = emptyMaps()
    // Snapshot 1 — start, with promptPreview.
    accumulateWorkflowProgress([
      { type: 'workflow_agent', index: 1, label: 'bugs', phaseIndex: 1, agentId: 'a-bugs', model: 'm', state: 'start', promptPreview: 'Review bugs' },
    ], phases, agents)
    // Snapshot 2 — done, with resultPreview but OMITTING promptPreview/model.
    accumulateWorkflowProgress([
      { type: 'workflow_agent', index: 1, agentId: 'a-bugs', state: 'done', tokens: 1200, durationMs: 1800, resultPreview: 'Found 2 bugs' },
    ], phases, agents)

    const a = agents.get('a-bugs')!
    expect(a.status).toBe('completed')
    expect(a.resultPreview).toBe('Found 2 bugs')
    expect(a.tokens).toBe(1200)
    expect(a.durationMs).toBe(1800)
    // Merge-don't-clobber: prompt + model survive the sparse second snapshot.
    expect(a.promptPreview).toBe('Review bugs')
    expect(a.model).toBe('m')
  })

  it('reconstructs the full agent union across a phase boundary', () => {
    const { phases, agents } = emptyMaps()
    // Phase 1: two readers active.
    accumulateWorkflowProgress([
      { type: 'workflow_phase', index: 1, title: 'Read' },
      { type: 'workflow_phase', index: 2, title: 'Synthesize' },
      { type: 'workflow_agent', index: 1, agentId: 'r1', phaseIndex: 1, state: 'start' },
      { type: 'workflow_agent', index: 2, agentId: 'r2', phaseIndex: 1, state: 'start' },
    ], phases, agents)
    // Phase 2 snapshot: readers done + a NEW synthesize agent. CLI only sends
    // currently-relevant ones, but the union must keep all three.
    accumulateWorkflowProgress([
      { type: 'workflow_agent', index: 1, agentId: 'r1', state: 'done', resultPreview: 'A' },
      { type: 'workflow_agent', index: 2, agentId: 'r2', state: 'done', resultPreview: 'B' },
      { type: 'workflow_agent', index: 3, agentId: 'syn', phaseIndex: 2, state: 'start' },
    ], phases, agents)

    expect(agents.size).toBe(3)
    expect(sortedPhases(phases).map(p => p.title)).toEqual(['Read', 'Synthesize'])
    expect(sortedAgents(agents).map(a => a.agentId)).toEqual(['r1', 'r2', 'syn'])
    expect(agents.get('syn')!.status).toBe('running')
  })

  it('pulls tokens from usage.total_tokens when tokens field absent', () => {
    const { phases, agents } = emptyMaps()
    accumulateWorkflowProgress([
      { type: 'workflow_agent', index: 1, agentId: 'a', state: 'done', usage: { total_tokens: 999 } },
    ], phases, agents)
    expect(agents.get('a')!.tokens).toBe(999)
  })

  it('preserves prior status when a later snapshot omits state (no completed→running downgrade)', () => {
    const { phases, agents } = emptyMaps()
    accumulateWorkflowProgress([
      { type: 'workflow_agent', index: 1, agentId: 'a', state: 'done', resultPreview: 'R' },
    ], phases, agents)
    expect(agents.get('a')!.status).toBe('completed')
    // A sparse re-emit (metrics-only, agentId present but no `state`) must NOT reset
    // the agent back to the 'running' default.
    accumulateWorkflowProgress([
      { type: 'workflow_agent', index: 1, agentId: 'a', tokens: 500 },
    ], phases, agents)
    expect(agents.get('a')!.status).toBe('completed')
    expect(agents.get('a')!.tokens).toBe(500)
  })
})

// ── reconstructWorkflowProgress (manifest reload) ──

describe('reconstructWorkflowProgress (on-disk manifest)', () => {
  const cwd = '/Users/test/wf-reload'
  const sid = 'reload-sid-1'

  async function writeManifest(runId: string, manifest: Record<string, unknown>) {
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd), sid, 'workflows')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, `${runId}.json`), JSON.stringify(manifest))
  }

  it('returns null when the session never ran a workflow', async () => {
    const out = await reconstructWorkflowProgress('no-such-sid', cwd)
    expect(out).toBeNull()
  })

  it('reconstructs the panel payload from a completed-run manifest', async () => {
    await writeManifest('wf_run-1', {
      runId: 'wf_run-1',
      workflowName: 'read-six-synthesize',
      summary: 'Read files then synthesize',
      script: "export const meta = { name: 'read-six-synthesize' }",
      status: 'completed',
      totalTokens: 394557,
      startTime: 1000,
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Read' },
        { type: 'workflow_phase', index: 2, title: 'Synthesize' },
        { type: 'workflow_agent', index: 1, label: 'read:a', phaseIndex: 1, agentId: 'a1', model: 'global.anthropic.claude-opus-4-8[1m]', state: 'done', tokens: 5000, durationMs: 1700, promptPreview: 'Read a', resultPreview: 'summary a' },
        { type: 'workflow_agent', index: 2, label: 'synthesize', phaseIndex: 2, agentId: 'a2', state: 'done', tokens: 4000, durationMs: 1900, resultPreview: 'final' },
      ],
    })

    const out = await reconstructWorkflowProgress(sid, cwd)
    expect(out).not.toBeNull()
    expect(out!.workflowName).toBe('read-six-synthesize')
    expect(out!.workflowDescription).toBe('Read files then synthesize')
    expect(out!.scriptSource).toContain('read-six-synthesize')
    // Finished run → inFlight is 0; counts are display-only.
    expect(out!.inFlight).toBe(0)
    expect(out!.phases?.length).toBe(2)
    expect(out!.agents?.length).toBe(2)
    const a1 = out!.agents!.find(a => a.agentId === 'a1')!
    expect(a1.status).toBe('completed')
    expect(a1.resultPreview).toBe('summary a')
    expect(a1.promptPreview).toBe('Read a')
  })

  it('picks the most-recent run when multiple manifests exist', async () => {
    await writeManifest('wf_old', {
      runId: 'wf_old', workflowName: 'old-run', startTime: 100,
      workflowProgress: [{ type: 'workflow_agent', index: 1, agentId: 'old', state: 'done' }],
    })
    await writeManifest('wf_new', {
      runId: 'wf_new', workflowName: 'new-run', startTime: 999,
      workflowProgress: [
        { type: 'workflow_agent', index: 1, agentId: 'n1', state: 'done' },
        { type: 'workflow_agent', index: 2, agentId: 'n2', state: 'done' },
      ],
    })

    const out = await reconstructWorkflowProgress(sid, cwd)
    expect(out!.workflowName).toBe('new-run')
    expect(out!.agents?.length).toBe(2)
  })

  it('breaks a startTime tie deterministically by runId (not FS order)', async () => {
    // Two runs with the SAME startTime — selection must not depend on the
    // platform's directory-iteration order. Higher runId wins, deterministically.
    await writeManifest('wf_aaa', {
      runId: 'wf_aaa', workflowName: 'run-aaa', startTime: 500,
      workflowProgress: [{ type: 'workflow_agent', index: 1, agentId: 'x', state: 'done' }],
    })
    await writeManifest('wf_zzz', {
      runId: 'wf_zzz', workflowName: 'run-zzz', startTime: 500,
      workflowProgress: [{ type: 'workflow_agent', index: 1, agentId: 'y', state: 'done' }],
    })

    const out = await reconstructWorkflowProgress(sid, cwd)
    expect(out!.workflowName).toBe('run-zzz')
  })
})
